// Market-level helpers — the bridge between submissions and the registry.
//
// Murmur is a pure referee over EXTERNAL prediction venues: every market row
// is authored by a venue adapter (Polymarket Gamma today) and resolved by that
// venue. There is no Murmur-authored market and no self-resolving price path,
// so a market's adapter identity is REQUIRED, never defaulted.
//
// Read-only — no writes. Mutating a market goes through `marketsRepo.bumpConfig`.

import {
  type MarketRow,
} from "./repos/market-registry-repo.js";
import { getMarketMakerRegistry } from "./market-maker/registry.js";
import type { MarketMakerAdapter } from "../markets/types.js";

// ─── Adapter dispatch ───────────────────────────────────────────────────────
//
// Every market row resolves to exactly one {@link MarketMakerAdapter} via its
// stored `markets.adapter_id` (MIGRATION_016). Dispatch is fail-closed: a row
// with no adapter_id, or one naming an adapter this daemon does not register,
// is NOT resolvable and must never mint or settle a call.

/**
 * Sentinel surfaced by the PUBLIC registry/call projections for a historical
 * row that pre-dates the adapter columns. It is presentation-only — nothing
 * dispatches on it, and {@link getAdapterForMarket} refuses such a row.
 */
export const UNKNOWN_ADAPTER_ID = "unknown" as const;
export const UNKNOWN_MARKET_FAMILY = "unknown" as const;

/**
 * Distinct error for "row has no adapter, or references an adapter that isn't
 * registered." Callers (resolver, acceptance guards) catch this and refuse the
 * call rather than aborting the surrounding transaction.
 */
export class AdapterNotFoundError extends Error {
  readonly code = "adapter_not_found" as const;
  readonly adapter_id: string | null;
  readonly market_id: string | null;

  constructor(adapter_id: string | null, market_id: string | null) {
    super(
      adapter_id === null
        ? `getAdapterForMarket: market '${market_id ?? "<unknown>"}' has no adapter_id`
        : `getAdapterForMarket: adapter '${adapter_id}' not registered for market '${market_id ?? "<unknown>"}'`,
    );
    this.name = "AdapterNotFoundError";
    this.adapter_id = adapter_id;
    this.market_id = market_id;
  }
}

/**
 * Return the {@link MarketMakerAdapter} that handles `marketRow`. Requires an
 * explicit `markets.adapter_id` that names a REGISTERED adapter — there is no
 * implicit fallback. Throws {@link AdapterNotFoundError} otherwise.
 */
export function getAdapterForMarket(marketRow: MarketRow): MarketMakerAdapter {
  const adapterId = marketRow.adapter_id;
  if (!adapterId) {
    throw new AdapterNotFoundError(null, marketRow.market_id);
  }
  const adapter = getMarketMakerRegistry().get(adapterId);
  if (!adapter) {
    throw new AdapterNotFoundError(adapterId, marketRow.market_id);
  }
  return adapter;
}

/**
 * Adapter identity a PUBLIC read surface shows for a row. Reads the stamped
 * columns (`upsertExternalMarket` writes both on every venue registration);
 * only a pre-adapter-column historical row falls through to the neutral
 * `unknown` sentinel, which is display-only and never dispatched on.
 */
export function adapterIdentityForMarket(marketRow: MarketRow): {
  adapter_id: string;
  market_family: string;
} {
  return {
    adapter_id: marketRow.adapter_id ?? UNKNOWN_ADAPTER_ID,
    market_family: marketRow.market_family ?? UNKNOWN_MARKET_FAMILY,
  };
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
 * Per-market daily cap (Codex P3 D3), in addition to the per-agent active cap
 * (5). Uniform across every external market: with markets minted per venue
 * event there is no privileged market to widen the cap for.
 */
export const PER_MARKET_DAILY_CAP = 12;
export function perMarketDailyCap(_market_id: string): number {
  return PER_MARKET_DAILY_CAP;
}
