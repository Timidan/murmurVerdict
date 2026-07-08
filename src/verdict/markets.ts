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

import {
  type MarketRow,
} from "./repos/market-registry-repo.js";
import { getMarketMakerRegistry } from "./market-maker/registry.js";
import type { MarketMakerAdapter } from "../markets/types.js";

// ─── P3 — adapter dispatch (Phase 3 of V2_IMPLEMENTATION_PLAN) ──────────────
//
// Every market row resolves to exactly one {@link MarketMakerAdapter}. Today
// the only registered adapter is `native-price` (handles legacy ETH markets,
// signed-return scoring, oracle T0/T1 anchoring). Phase 11 lands Polymarket
// Gamma; Phase 13+ lands UMA / Reality.eth / etc. The dispatch key is
// `markets.adapter_id` once migration 016 lands; until then every native-price
// market falls through here by name.
//
// SHELL behavior: this helper is currently a deterministic constant — every
// market gets `native-price`. The signature accepts a {@link MarketRow} so
// the Phase 5 cutover can read `markets.adapter_id` from the row and dispatch
// without changing any call site.

export const NATIVE_PRICE_ADAPTER_ID = "native-price" as const;
export const FINANCIAL_DIRECTION_FAMILY = "financial-direction" as const;

/**
 * FIX 5 — distinct error for "row references an adapter that isn't
 * registered." Caller (resolver) catches this and skips the v2 path
 * for the call rather than aborting the legacy transaction.
 */
export class AdapterNotFoundError extends Error {
  readonly code = "adapter_not_found" as const;
  readonly adapter_id: string;
  readonly market_id: string | null;

  constructor(adapter_id: string, market_id: string | null) {
    super(
      `getAdapterForMarket: adapter '${adapter_id}' not registered for market '${market_id ?? "<unknown>"}'`,
    );
    this.name = "AdapterNotFoundError";
    this.adapter_id = adapter_id;
    this.market_id = market_id;
  }
}

/**
 * Return the {@link MarketMakerAdapter} that handles `marketRow`. Honors
 * `markets.adapter_id` (added in MIGRATION_016) — when set, dispatches to
 * that adapter; when null/missing (pre-Phase-1 markets that didn't get the
 * backfill), falls back to the legacy `native-price` adapter. Throws
 * {@link AdapterNotFoundError} when the row points at an adapter that
 * isn't registered.
 */
export function getAdapterForMarket(marketRow: MarketRow): MarketMakerAdapter {
  const adapterId = marketRow.adapter_id ?? NATIVE_PRICE_ADAPTER_ID;
  const adapter = getMarketMakerRegistry().get(adapterId);
  if (!adapter) {
    throw new AdapterNotFoundError(adapterId, marketRow.market_id);
  }
  return adapter;
}

/**
 * Resolve the adapter_id + market_family that the public market-list API
 * surfaces for a given row. Reads the stamped columns first (MIGRATION_016
 * backfilled native-price rows; Wave 4b's `upsertExternalMarket` stamps
 * adapter-specific values for Polymarket rows); falls back to the legacy
 * defaults only when the row pre-dates the adapter columns.
 */
export function adapterIdentityForMarket(marketRow: MarketRow): {
  adapter_id: string;
  market_family: string;
} {
  return {
    adapter_id: marketRow.adapter_id ?? NATIVE_PRICE_ADAPTER_ID,
    market_family: marketRow.market_family ?? FINANCIAL_DIRECTION_FAMILY,
  };
}

/**
 * Compute the t1 deadline (`resolve_after`) for a submission. The resolver's
 * tick loop walks calls whose `resolve_after <= now()`. Returns ISO8601 UTC.
 *
 * t0 is the canonical anchor. This function only adds horizon_seconds.
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
 * Resolver scoring still uses the legacy volatility buckets, so native-price
 * markets map horizon_seconds into that finite bucket set here.
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
    `market ${market.market_id} horizon_seconds=${seconds} does not map to scoring horizon buckets {0,1,4,24,168}`,
  );
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
 * Dedup key for a single submission. Keyed on (agent_id, market_id,
 * accepted_at-bucket). Sealed Fhenix submissions never reveal side at
 * acceptance time, so two opposite-direction calls on the same market
 * within the same bucket collapse to one dedup_key. The horizon factor is
 * implicit in market_id (each market is single-horizon by registry
 * contract).
 */
export function buildMarketDedupKey(args: {
  agent_id: string;
  market_id: string;
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
  return `${args.agent_id}|${args.market_id}|${bucket}`;
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
