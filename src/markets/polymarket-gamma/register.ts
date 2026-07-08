/**
 * Boot wiring for the Polymarket Gamma adapter.
 *
 * Off by default. The daemon dynamic-imports this module ONLY when
 * `MURMUR_POLYMARKET_GAMMA_ENABLED=1` so the legacy boot path stays
 * byte-identical when the flag is unset (mirrors the Z0 FHE loader
 * posture in src/daemon/index.ts).
 *
 * Side effects on `registerPolymarketGammaAdapter`:
 *   1. Idempotent register of the singleton {@link polymarketGammaAdapter}
 *      into the process-wide {@link MarketMakerRegistry}.
 *   2. Optional sync ticker start (caller passes the DB handle + clock).
 *
 * Cite: RESEARCH_polymarket_gamma_adapter.md §5, §10.
 */

import type Database from "better-sqlite3";
import {
  getMarketMakerRegistry,
} from "../../verdict/market-maker/registry.js";
import {
  polymarketGammaAdapter,
  setDefaultPolymarketClock,
  ADAPTER_NAME,
  ADAPTER_VERSION,
} from "./index.js";
import {
  startPolymarketSyncTicker,
  type SyncTickerOpts,
} from "./sync.js";

export interface RegisterPolymarketOpts {
  /** When provided, also start the per-conditionId sync ticker. */
  db?: undefined;
  /** Configure the adapter default client from nowMs. */
  configureDefaultClient?: boolean;
  /** Optional clock for callers that only need adapter registration. */
  nowMs?: () => number;
  /** Tick interval in ms. Default 60s. */
  syncIntervalMs?: number;
  /** Optional alert sink override. */
  onAlert?: SyncTickerOpts["onAlert"];
}

export interface RegisterPolymarketWithSyncOpts {
  /** When provided, also start the per-conditionId sync ticker. */
  db: Database.Database;
  /** Configure the adapter default client from nowMs. */
  configureDefaultClient?: boolean;
  /** Sync ticker operation clock. */
  nowMs: () => number;
  /** Tick interval in ms. Default 60s. */
  syncIntervalMs?: number;
  /** Optional alert sink override. */
  onAlert?: SyncTickerOpts["onAlert"];
}

/**
 * Register the Polymarket Gamma adapter in the market-maker registry. Safe
 * to call multiple times — re-registration is a no-op when the singleton
 * is already present.
 */
export function registerPolymarketGammaAdapter(
  opts: RegisterPolymarketOpts | RegisterPolymarketWithSyncOpts = {},
): { stop: () => void } {
  const registry = getMarketMakerRegistry();
  const existing = registry.get(ADAPTER_NAME, ADAPTER_VERSION);
  if (existing === null) {
    registry.register(polymarketGammaAdapter);
    console.log(
      `[polymarket-gamma] adapter registered (name=${ADAPTER_NAME}, version=${ADAPTER_VERSION})`,
    );
  } else {
    console.log(
      `[polymarket-gamma] adapter already registered — skipping re-register`,
    );
  }
  if (opts.configureDefaultClient && opts.nowMs) {
    setDefaultPolymarketClock(opts.nowMs);
  }
  if (opts.db) {
    const tickerOpts: SyncTickerOpts & { intervalMs?: number } = {
      db: opts.db,
      nowMs: opts.nowMs,
    };
    if (opts.syncIntervalMs !== undefined) {
      tickerOpts.intervalMs = opts.syncIntervalMs;
    }
    if (opts.onAlert) {
      tickerOpts.onAlert = opts.onAlert;
    }
    const handle = startPolymarketSyncTicker(tickerOpts);
    console.log(
      `[polymarket-gamma] sync ticker started (interval=${opts.syncIntervalMs ?? 60_000}ms)`,
    );
    return handle;
  }
  return { stop: async () => undefined };
}
