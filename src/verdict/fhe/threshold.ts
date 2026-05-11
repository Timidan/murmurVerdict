/**
 * Z3 — threshold-decrypt quorum coordinator.
 *
 * This file is the public boundary the resolver and routes import. It
 * contains ONLY pure helpers + type definitions; no DB writes, no
 * network. The mock-quorum implementation in `mock-quorum.ts` and the
 * DB write helpers in `decrypt-requests.ts` sit one layer down.
 *
 * Why this shape
 * --------------
 * docs/operator-blind-privacy-plan.md §3 names a 5-of-9 committee
 * with category caps (at least 2 non-agent AND at least 2 non-Murmur
 * seats producing shares). Real production swaps this single-process
 * mock for an off-process Zama KMS quorum, but the protocol contract
 * the resolver speaks must stay identical:
 *
 *   1. Daemon enqueues an `fhe_decrypt_requests` row with the canonical
 *      transcript_hash that `scoreEncrypted` already wrote on the
 *      score job.
 *   2. Each holder INDEPENDENTLY verifies request_hash == sha256(
 *      canonicalTranscriptBytes(...)) against current DB state. This
 *      is the splice-attack defense — a holder refuses to sign if the
 *      DB row's transcript_hash drifted between score-time and
 *      decrypt-time.
 *   3. Each holder signs (request_hash || partial_decrypt) with its
 *      ed25519 key (`public_identity` in fhe_key_holders). The
 *      signature is the transcript a third party can verify on
 *      /v1/calls/:id/fhe-transcript.
 *   4. `validateQuorum` checks the share set against the 5-of-9 policy
 *      with category caps before `aggregateShares` ever runs.
 *
 * Hard rules (plan §3, do NOT relax):
 *
 *   - The committee NEVER decrypts `encrypted_predicted_outcome`. The
 *     decrypt request body does not even reference the prediction
 *     ciphertext — only the score ciphertext hash.
 *   - Quorum policy is non-negotiable: 5 total, at least 2 non-agent,
 *     at least 2 non-Murmur. No public-decrypt fallback. No
 *     operator-decrypt fallback. If quorum can't be reached, the call
 *     stays pending forever.
 *   - The aggregate function in v0 is a structural mock: in real Zama
 *     KMS this is the lagrange-combine of partial decryption shares.
 *     We label the mock-quorum threshold_mode `"mock_quorum"` so Z5's
 *     prod gate can refuse it as not-production-ready.
 */

/**
 * Holder categories. Match the CHECK constraint in MIGRATION_026's
 * `fhe_key_holders.category` so a holder row is never persisted with
 * a category the TS quorum policy can't reason about.
 */
export type HolderCategory = "murmur" | "attester" | "agent" | "partner";

export interface HolderRecord {
  readonly holder_id: string;
  readonly category: HolderCategory;
  readonly display_name: string;
  /** ed25519 public key, lowercase hex (32 bytes → 64 chars). */
  readonly public_identity: string;
  readonly enabled: boolean;
}

/**
 * A single partial-decrypt contribution from one holder. The
 * `partial_decrypt` blob is provider-specific opaque bytes. In the
 * v0 mock-quorum implementation it is the full score bytes (since
 * the mock "encryption" is identity-ish); in real Zama KMS this
 * carries the holder's partial decryption share which only becomes a
 * plaintext score when combined with ≥ threshold other shares.
 */
export interface PartialDecryptShare {
  readonly holder_id: string;
  readonly category: HolderCategory;
  readonly partial_decrypt: Uint8Array;
  /** ed25519(request_hash || partial_decrypt), lowercase hex. */
  readonly share_signature: string;
}

/**
 * Arguments a holder receives when asked to sign a partial decrypt.
 * Note: `score_ciphertext` is the ONLY ciphertext field — there is
 * deliberately no `encrypted_predicted_outcome` here. The committee
 * physically cannot decrypt the prediction because they're never
 * handed it.
 */
export interface PartialDecryptRequest {
  readonly request_id: string;
  readonly call_id: string;
  readonly keyset_id: string;
  readonly score_ciphertext: Uint8Array;
  readonly score_ciphertext_hash: string;
  readonly transcript_hash: string;
  readonly resolved_outcome_hash: string;
}

/**
 * One key holder. The mock-quorum binds this to an in-process ed25519
 * key; a real (off-process) holder pool would implement this against
 * an HTTP endpoint plus an HSM-backed signer. The same interface is
 * the seam.
 */
export interface ThresholdHolder {
  readonly record: HolderRecord;
  producePartialDecrypt(
    req: PartialDecryptRequest,
  ): Promise<PartialDecryptShare>;
}

/** Quorum-policy literal (5-of-9 with category caps; plan §3). */
export interface QuorumPolicy {
  readonly threshold: number;
  readonly min_non_agent: number;
  readonly min_non_murmur: number;
}

export const DEFAULT_QUORUM_POLICY: QuorumPolicy = {
  threshold: 5,
  min_non_agent: 2,
  min_non_murmur: 2,
};

export type QuorumValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a share set against the 5-of-9 + category-caps policy.
 * Pure function — no DB, no clock. Caller is responsible for ensuring
 * the shares all come from `enabled` holders that match the request's
 * ciphertext hash (verifyShare does the per-share crypto check).
 *
 * Duplicate-holder shares are NOT counted as separate; the caller
 * dedupes by holder_id (the DB also enforces this via the
 * UNIQUE(request_id, holder_id) constraint).
 */
export function validateQuorum(
  shares: readonly PartialDecryptShare[],
  policy: QuorumPolicy = DEFAULT_QUORUM_POLICY,
): QuorumValidationResult {
  const byHolder = new Map<string, PartialDecryptShare>();
  for (const s of shares) byHolder.set(s.holder_id, s);
  const unique = [...byHolder.values()];
  if (unique.length < policy.threshold) {
    return {
      ok: false,
      reason: `need ${policy.threshold} shares, have ${unique.length}`,
    };
  }
  const nonAgent = unique.filter((s) => s.category !== "agent").length;
  if (nonAgent < policy.min_non_agent) {
    return {
      ok: false,
      reason: `need ${policy.min_non_agent} non-agent shares, have ${nonAgent}`,
    };
  }
  const nonMurmur = unique.filter((s) => s.category !== "murmur").length;
  if (nonMurmur < policy.min_non_murmur) {
    return {
      ok: false,
      reason: `need ${policy.min_non_murmur} non-murmur shares, have ${nonMurmur}`,
    };
  }
  return { ok: true };
}

import { createPublicKey, verify as edVerify } from "node:crypto";

/**
 * Per-share signature verification. Independent of quorum membership
 * — verifyShare returns true iff the holder's stated pubkey signed
 * (request_hash || partial_decrypt). Caller still needs to call
 * validateQuorum afterwards.
 *
 * `expected_request_hash` must be the same value used by the holder
 * when signing. The mock-quorum's request_hash is sha256(
 * canonicalTranscriptBytes(...)) — same bytes the score job already
 * persisted — so a stale-transcript splice attack is caught here, not
 * at the (later) aggregate step.
 */
export function verifyShare(
  share: PartialDecryptShare,
  publicIdentityHex: string,
  expected_request_hash: string,
): boolean {
  let pub;
  try {
    pub = createPublicKey({
      key: Buffer.concat([
        // SPKI prefix for raw ed25519 pubkeys: 302a300506032b6570032100
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicIdentityHex, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
  } catch {
    return false;
  }
  let sig;
  try {
    sig = Buffer.from(share.share_signature, "hex");
  } catch {
    return false;
  }
  const msg = Buffer.concat([
    Buffer.from(expected_request_hash, "hex"),
    Buffer.from(share.partial_decrypt),
  ]);
  try {
    return edVerify(null, msg, pub, sig);
  } catch {
    return false;
  }
}

/**
 * Aggregate a verified, quorum-valid share set into the final bounded
 * score in [0, 1].
 *
 * v0 mock-quorum: the mock-provider score blob is JSON `{v:1,
 * kind:"score", score_x1e9}` — the partial_decrypt bytes from EACH
 * holder are identical full score bytes. Aggregation is a sanity
 * check (all partial decrypts must agree on the score). Real Zama KMS
 * threshold lagrange-combines opaque polynomial shares into the
 * plaintext, and the function signature stays the same.
 *
 * Caller MUST have validated quorum + per-share signatures before
 * calling this; aggregateShares is the FINAL step and assumes its
 * inputs already passed both gates.
 */
export function aggregateShares(
  shares: readonly PartialDecryptShare[],
): { score: number } {
  if (shares.length === 0) {
    throw new Error("aggregateShares: cannot aggregate empty share set");
  }
  // Mock-quorum invariant: every holder's partial bytes are the same
  // mock-provider score blob. Decode the first and assert the rest
  // agree — if they don't, a holder lied about what they signed, and
  // the dispute path needs to see which holder drifted.
  const decoded = decodeMockScoreBlob(shares[0]!.partial_decrypt);
  for (let i = 1; i < shares.length; i++) {
    const other = decodeMockScoreBlob(shares[i]!.partial_decrypt);
    if (other.score_x1e9 !== decoded.score_x1e9) {
      throw new Error(
        `aggregateShares: share[${i}] from holder=${shares[i]!.holder_id} disagrees on score (got ${other.score_x1e9}, first was ${decoded.score_x1e9})`,
      );
    }
  }
  const score = Math.max(0, Math.min(1, decoded.score_x1e9 / 1_000_000_000));
  return { score };
}

interface MockScoreBlob {
  readonly v: 1;
  readonly kind: "score";
  readonly score_x1e9: number;
}

function decodeMockScoreBlob(bytes: Uint8Array): MockScoreBlob {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (err) {
    throw new Error(
      `partial_decrypt is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as MockScoreBlob).v !== 1 ||
    (raw as MockScoreBlob).kind !== "score" ||
    typeof (raw as MockScoreBlob).score_x1e9 !== "number"
  ) {
    throw new Error(
      "partial_decrypt is not a v1 score blob; quorum aggregator expects the mock score-blob shape",
    );
  }
  return raw as MockScoreBlob;
}
