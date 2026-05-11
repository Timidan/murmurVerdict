/**
 * v0.3 commit preimage for operator-blind (`fhe_direct`) submissions.
 *
 * Sibling to `src/verdict/commit-preimage.ts` (v0.2 / v0.2.5). The
 * v0.2 preimage binds (side, asset_id, horizon_hours, confidence,
 * salt, t0) — i.e. the agent's plaintext prediction. The v0.3 preimage
 * deliberately does NOT contain the prediction: the prediction lives
 * inside `ciphertext_hash`, which the daemon never decrypts.
 *
 * Why the prediction MUST NOT enter the preimage
 * ----------------------------------------------
 * The commit_hash lands in `submissions.commit_hash` and is exposed via
 * /v1/calls/:id, /v1/feed/today, SSE events, webhooks, and the
 * leaderboard. If the preimage carried `side` / `confidence` /
 * `payoutNumerators`, then an operator (or a curious public consumer)
 * with knowledge of (call_id, agent_wallet, chain_id, keyset_id,
 * circuit_id, vector_len, payout_denominator, nonce, t0_anchor_ts,
 * accepted_at) could mount a dictionary attack:
 *
 *   for each candidate (side, confidence) in 2 × ~100 = 200 cells:
 *     rebuild canonical preimage
 *     keccak256(...)
 *     compare to commit_hash
 *
 * 200 hashes is trivial. Even adding `salt` only helps if the salt is
 * the agent's private secret — but `fhe_direct` already takes the
 * "agent encrypts client-side against the keyset's public key" stance,
 * so there is no shared salt. Binding to `ciphertext_hash` instead of
 * the plaintext closes the side-channel: the ciphertext_hash is the
 * sha256 of opaque encrypted bytes that the operator literally cannot
 * decrypt without the threshold committee (Z3).
 *
 * What the preimage DOES bind
 * ---------------------------
 *   call_id           — anti-replay across calls
 *   agent_id          — the agent making the call (UUID, not wallet —
 *                        casual-tier fhe_direct callers may not have
 *                        a chain wallet; binding to agent_id keeps the
 *                        preimage tier-agnostic)
 *   market_ref        — { protocol, sourceId }; pins the call to a
 *                        specific listed market so the same ciphertext
 *                        can't be reused on a different market
 *   keyset_id         — which public key the ciphertext was encrypted
 *                        against; rotation produces a new commit hash
 *   circuit_id        — which compiled circuit the resolver MUST use;
 *                        prevents an attacker swapping circuit handles
 *                        between submit and score (Z2)
 *   ciphertext_hash   — sha256(blob); binds the prediction without
 *                        revealing it
 *   vector_len        — how many payout buckets the agent committed to
 *                        (binary=2, categorical=N)
 *   payout_denominator — the fixed-point denominator under which the
 *                        encrypted numerators are interpreted
 *   nonce             — per-call agent-supplied entropy (32-byte hex);
 *                        keyset_id+nonce is unique-indexed in the DB
 *                        for replay protection
 *   t0_anchor_ts      — daemon-canonical t0 from the resolved market
 *                        row (same source as v0.2 t0)
 *   accepted_at       — daemon stamp; rounds out the time-bound
 *                        identity of this commit
 *
 * The schema string changes from `murmur-verdict-v0.2.5-commit@1` to
 * `murmur-verdict-v0.3-fhe-commit@1` so a verifier never confuses the
 * two byte-shapes; canonical JSON differs at byte 0.
 */
import { z } from "zod";
import { canonicalHash, canonicalize } from "../../receipts/canonical.js";

export const FHE_COMMIT_PREIMAGE_SCHEMA =
  "murmur-verdict-v0.3-fhe-commit@1" as const;
export const FHE_COMMIT_PREIMAGE_VERSION = 1 as const;
export const FHE_COMMIT_PREIMAGE_DOMAIN =
  "murmur-verdict-v0.3-fhe-commit" as const;

export interface FheMarketRef {
  /** e.g. 'native-price', 'polymarket-gamma' (Z1: native-price only). */
  readonly protocol: string;
  /** Adapter-side market identity. For native-price this is the market_id. */
  readonly sourceId: string;
}

export interface FheCommitPreimage {
  v: typeof FHE_COMMIT_PREIMAGE_VERSION;
  domain: typeof FHE_COMMIT_PREIMAGE_DOMAIN;
  call_id: string;
  agent_id: string;
  market_ref: FheMarketRef;
  keyset_id: string;
  circuit_id: string;
  /** sha256(ciphertext_blob), hex (no 0x prefix; 64 chars lowercase). */
  ciphertext_hash: string;
  /** Number of payout buckets (binary=2, categorical=N). */
  vector_len: number;
  /** BigInt serialized as decimal string for canonicalization. */
  payout_denominator: string;
  /** 32-byte hex (64 chars, lowercase). Agent-supplied per-call entropy. */
  nonce: string;
  /** Daemon-canonical t0 — ISO 8601 with no fractional seconds. */
  t0_anchor_ts: string;
  /** Daemon-canonical accepted_at — same format as t0_anchor_ts. */
  accepted_at: string;
}

/**
 * Build the canonical v0.3 fhe-commit preimage. Pure — no I/O, no
 * default-filling. Caller is responsible for ensuring nonce and
 * ciphertext_hash are already lowercase hex.
 */
export function buildFheCommitPreimage(
  input: Omit<FheCommitPreimage, "v" | "domain">,
): FheCommitPreimage {
  return {
    v: FHE_COMMIT_PREIMAGE_VERSION,
    domain: FHE_COMMIT_PREIMAGE_DOMAIN,
    call_id: input.call_id,
    agent_id: input.agent_id,
    market_ref: input.market_ref,
    keyset_id: input.keyset_id,
    circuit_id: input.circuit_id,
    ciphertext_hash: input.ciphertext_hash,
    vector_len: input.vector_len,
    payout_denominator: input.payout_denominator,
    nonce: input.nonce,
    t0_anchor_ts: input.t0_anchor_ts,
    accepted_at: input.accepted_at,
  };
}

/**
 * keccak256(canonical_json(preimage)) → 0x + 64 hex.
 *
 * Same canonicalization rules as the v0.2 preimage helper — sorted
 * keys at every depth, JSON.stringify primitives, bigint forbidden
 * (we pre-stringify `payout_denominator` for that reason).
 */
export function computeFheCommitHash(
  preimage: FheCommitPreimage,
): `0x${string}` {
  return canonicalHash(preimage);
}

/**
 * Build + hash in one call.
 */
export function buildFheCommit(
  input: Omit<FheCommitPreimage, "v" | "domain">,
): {
  preimage: FheCommitPreimage;
  preimage_canonical: string;
  commit_hash: `0x${string}`;
} {
  const preimage = buildFheCommitPreimage(input);
  const preimage_canonical = canonicalize(preimage);
  const commit_hash = computeFheCommitHash(preimage);
  return { preimage, preimage_canonical, commit_hash };
}

// ─── Strict runtime validation ─────────────────────────────────────────────────

const HEX_LOWER_64 = /^[0-9a-f]{64}$/;
const ISO_NO_FRAC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DECIMAL_BIGINT = /^[1-9][0-9]*$/;

export const FheCommitPreimageSchema = z
  .object({
    v: z.literal(FHE_COMMIT_PREIMAGE_VERSION),
    domain: z.literal(FHE_COMMIT_PREIMAGE_DOMAIN),
    call_id: z.string().uuid(),
    agent_id: z.string().uuid(),
    market_ref: z
      .object({
        protocol: z.string().min(1),
        sourceId: z.string().min(1),
      })
      .strict(),
    keyset_id: z.string().min(1),
    circuit_id: z.string().min(1),
    ciphertext_hash: z.string().regex(HEX_LOWER_64),
    vector_len: z.number().int().min(2).max(256),
    payout_denominator: z.string().regex(DECIMAL_BIGINT),
    nonce: z.string().regex(HEX_LOWER_64),
    t0_anchor_ts: z.string().regex(ISO_NO_FRAC),
    accepted_at: z.string().regex(ISO_NO_FRAC),
  })
  .strict();

export type ValidatedFheCommitPreimage = z.infer<
  typeof FheCommitPreimageSchema
>;
