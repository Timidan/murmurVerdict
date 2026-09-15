// Read-only market helpers between submissions and the registry. Writes go through `marketsRepo.bumpConfig`.
// Markets are venue-authored and venue-resolved, so adapter identity is required, never defaulted.

import {
  type MarketRow,
} from "./repos/market-registry-repo.js";
import { getMarketMakerRegistry } from "./market-maker/registry.js";
import type { MarketMakerAdapter } from "../markets/types.js";

// ─── Adapter dispatch ───────────────────────────────────────────────────────
//
// Fail-closed: a row with no adapter_id, or an unregistered one, must never mint or settle a call.

/** Public-projection sentinel for a row without adapter columns. Display-only; never dispatched on. */
export const UNKNOWN_ADAPTER_ID = "unknown" as const;
export const UNKNOWN_MARKET_FAMILY = "unknown" as const;

/** Missing or unregistered adapter. Callers refuse the call rather than abort the transaction. */
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

/** No fallback: throws {@link AdapterNotFoundError} unless `adapter_id` names a registered adapter. */
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

/** Adapter identity for public reads; missing columns show the display-only `unknown` sentinel. */
export function adapterIdentityForMarket(marketRow: MarketRow): {
  adapter_id: string;
  market_family: string;
} {
  return {
    adapter_id: marketRow.adapter_id ?? UNKNOWN_ADAPTER_ID,
    market_family: marketRow.market_family ?? UNKNOWN_MARKET_FAMILY,
  };
}

/** Only `listed` accepts new submissions; pending calls still resolve on a `frozen` market. */
export function acceptsSubmissions(market: MarketRow): boolean {
  return market.status === "listed";
}

/** Retired is terminal (pending calls past the cutoff auto-void); every other status keeps resolving. */
export function resolverShouldTick(market: MarketRow): boolean {
  return market.status !== "retired";
}

/**
 * Dedup bucket size in seconds: horizon / 4, floored at 5 minutes.
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
 * Dedup key: agent_id|market_id|accepted_at bucket. Side is sealed at acceptance,
 * so opposite calls in one bucket share a key.
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

/** Per-market daily cap, on top of the per-agent active cap; uniform across markets. */
export const PER_MARKET_DAILY_CAP = 12;
export function perMarketDailyCap(_market_id: string): number {
  return PER_MARKET_DAILY_CAP;
}
