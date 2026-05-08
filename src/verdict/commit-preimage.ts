import { canonicalHash, canonicalize } from "../receipts/canonical.js";

/**
 * Murmur Verdict commit-reveal preimage (P2).
 *
 * The agent submits an encrypted call envelope and a commit_hash. The
 * commit_hash is the keccak256 of the canonical-JSON form of THIS
 * preimage. At reveal time, the agent (or the daemon's fallback path)
 * publishes the preimage; the daemon recomputes the hash and verifies.
 *
 * Why a domain-bound preimage:
 *   - same fields signed across daemon + agent → byte-identical commit
 *   - `domain` + `v` mean a v0.3 fhEVM port doesn't accidentally accept
 *     v0.2 commitments and vice-versa
 *   - `call_id` ties the commitment to a specific submission so a
 *     preimage from one call can't be replayed on another
 *   - `agent_wallet` + `chain_id` bind the commit to who's making it,
 *     consistent with receipt subjects (P1.5)
 *   - `salt` is the agent's random per-call entropy — without it, the
 *     hash leaks the (side, asset, horizon, confidence) tuple via
 *     dictionary attack (only 2 × N_assets × 4 × 100 ≈ 80k combos)
 *   - `t0` is daemon-canonical (D16); locks the commitment to a
 *     specific market moment so an agent can't backdate
 */

export const COMMIT_PREIMAGE_SCHEMA = "murmur-verdict-v0.2-commit@1" as const;
export const COMMIT_PREIMAGE_VERSION = 1 as const;
export const COMMIT_PREIMAGE_DOMAIN = "murmur-verdict-v0.2-commit" as const;

/**
 * Wall-clock seconds past `accepted_at + horizon` after which the
 * daemon may decrypt the age envelope itself if the agent failed to
 * reveal voluntarily (D17). Locked at 900s = 15 min. Operator must
 * NOT make this configurable — the receipt commits to a derived
 * `fallback_after` field, so changing the constant per-call would
 * fork the receipt's meaning. v0.3 fhEVM port may revisit; v0.2 is
 * fixed.
 */
export const REVEAL_GRACE_SECONDS = 900 as const;
export const REVEAL_GRACE_MS = REVEAL_GRACE_SECONDS * 1000;

export interface CommitPreimage {
  v: typeof COMMIT_PREIMAGE_VERSION;
  domain: typeof COMMIT_PREIMAGE_DOMAIN;
  call_id: string;
  /** Lowercase 0x + 40 hex (P1.5 normalization). */
  agent_wallet: string;
  /** CAIP-2, e.g. "eip155:8453". */
  chain_id: string;
  side: "BUY" | "SELL";
  asset_id: string;
  horizon_hours: number;
  /** Float in [0.51, 0.95] per existing SubmittedCallSchema. */
  confidence: number;
  /** Agent-supplied entropy. 32 random bytes hex (64 chars). */
  salt: string;
  /** Daemon canonical t0 — ISO 8601 with no fractional seconds. */
  t0: string;
}

/**
 * Build the canonical preimage object. Pure — no I/O, no defaults.
 * Caller is responsible for ensuring agent_wallet is already lowercased
 * and that salt is the agent-supplied 32-byte hex.
 */
export function buildCommitPreimage(input: Omit<CommitPreimage, "v" | "domain">): CommitPreimage {
  return {
    v: COMMIT_PREIMAGE_VERSION,
    domain: COMMIT_PREIMAGE_DOMAIN,
    call_id: input.call_id,
    agent_wallet: input.agent_wallet,
    chain_id: input.chain_id,
    side: input.side,
    asset_id: input.asset_id,
    horizon_hours: input.horizon_hours,
    confidence: input.confidence,
    salt: input.salt,
    t0: input.t0,
  };
}

/**
 * keccak256(canonical_json(preimage)) → 0x + 64 hex chars.
 *
 * Agent + daemon MUST produce byte-identical canonical JSON (same key
 * order, same number representation, no whitespace). receipts/canonical.ts
 * implements RFC 8259-compatible stable stringification — keys sorted
 * lex, undefined dropped, primitives via JSON.stringify.
 */
export function computeCommitHash(preimage: CommitPreimage): `0x${string}` {
  return canonicalHash(preimage);
}

/**
 * Convenience: build the preimage AND compute the hash in one call.
 * Returns both so callers can persist the preimage (encrypted) and
 * publish the hash separately.
 */
export function buildCommit(input: Omit<CommitPreimage, "v" | "domain">): {
  preimage: CommitPreimage;
  preimage_canonical: string;
  commit_hash: `0x${string}`;
} {
  const preimage = buildCommitPreimage(input);
  const preimage_canonical = canonicalize(preimage);
  const commit_hash = computeCommitHash(preimage);
  return { preimage, preimage_canonical, commit_hash };
}

/**
 * Verify a revealed preimage against a stored commit_hash. Used at
 * reveal time (Phase C) — the agent posts the preimage, daemon recomputes
 * keccak256 and compares lowercase. Returns true when they match.
 *
 * Constant-time string compare is unnecessary here: the hash is publicly
 * derivable from the preimage; an attacker who can submit a preimage
 * already knows whether it'll match.
 */
export function verifyCommitHash(
  preimage: CommitPreimage,
  expected_hash: string,
): boolean {
  return computeCommitHash(preimage).toLowerCase() === expected_hash.toLowerCase();
}

// ─── P3 — market-aware preimage (v0.2.5) ───────────────────────────────────
//
// Codex P3 D4: when a submission goes through the explicit market_id wire
// shape, the commit preimage uses a NEW domain that drops asset_id +
// horizon_hours and adds market_id + market_config_version. The legacy
// domain stays unchanged; v1 preimages keep verifying byte-identically
// after migration.
//
// "never reinterpret old commit preimages" — Codex risks. The two domains
// are wire-distinct (different `domain` strings) so a verifier always
// knows which schema it's matching. A v0.2 preimage will never collide
// with a v0.2.5 preimage because the canonical JSON differs at byte 0.
//
// market_config_version: stamped into the preimage so a verifier can
// reproduce the daemon's policy at acceptance time (oracle staleness,
// void band, etc.). Bumping a market's config doesn't invalidate prior
// commitments — the on-the-wire receipt carries the original version.

export const MARKET_COMMIT_PREIMAGE_SCHEMA =
  "murmur-verdict-v0.2.5-commit@1" as const;
export const MARKET_COMMIT_PREIMAGE_VERSION = 1 as const;
export const MARKET_COMMIT_PREIMAGE_DOMAIN =
  "murmur-verdict-v0.2.5-commit" as const;

export interface MarketCommitPreimage {
  v: typeof MARKET_COMMIT_PREIMAGE_VERSION;
  domain: typeof MARKET_COMMIT_PREIMAGE_DOMAIN;
  call_id: string;
  agent_wallet: string;
  chain_id: string;
  side: "BUY" | "SELL";
  market_id: string;
  market_config_version: number;
  confidence: number;
  salt: string;
  t0: string;
}

export function buildMarketCommitPreimage(
  input: Omit<MarketCommitPreimage, "v" | "domain">,
): MarketCommitPreimage {
  return {
    v: MARKET_COMMIT_PREIMAGE_VERSION,
    domain: MARKET_COMMIT_PREIMAGE_DOMAIN,
    call_id: input.call_id,
    agent_wallet: input.agent_wallet,
    chain_id: input.chain_id,
    side: input.side,
    market_id: input.market_id,
    market_config_version: input.market_config_version,
    confidence: input.confidence,
    salt: input.salt,
    t0: input.t0,
  };
}

export function computeMarketCommitHash(
  preimage: MarketCommitPreimage,
): `0x${string}` {
  return canonicalHash(preimage);
}

export function buildMarketCommit(
  input: Omit<MarketCommitPreimage, "v" | "domain">,
): {
  preimage: MarketCommitPreimage;
  preimage_canonical: string;
  commit_hash: `0x${string}`;
} {
  const preimage = buildMarketCommitPreimage(input);
  const preimage_canonical = canonicalize(preimage);
  const commit_hash = computeMarketCommitHash(preimage);
  return { preimage, preimage_canonical, commit_hash };
}

export function verifyMarketCommitHash(
  preimage: MarketCommitPreimage,
  expected_hash: string,
): boolean {
  return (
    computeMarketCommitHash(preimage).toLowerCase() ===
    expected_hash.toLowerCase()
  );
}
