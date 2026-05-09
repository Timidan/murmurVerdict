import type Database from "better-sqlite3";
import {
  AcceptanceReceiptPayloadSchema,
  ResolutionReceiptPayloadSchema,
} from "./schema.js";
import { canonicalHash, canonicalize } from "../receipts/canonical.js";
import {
  computeSignedReturn,
  outcomeFromSignedReturn,
  scoreCall,
  scoreOutcomeVector,
} from "./scoring.js";
import { parseAndRebuildPreimageByDomain } from "./commit-preimage.js";
import { marketsRepo } from "./db.js";
import type { AssetId, HorizonHours, Side } from "./schema.js";
import {
  CommitmentSchema,
  deserializeOutcome,
  type Commitment,
  type Outcome as UniversalOutcome,
} from "./markets-core.js";

// ─── /v1/calls/:id/verify ─────────────────────────────────────────────────────
//
// Independent recomputation of the receipt chain from the canonical JSON
// stored in `receipts.canonical_json`. Rebuilds:
//   - acceptance_receipt_hash   (canonical hash of the stored payload)
//   - resolution_receipt_hash   (same)
//   - signed_return             (from t0/p0/p1)
//   - outcome                   (from signed_return, void band, scoring formula)
//   - call_score                (from horizon, confidence, expected vol, signed return)
// and compares each independently-recomputed value against the stored value.
//
// PASS = every dimension matches. FAIL = any dimension mismatches, with detail.
// A third party with the canonical JSON can run the same checks themselves.

export interface VerifyResult {
  call_id: string;
  passes: boolean;
  checks: VerifyCheck[];
  /** Frozen scoring/schema versions used during recomputation. */
  scoring_version: number;
  schema_version: number;
  /** When the verification ran. */
  verified_at: string;
}

export interface VerifyCheck {
  name:
    | "acceptance_receipt_hash"
    | "resolution_receipt_hash"
    | "signed_return"
    | "outcome"
    | "call_score"
    // P2 v2 semantic checks (Codex H3) ────────────────────────────
    /** v2 acceptance: receipt's commit.hash matches submissions.commit_hash. */
    | "commit_hash_binding"
    /** v2: revealed plaintext (in call_reveals) hashes to receipt commit.hash. */
    | "reveal_canonical_hash"
    /** v2: receipt's fallback.encrypted_body_hash matches the daemon-stored
     *  ciphertext hash on call_private_envelopes. */
    | "envelope_ciphertext_hash"
    /** v2: receipt's drand.ciphertext_hash matches the stored drand ciphertext. */
    | "drand_ciphertext_hash"
    /** resolution receipt points at the stored acceptance receipt and previous_hash. */
    | "resolution_acceptance_link"
    /** v2 resolution commit_hash repeats the v2 acceptance commit hash. */
    | "resolution_commit_hash_binding"
    /** v2 resolution wallet/chain repeats the v2 acceptance wallet binding. */
    | "resolution_wallet_binding"
    /** v2 resolution reveal block matches the materialized call_reveals row. */
    | "resolution_reveal_subject";
  status: "match" | "mismatch" | "skipped";
  stored: string | number | boolean | null;
  recomputed: string | number | boolean | null;
  /** Optional note for skipped/missing data. */
  note?: string;
}

export class VerifyError extends Error {
  constructor(message: string, public readonly code: "not_found" | "malformed_data") {
    super(message);
    this.name = "VerifyError";
  }
}

export function verifyReceiptChain(
  db: Database.Database,
  call_id: string,
  now: () => Date = () => new Date(),
): VerifyResult {
  const checks: VerifyCheck[] = [];

  const subRow = db
    .prepare(
      `SELECT s.*, p.murmur_score, p.murmur_playbook, p.risk_flags_json,
              p.data_freshness_seconds, p.market_regime,
              op.primary_feed, op.fallback_feed, op.primary_max_staleness_sec,
              op.fallback_max_staleness_sec, op.t0_grace_seconds, op.t0_extended_grace_seconds
       FROM submissions s
       JOIN preflights p ON p.call_id = s.call_id
       JOIN oracle_policies op ON op.call_id = s.call_id
       WHERE s.call_id = ?`,
    )
    .get(call_id) as Record<string, unknown> | undefined;
  if (!subRow) throw new VerifyError("call not found", "not_found");

  const acceptanceRow = db
    .prepare(
      `SELECT receipt_hash, canonical_json
       FROM receipts WHERE call_id = ? AND kind = 'acceptance'`,
    )
    .get(call_id) as
    | { receipt_hash: string; canonical_json: string }
    | undefined;
  if (!acceptanceRow) throw new VerifyError("acceptance receipt missing", "malformed_data");

  // ── Acceptance receipt hash ──
  let acceptancePayload: unknown;
  try {
    acceptancePayload = JSON.parse(acceptanceRow.canonical_json);
  } catch {
    throw new VerifyError("acceptance canonical_json unparseable", "malformed_data");
  }
  const parsedAcceptance = AcceptanceReceiptPayloadSchema.safeParse(acceptancePayload);
  if (!parsedAcceptance.success) {
    throw new VerifyError("acceptance payload failed schema", "malformed_data");
  }
  const recomputedAcceptanceHash = canonicalHash(parsedAcceptance.data);
  checks.push({
    name: "acceptance_receipt_hash",
    status: recomputedAcceptanceHash === acceptanceRow.receipt_hash ? "match" : "mismatch",
    stored: acceptanceRow.receipt_hash,
    recomputed: recomputedAcceptanceHash,
  });

  // ── v2 semantic checks (Codex Phase B H3) ──
  // For committed-mode acceptances: the receipt's commit.hash MUST match
  // the daemon's stored submissions.commit_hash. This catches a tampered
  // receipt that re-canonicalizes to a valid hash but disagrees with the
  // DB about WHAT was committed. For v1 (legacy_plaintext) the schema
  // doesn't have this binding so the check is skipped.
  if (parsedAcceptance.data.schema_version === 2) {
    const v2 = parsedAcceptance.data;
    const commitFromDb = (subRow.commit_hash as string | null) ?? null;
    checks.push({
      name: "commit_hash_binding",
      status:
        commitFromDb &&
        commitFromDb.toLowerCase() === v2.commit.hash.toLowerCase()
          ? "match"
          : "mismatch",
      stored: commitFromDb,
      recomputed: v2.commit.hash,
    });

    // Receipt's fallback.encrypted_body_hash binds to the on-disk
    // ciphertext bytes. Re-hash from the call_private_envelopes row.
    if (v2.fallback) {
      const envBodyHashRow = db
        .prepare(
          "SELECT encrypted_body_hash, drand_ciphertext_hash FROM call_private_envelopes WHERE call_id = ?",
        )
        .get(call_id) as
        | { encrypted_body_hash: string | null; drand_ciphertext_hash: string | null }
        | undefined;
      checks.push({
        name: "envelope_ciphertext_hash",
        status:
          envBodyHashRow?.encrypted_body_hash &&
          envBodyHashRow.encrypted_body_hash.toLowerCase() ===
            v2.fallback.encrypted_body_hash.toLowerCase()
            ? "match"
            : "mismatch",
        stored: envBodyHashRow?.encrypted_body_hash ?? null,
        recomputed: v2.fallback.encrypted_body_hash,
      });

      if (v2.drand) {
        checks.push({
          name: "drand_ciphertext_hash",
          status:
            envBodyHashRow?.drand_ciphertext_hash &&
            envBodyHashRow.drand_ciphertext_hash.toLowerCase() ===
              v2.drand.ciphertext_hash.toLowerCase()
              ? "match"
              : "mismatch",
          stored: envBodyHashRow?.drand_ciphertext_hash ?? null,
          recomputed: v2.drand.ciphertext_hash,
        });
      }
    }

    // Reveal hash: when the agent (or daemon fallback) revealed the
    // preimage, the call_reveals row carries the recomputed hash. It
    // MUST match the receipt's commit.hash. Skipped when the call
    // hasn't been revealed yet.
    //
    // P3 Phase 2a hardening (Codex audit): re-parse + re-validate +
    // re-hash from the stored canonical JSON. The pre-fix check trusted
    // the row's commit_preimage_hash column at face value — a tamper
    // path that mutates commit_preimage_json without updating the hash
    // would slip through. The stricter check is fail-closed:
    //   1. Stored hash must equal receipt.commit.hash
    //   2. Recomputed hash (from canonical JSON) must equal receipt.commit.hash
    // Either mismatch flags the check.
    const revealRow = db
      .prepare(
        "SELECT commit_preimage_hash, commit_preimage_json, reveal_hash_valid, revealed_via FROM call_reveals WHERE call_id = ?",
      )
      .get(call_id) as
      | {
          commit_preimage_hash: string | null;
          commit_preimage_json: string | null;
          reveal_hash_valid: number;
          revealed_via: string;
        }
      | undefined;
    if (revealRow?.commit_preimage_hash) {
      const expected = v2.commit.hash.toLowerCase();
      const storedHashOk =
        revealRow.commit_preimage_hash.toLowerCase() === expected &&
        revealRow.reveal_hash_valid === 1;
      let recomputedHashOk = false;
      let recomputedHash: string | null = null;
      if (revealRow.commit_preimage_json) {
        const validated = parseAndRebuildPreimageByDomain(
          revealRow.commit_preimage_json,
        );
        if (validated) {
          recomputedHash = validated.hash;
          recomputedHashOk = validated.hash.toLowerCase() === expected;
        }
      }
      checks.push({
        name: "reveal_canonical_hash",
        status:
          storedHashOk && recomputedHashOk ? "match" : "mismatch",
        stored: revealRow.commit_preimage_hash,
        recomputed: recomputedHash,
        note: `revealed_via=${revealRow.revealed_via}; storedHashOk=${storedHashOk} recomputedHashOk=${recomputedHashOk}`,
      });
    } else {
      checks.push({
        name: "reveal_canonical_hash",
        status: "skipped",
        stored: v2.commit.hash,
        recomputed: null,
        note: "not yet revealed",
      });
    }
  }

  // ── Resolution side (skip if unresolved) ──
  const resolutionRow = db
    .prepare(
      `SELECT r.outcome, r.signed_return, r.call_score, r.t1, r.p1, r.t1_feed, r.resolved_at,
              rec.receipt_hash, rec.canonical_json, rec.previous_hash
       FROM t1_resolutions r
       LEFT JOIN receipts rec ON rec.call_id = r.call_id AND rec.kind IN ('resolution','re_resolution')
       WHERE r.call_id = ?
       ORDER BY rec.created_at DESC
       LIMIT 1`,
    )
    .get(call_id) as
    | {
        outcome: string;
        signed_return: string;
        call_score: number | null;
        t1: string;
        p1: string;
        t1_feed: string;
        resolved_at: string;
        receipt_hash: string | null;
        canonical_json: string | null;
        previous_hash: string | null;
      }
    | undefined;

  if (!resolutionRow || !resolutionRow.canonical_json || !resolutionRow.receipt_hash) {
    checks.push({
      name: "resolution_receipt_hash",
      status: "skipped",
      stored: null,
      recomputed: null,
      note: resolutionRow ? "resolution row exists but no receipt yet" : "not yet resolved",
    });
    checks.push({
      name: "signed_return",
      status: "skipped",
      stored: null,
      recomputed: null,
      note: "not yet resolved",
    });
    checks.push({
      name: "outcome",
      status: "skipped",
      stored: null,
      recomputed: null,
      note: "not yet resolved",
    });
    checks.push({
      name: "call_score",
      status: "skipped",
      stored: null,
      recomputed: null,
      note: "not yet resolved",
    });
  } else {
    let resolutionPayload: unknown;
    try {
      resolutionPayload = JSON.parse(resolutionRow.canonical_json);
    } catch {
      throw new VerifyError("resolution canonical_json unparseable", "malformed_data");
    }
    const parsedResolution = ResolutionReceiptPayloadSchema.safeParse(resolutionPayload);
    if (!parsedResolution.success) {
      throw new VerifyError("resolution payload failed schema", "malformed_data");
    }
    const resolutionData = parsedResolution.data;
    const recomputedResolutionHash = canonicalHash(parsedResolution.data);
    checks.push({
      name: "resolution_receipt_hash",
      status: recomputedResolutionHash === resolutionRow.receipt_hash ? "match" : "mismatch",
      stored: resolutionRow.receipt_hash,
      recomputed: recomputedResolutionHash,
    });

    const payloadAcceptanceHash = resolutionData.acceptance_receipt_hash;
    const previousHash = resolutionRow.previous_hash;
    const acceptanceLinkOk =
      payloadAcceptanceHash.toLowerCase() === acceptanceRow.receipt_hash.toLowerCase() &&
      previousHash?.toLowerCase() === acceptanceRow.receipt_hash.toLowerCase();
    checks.push({
      name: "resolution_acceptance_link",
      status: acceptanceLinkOk ? "match" : "mismatch",
      stored: previousHash ?? null,
      recomputed: payloadAcceptanceHash,
      note: `acceptance=${acceptanceRow.receipt_hash}`,
    });

    // P4 Item 4: subjectForScoring also carries replay anchors when the
    // receipt has them. void_band is parsed off plaintext_subject (or
    // re-pulled from market_config_history if the receipt didn't stamp
    // it directly — happens for v2 receipts emitted before Item 4).
    //
    // Codex follow-up F3: also enrich for v1 (legacy_plaintext) receipts
    // when the submission row has a stamped market_id+market_config_version.
    // Without this, an operator who runs bumpConfig and then verifies a
    // v1 benchmark call would see a verify mismatch (global VOID_BAND
    // boundary, not the call's stamped one). This pulls the historical
    // snapshot for both v1 and v2 unconditionally as the baseline; v2
    // receipts can still override with carried fields below.
    const submissionMarketId = subRow.market_id as string | null;
    const submissionMarketVersion = subRow.market_config_version as
      | number
      | null;
    const submissionHorizonSeconds = subRow.horizon_seconds as number | null;
    let baselineHorizonSeconds: number | undefined;
    let baselineVoidBand: number | undefined;
    if (
      submissionMarketId !== null &&
      typeof submissionMarketVersion === "number"
    ) {
      const histSnapshot = marketsRepo.getConfigAt(
        db,
        submissionMarketId,
        submissionMarketVersion,
      );
      if (histSnapshot) {
        baselineHorizonSeconds = histSnapshot.horizon_seconds;
        baselineVoidBand = Number(histSnapshot.void_band);
      }
    }
    if (baselineHorizonSeconds === undefined && submissionHorizonSeconds) {
      // Fallback: stamped row but missing history (shouldn't happen post
      // migration 012). Use the row's own horizon_seconds; void_band
      // stays undefined → outcomeFromSignedReturn uses global VOID_BAND.
      baselineHorizonSeconds = submissionHorizonSeconds;
    }
    let subjectForScoring: {
      side: Side;
      asset_id: AssetId;
      horizon_hours: HorizonHours;
      confidence: number;
      horizon_seconds?: number;
      void_band?: number;
    } = {
      side: subRow.side as Side,
      asset_id: subRow.asset_id as AssetId,
      horizon_hours: subRow.horizon_hours as HorizonHours,
      confidence: subRow.confidence as number,
      ...(baselineHorizonSeconds !== undefined
        ? { horizon_seconds: baselineHorizonSeconds }
        : {}),
      ...(baselineVoidBand !== undefined
        ? { void_band: baselineVoidBand }
        : {}),
    };

    if (resolutionData.schema_version === 2) {
      if (parsedAcceptance.data.schema_version !== 2) {
        checks.push({
          name: "resolution_commit_hash_binding",
          status: "mismatch",
          stored: null,
          recomputed: resolutionData.commit_hash,
          note: "v2 resolution references a non-v2 acceptance receipt",
        });
      } else {
        checks.push({
          name: "resolution_commit_hash_binding",
          status:
            resolutionData.commit_hash.toLowerCase() ===
            parsedAcceptance.data.commit.hash.toLowerCase()
              ? "match"
              : "mismatch",
          stored: parsedAcceptance.data.commit.hash,
          recomputed: resolutionData.commit_hash,
        });
        const walletBindingOk =
          resolutionData.agent_wallet === parsedAcceptance.data.agent_wallet &&
          resolutionData.chain_id === parsedAcceptance.data.chain_id;
        checks.push({
          name: "resolution_wallet_binding",
          status: walletBindingOk ? "match" : "mismatch",
          stored: `${parsedAcceptance.data.agent_wallet}:${parsedAcceptance.data.chain_id}`,
          recomputed: `${resolutionData.agent_wallet}:${resolutionData.chain_id}`,
        });
      }

      const plaintextSubject = resolutionData.reveal.plaintext_subject;
      // P4 Item 4: when the v2 receipt carries the additive market
      // anchors, use them. Otherwise fall back to market_config_history
      // via the carried market_id+market_config_version. NEVER read
      // the live markets row — a post-acceptance bumpConfig must not
      // rewrite a verifier's outcome.
      let carriedHorizonSeconds: number | undefined;
      let carriedVoidBand: number | undefined;
      if (plaintextSubject.market_id && plaintextSubject.market_config_version) {
        carriedHorizonSeconds =
          plaintextSubject.horizon_seconds ?? undefined;
        carriedVoidBand = plaintextSubject.void_band
          ? Number(plaintextSubject.void_band)
          : undefined;
        if (carriedHorizonSeconds === undefined || carriedVoidBand === undefined) {
          const snapshot = marketsRepo.getConfigAt(
            db,
            plaintextSubject.market_id,
            plaintextSubject.market_config_version,
          );
          if (snapshot) {
            if (carriedHorizonSeconds === undefined) {
              carriedHorizonSeconds = snapshot.horizon_seconds;
            }
            if (carriedVoidBand === undefined) {
              carriedVoidBand = Number(snapshot.void_band);
            }
          }
        }
      }
      subjectForScoring = {
        side: plaintextSubject.side as Side,
        asset_id: plaintextSubject.asset_id as AssetId,
        horizon_hours: plaintextSubject.horizon_hours as HorizonHours,
        confidence: plaintextSubject.confidence,
        ...(carriedHorizonSeconds !== undefined
          ? { horizon_seconds: carriedHorizonSeconds }
          : {}),
        ...(carriedVoidBand !== undefined
          ? { void_band: carriedVoidBand }
          : {}),
      };

      const revealRow = db
        .prepare(
          `SELECT side, asset_id, horizon_hours, confidence,
                  agent_wallet, chain_id, reveal_hash_valid
           FROM call_reveals WHERE call_id = ?`,
        )
        .get(call_id) as
        | {
            side: string;
            asset_id: string;
            horizon_hours: number;
            confidence: number;
            agent_wallet: string | null;
            chain_id: string | null;
            reveal_hash_valid: number;
          }
        | undefined;
      const revealSubjectOk =
        !!revealRow &&
        revealRow.reveal_hash_valid === 1 &&
        resolutionData.reveal.reveal_hash_valid === true &&
        revealRow.side === resolutionData.reveal.plaintext_subject.side &&
        revealRow.asset_id === resolutionData.reveal.plaintext_subject.asset_id &&
        revealRow.horizon_hours === resolutionData.reveal.plaintext_subject.horizon_hours &&
        revealRow.confidence === resolutionData.reveal.plaintext_subject.confidence &&
        revealRow.agent_wallet === resolutionData.agent_wallet &&
        revealRow.chain_id === resolutionData.chain_id;
      checks.push({
        name: "resolution_reveal_subject",
        status: revealSubjectOk ? "match" : "mismatch",
        stored: revealRow
          ? `${revealRow.side}:${revealRow.asset_id}:${revealRow.horizon_hours}:${revealRow.confidence}`
          : null,
        recomputed: `${resolutionData.reveal.plaintext_subject.side}:${resolutionData.reveal.plaintext_subject.asset_id}:${resolutionData.reveal.plaintext_subject.horizon_hours}:${resolutionData.reveal.plaintext_subject.confidence}`,
        note: `receipt_reveal_hash_valid=${resolutionData.reveal.reveal_hash_valid}`,
      });
    } else if (parsedAcceptance.data.schema_version === 2) {
      checks.push({
        name: "resolution_commit_hash_binding",
        status: "mismatch",
        stored: parsedAcceptance.data.commit.hash,
        recomputed: null,
        note: "v2 acceptance resolved with non-v2 resolution receipt",
      });
    }

    // Pull t0 anchor for signed-return recomputation.
    const t0Row = db
      .prepare("SELECT t0, p0 FROM t0_anchors WHERE call_id = ?")
      .get(call_id) as { t0: string; p0: string } | undefined;

    if (
      t0Row &&
      resolutionRow.outcome !== "oracle_unavailable" &&
      Number(resolutionRow.p1) > 0
    ) {
      const r = computeSignedReturn(
        subjectForScoring.side,
        t0Row.p0,
        resolutionRow.p1,
      );
      const recomputedSignedReturn = r.toFixed(8);
      checks.push({
        name: "signed_return",
        status: recomputedSignedReturn === resolutionRow.signed_return ? "match" : "mismatch",
        stored: resolutionRow.signed_return,
        recomputed: recomputedSignedReturn,
      });

      // P4 Item 4: outcome boundary uses the receipt-carried void_band
      // (when present) so a post-acceptance bumpConfig cannot rewrite
      // a verifier's outcome. Falls back to global VOID_BAND when the
      // receipt is pre-Item-4 (no carried void_band). Same idea for
      // horizon_seconds → scoreCall.
      const recomputedOutcome = outcomeFromSignedReturn(
        r,
        subjectForScoring.void_band,
      );
      checks.push({
        name: "outcome",
        status: recomputedOutcome === resolutionRow.outcome ? "match" : "mismatch",
        stored: resolutionRow.outcome,
        recomputed: recomputedOutcome,
      });

      const recomputedScore = scoreCall({
        asset_id: subjectForScoring.asset_id,
        horizon_hours: subjectForScoring.horizon_hours,
        confidence: subjectForScoring.confidence,
        signed_return: r,
        outcome: recomputedOutcome,
        ...(subjectForScoring.horizon_seconds !== undefined
          ? { horizon_seconds: subjectForScoring.horizon_seconds }
          : {}),
      }).call_score;
      const stored = resolutionRow.call_score;
      const matchesScore =
        stored === null && recomputedScore === null
          ? true
          : stored !== null &&
            recomputedScore !== null &&
            Math.abs(stored - recomputedScore) < 1e-9;
      checks.push({
        name: "call_score",
        status: matchesScore ? "match" : "mismatch",
        stored,
        recomputed: recomputedScore,
      });
    } else {
      // oracle_unavailable / placeholder data — skip semantic checks
      checks.push({
        name: "signed_return",
        status: "skipped",
        stored: resolutionRow.signed_return,
        recomputed: null,
        note: "oracle_unavailable or missing t0 anchor",
      });
      checks.push({
        name: "outcome",
        status: "skipped",
        stored: resolutionRow.outcome,
        recomputed: null,
        note: "oracle_unavailable or missing t0 anchor",
      });
      checks.push({
        name: "call_score",
        status: "skipped",
        stored: resolutionRow.call_score,
        recomputed: null,
        note: "oracle_unavailable or missing t0 anchor",
      });
    }
  }

  const passes = checks.every((c) => c.status !== "mismatch");
  return {
    call_id,
    passes,
    checks,
    scoring_version: 1,
    schema_version: 1,
    verified_at: now().toISOString().replace(/\.\d+Z$/, "Z"),
  };
}

// ─── Phase 5 — V2 universal payout-vector receipt verification ──────────────
//
// verifyReceiptChain (above) covers the legacy v1/v2 resolution receipts —
// canonicalize → recompute hash → recompute signed_return / outcome /
// call_score. The Phase 5 cutover writes a SIBLING universal-payout receipt
// (kind='resolution_v2') alongside the legacy one. verifyResolutionV2 is
// that receipt's canonical-replay verifier — accepts the receipt's
// canonical_json, parses the embedded Commitment + Outcome, recomputes
// scoreOutcomeVector, and asserts the receipt's call_score matches.
//
// Scope:
//   - Receipt-internal canonical-replay only. The chain check (previous_hash
//     binds back to the acceptance receipt) is the legacy verifier's
//     responsibility — Phase 6 will fold it back in.
//   - Schema: 'murmur-resolution-v2@1' produced by buildV2ResolutionReceipt.
//
// Phase 6 will surface this verifier on `GET /v1/calls/:id/verify` as an
// additive `v2_checks` block; for v0.2 it's internal-only and exercised by
// the Phase 5 smoke harness.

export interface VerifyResolutionV2Result {
  passes: boolean;
  checks: VerifyResolutionV2Check[];
}

export interface VerifyResolutionV2Check {
  name:
    | "canonical_hash"
    | "canonical_json_round_trip"
    | "schema"
    | "call_score";
  status: "match" | "mismatch" | "skipped";
  stored: string | number | boolean | null;
  recomputed: string | number | boolean | null;
  note?: string;
}

/**
 * Recompute and validate a v2 resolution receipt from its canonical JSON.
 * Returns `passes: true` iff every check is `'match'`.
 *
 * Checks:
 *   1. `canonical_json_round_trip` — re-canonicalizing the parsed payload
 *      reproduces the input bytes exactly.
 *   2. `canonical_hash` — recomputed hash matches `expected_hash` (when
 *      supplied) or is non-empty 0x-hex.
 *   3. `schema` — payload's `schema` field equals 'murmur-resolution-v2@1'.
 *   4. `call_score` — scoreOutcomeVector(commitment, outcome) recomputes
 *      the same call_score the receipt carries.
 *
 * The function is fail-open on parse errors only at the JSON level (JSON.parse
 * throw → returns a single 'canonical_json_round_trip' mismatch). Schema /
 * type errors propagate as ZodError — the caller is the v2 receipt
 * canonicalizer, which expects strict input.
 */
export function verifyResolutionV2(
  canonical_json: string,
  expected_hash?: string,
): VerifyResolutionV2Result {
  const checks: VerifyResolutionV2Check[] = [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(canonical_json) as Record<string, unknown>;
  } catch (err) {
    checks.push({
      name: "canonical_json_round_trip",
      status: "mismatch",
      stored: canonical_json.slice(0, 80),
      recomputed: null,
      note: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { passes: false, checks };
  }

  // Re-canonicalize; the bytes must match exactly. canonicalize is
  // deterministic over object keys, so any drift indicates tampering.
  const recanonical = canonicalize(parsed);
  checks.push({
    name: "canonical_json_round_trip",
    status: recanonical === canonical_json ? "match" : "mismatch",
    stored: canonical_json,
    recomputed: recanonical,
  });

  // Recomputed hash. When the caller supplied expected_hash, compare;
  // otherwise just confirm 0x-hex.
  const recomputedHash = canonicalHash(parsed);
  if (expected_hash !== undefined) {
    checks.push({
      name: "canonical_hash",
      status:
        recomputedHash.toLowerCase() === expected_hash.toLowerCase()
          ? "match"
          : "mismatch",
      stored: expected_hash,
      recomputed: recomputedHash,
    });
  } else {
    checks.push({
      name: "canonical_hash",
      status: recomputedHash.startsWith("0x") ? "match" : "mismatch",
      stored: null,
      recomputed: recomputedHash,
      note: "no expected_hash supplied; only checked 0x-prefix shape",
    });
  }

  // Schema check.
  const schema = parsed["schema"];
  checks.push({
    name: "schema",
    status: schema === "murmur-resolution-v2@1" ? "match" : "mismatch",
    stored: typeof schema === "string" ? schema : null,
    recomputed: "murmur-resolution-v2@1",
  });

  // Recompute call_score from the embedded Commitment + Outcome. The
  // commitment field is the wire shape (bigints stringified) — round-trip
  // through CommitmentSchema then BigInt(). Same for outcome via
  // deserializeOutcome.
  //
  // BUG FIX (codex review v2 P2 #3): commitment + outcome are REQUIRED by
  // buildV2ResolutionReceipt, so a receipt missing either field is malformed
  // — must hard-fail, not a soft `skipped`. Combined with the predicate fix
  // below (`passes` only iff every check is `'match'`), this stops the
  // verifier from rubber-stamping a tampered receipt where commitment or
  // outcome was stripped after the fact.
  const commitmentWire = parsed["commitment"];
  const outcomeWire = parsed["outcome"];
  if (commitmentWire === undefined || outcomeWire === undefined) {
    checks.push({
      name: "call_score",
      status: "mismatch",
      stored: null,
      recomputed: null,
      note: "commitment or outcome missing from receipt payload (required field)",
    });
  } else {
    const validatedCommitment = CommitmentSchema.parse(commitmentWire);
    const commitment: Commitment = {
      marketRef: validatedCommitment.marketRef,
      predictedOutcome: {
        kind: validatedCommitment.predictedOutcome.kind,
        payoutNumerators:
          validatedCommitment.predictedOutcome.payoutNumerators.map((s) =>
            BigInt(s),
          ),
        payoutDenominator: BigInt(
          validatedCommitment.predictedOutcome.payoutDenominator,
        ),
        ...(validatedCommitment.predictedOutcome.scalarValue !== undefined
          ? {
              scalarValue: BigInt(
                validatedCommitment.predictedOutcome.scalarValue,
              ),
            }
          : {}),
      },
      horizon: validatedCommitment.horizon,
      confidence: validatedCommitment.confidence,
    };
    const outcome: UniversalOutcome = deserializeOutcome(outcomeWire);
    const recomputed = scoreOutcomeVector(commitment, outcome);
    const stored = parsed["call_score"];
    const storedScore = typeof stored === "number" ? stored : null;
    const matches =
      storedScore === null && recomputed.call_score === null
        ? true
        : storedScore !== null &&
          recomputed.call_score !== null &&
          Math.abs(storedScore - recomputed.call_score) < 1e-9;
    checks.push({
      name: "call_score",
      status: matches ? "match" : "mismatch",
      stored: storedScore,
      recomputed: recomputed.call_score,
      note: `void=${recomputed.void}`,
    });
  }

  // BUG FIX (codex review v2 P2 #3): the previous predicate counted 'skipped'
  // as passing. After the missing-required-field fix above, verifyResolutionV2
  // no longer emits 'skipped' for any check — every check is either 'match' or
  // 'mismatch'. Tighten the predicate to require 'match' explicitly so a
  // future regression that re-introduces a 'skipped' branch can't silently
  // start rubber-stamping malformed receipts.
  const passes = checks.every((c) => c.status === "match");
  return { passes, checks };
}
