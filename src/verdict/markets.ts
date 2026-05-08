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
