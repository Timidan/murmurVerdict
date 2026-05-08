// Market-level helpers — the bridge between submissions and the registry.
//
// Today's resolver still works off legacy (asset_id, horizon_hours) columns.
// New code calls these helpers to:
//   - resolve a market_id (live or legacy-synthesized)
//   - compute the resolve_after timestamp for a submission
//   - derive a default void_band from a market row
//   - bucket a t0 into a round_id when the market is round-based
//
// Read-only — no writes. Mutating a market goes through `marketsRepo.bumpConfig`.

import type Database from "better-sqlite3";
import {
  marketsRepo,
  type MarketRow,
} from "./db.js";

/**
 * Resolve a submission's market — either by explicit market_id (new code path)
 * or by legacy (asset_id, horizon_hours) lookup. Returns null if no row matches.
 */
export function resolveMarket(
  db: Database.Database,
  args:
    | { market_id: string }
    | { asset_id: string; horizon_hours: number },
): MarketRow | null {
  if ("market_id" in args) {
    return marketsRepo.get(db, args.market_id);
  }
  const synthesized = marketsRepo.legacyIdFor(args.asset_id, args.horizon_hours);
  if (!synthesized) return null;
  return marketsRepo.get(db, synthesized);
}

/**
 * Compute the t1 deadline (`resolve_after`) for a submission. The resolver's
 * tick loop walks calls whose `resolve_after <= now()`. Returns ISO8601 UTC.
 *
 * t0 is the canonical anchor — for direction_binary calls accepted with
 * grace, t0 = anchored_at; for committed-mode calls, t0 = the daemon's
 * deterministic anchor at acceptance. This function only adds horizon_seconds.
 */
export function computeResolveAfter(
  market: MarketRow,
  t0_iso: string,
): string {
  const t0Ms = Date.parse(t0_iso);
  if (Number.isNaN(t0Ms)) {
    throw new Error(`computeResolveAfter: invalid t0 '${t0_iso}'`);
  }
  const t1Ms = t0Ms + market.horizon_seconds * 1000;
  return new Date(t1Ms).toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Bucket a t0 into a round_id for round-based scoring kinds
 * (rank_proximity_l1, bracket_hit). Returns null for non-round markets.
 *
 * Cohort policy: floor(t0 / round_cadence) * round_cadence aligned to the
 * Unix epoch — UTC-stable, easy to reproduce off-Murmur. Format the bucket
 * back to ISO8601 UTC for canonicalization in receipts.
 */
export function computeRoundId(
  market: MarketRow,
  t0_iso: string,
): string | null {
  if (!market.round_cadence_seconds) return null;
  const t0Ms = Date.parse(t0_iso);
  if (Number.isNaN(t0Ms)) {
    throw new Error(`computeRoundId: invalid t0 '${t0_iso}'`);
  }
  const cadenceMs = market.round_cadence_seconds * 1000;
  const bucketMs = Math.floor(t0Ms / cadenceMs) * cadenceMs;
  const bucket = new Date(bucketMs).toISOString().replace(/\.\d+Z$/, "Z");
  return `${market.market_id}@${bucket}`;
}

/**
 * Default void_band as a Number — markets store it as a decimal string for
 * canonicalization, but the resolver scoring path needs a float.
 */
export function voidBandFloat(market: MarketRow): number {
  const n = Number(market.void_band);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `market ${market.market_id}: void_band='${market.void_band}' is not a valid non-negative number`,
    );
  }
  return n;
}

/**
 * Whether a market is open for new submissions. `listed` accepts; everything
 * else (`draft`, `frozen`, `retired`) refuses. Existing pending calls
 * continue to resolve regardless of status — a `frozen` market still ticks.
 */
export function acceptsSubmissions(market: MarketRow): boolean {
  return market.status === "listed";
}

/**
 * Whether the resolver should still tick a market. Retired markets are
 * terminal — pending calls past the cutoff get auto-voided. Everything else
 * keeps resolving so we don't strand in-flight calls when a market freezes
 * temporarily.
 */
export function resolverShouldTick(market: MarketRow): boolean {
  return market.status !== "retired";
}

/**
 * Codex follow-up F2: replaces the Math.round(horizon_seconds/3600) trap
 * scattered across submitCall / /reveal / fallback materialization. For
 * seeded markets the rounding accidentally produced legal values (5m→0,
 * 15m→0, 1h→1, 4h→4, 24h→24, 7d→168). For any future arbitrary horizon
 * (e.g. 7m → 0 same as 5m, 90m → 2 not a legal HorizonHours) it would
 * silently mint receipts with wrong-shape horizon_hours.
 *
 * This helper fails closed on horizons that don't map cleanly into the
 * legacy back-compat surface. Operators introducing a new horizon must
 * either (a) align with the seeded set, (b) extend HorizonHoursSchema
 * + add a sentinel mapping here, or (c) accept the call won't carry
 * a meaningful horizon_hours legacy value.
 */
export function legacyHorizonHoursForMarket(
  market: { market_id: string; horizon_seconds: number },
): 0 | 1 | 4 | 24 | 168 {
  const seconds = market.horizon_seconds;
  if (seconds > 0 && seconds < 3600) return 0; // sub-hour sentinel
  if (seconds === 3600) return 1;
  if (seconds === 14400) return 4;
  if (seconds === 86400) return 24;
  if (seconds === 604800) return 168;
  throw new Error(
    `market ${market.market_id} horizon_seconds=${seconds} does not map to HorizonHoursSchema {0,1,4,24,168}; legacy horizon_hours stamping requires alignment with the schema enum or a new sentinel`,
  );
}

// ─── P3 — submit-time market resolution + dedup ─────────────────────────────

/** Either of the two wire shapes a SubmittedCall can carry per Codex P3 D1. */
export type MarketSelector =
  | { market_id: string; asset_id?: string; horizon_hours?: number }
  | { market_id?: undefined; asset_id: string; horizon_hours: number };

/**
 * Resolve a SubmittedCall payload to its MarketRow. Honors both wire shapes:
 *   - `market_id` present → direct registry lookup
 *   - legacy `(asset_id, horizon_hours)` only → synthesize via legacyIdFor
 * Returns null when no market matches. Caller decides on the error shape
 * (404 unknown market, 4xx draft market, etc.).
 */
export function resolveMarketFromPayload(
  db: Database.Database,
  payload: MarketSelector,
): MarketRow | null {
  if (payload.market_id) {
    return marketsRepo.get(db, payload.market_id);
  }
  if (payload.asset_id && typeof payload.horizon_hours === "number") {
    const synthesized = marketsRepo.legacyIdFor(
      payload.asset_id,
      payload.horizon_hours,
    );
    if (!synthesized) return null;
    return marketsRepo.get(db, synthesized);
  }
  return null;
}

/**
 * Dedup bucket size in seconds — Codex P3 D2. Floor at 5 minutes so 5m / 15m
 * markets don't degrade dedup into a no-op spam control.
 *
 * | horizon | bucket |
 * |---------|--------|
 * | 5m      | 5m     |
 * | 15m     | 5m     |
 * | 1h      | 15m    |
 * | 4h      | 1h     |
 * | 24h     | 6h     |
 * | 7d      | 42h    |
 *
 * Volume control belongs to the daily clamps; dedup only catches duplicate
 * intent inside a coarse window.
 */
export const DEDUP_BUCKET_FLOOR_SECONDS = 300;
export function computeDedupBucketSeconds(horizon_seconds: number): number {
  return Math.max(
    DEDUP_BUCKET_FLOOR_SECONDS,
    Math.floor(horizon_seconds / 4),
  );
}

/**
 * New dedup key shape. Includes market_id (encodes asset + horizon) instead
 * of carrying both, so the same call on (eth.1h vs eth.4h) buckets cleanly.
 *
 * For the four legacy ETH horizons, this produces the SAME bucket boundaries
 * as the old buildDedupKey() — the bucket math is byte-stable for callers
 * that already had market_id backfilled by migration 009.
 */
export function buildMarketDedupKey(args: {
  agent_id: string;
  market_id: string;
  side: "BUY" | "SELL";
  horizon_seconds: number;
  /** Server-stamped accepted_at. NEVER use the agent-supplied submitted_at. */
  accepted_at_iso: string;
}): string {
  const ms = Date.parse(args.accepted_at_iso);
  if (Number.isNaN(ms)) {
    throw new Error(
      `buildMarketDedupKey: invalid accepted_at_iso '${args.accepted_at_iso}'`,
    );
  }
  const bucketSec = computeDedupBucketSeconds(args.horizon_seconds);
  const bucketMs = bucketSec * 1000;
  const bucket = Math.floor(ms / bucketMs) * bucketMs;
  return `${args.agent_id}|${args.market_id}|${args.side}|${bucket}`;
}

/**
 * Phase-1 per-market daily cap (Codex P3 D3). Legacy ETH markets keep the
 * pre-P3 effective cap (24/asset/day, which equals 24/market/day for ETH
 * since ETH had one market per horizon). New markets get a tighter cap
 * until we have telemetry to widen it.
 *
 * NOTE: this is in addition to the per-asset daily cap (24/asset/day) and
 * the per-agent active cap (5). Sum across all of an asset's markets still
 * has to fit under per-asset.
 */
const LEGACY_ETH_MARKETS = new Set([
  "eth.1h",
  "eth.4h",
  "eth.24h",
  "eth.7d",
]);
export function perMarketDailyCap(market_id: string): number {
  return LEGACY_ETH_MARKETS.has(market_id) ? 24 : 12;
}
