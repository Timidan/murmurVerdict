/**
 * Boot wiring for the Polymarket Gamma adapter: registers it and optionally
 * starts the sync ticker. On by default; `MURMUR_POLYMARKET_GAMMA_ENABLED=false`
 * makes the daemon skip it.
 */

import type Database from "better-sqlite3";
import {
  getMarketMakerRegistry,
} from "../../verdict/market-maker/registry.js";
import {
  polymarketGammaAdapter,
  getDefaultPolymarketClobClient,
  setDefaultPolymarketClock,
  ADAPTER_NAME,
  ADAPTER_VERSION,
} from "./index.js";
import {
  startPolymarketSyncTicker,
  type SyncTickerOpts,
} from "./sync.js";

export interface RegisterPolymarketOpts {
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

/** Idempotent. */
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
    // Configures both default clients; the CLOB one is shared with the ticker below.
    setDefaultPolymarketClock(opts.nowMs);
  }
  if (opts.db) {
    const tickerOpts: SyncTickerOpts & { intervalMs?: number } = {
      db: opts.db,
      nowMs: opts.nowMs,
    };
    const sharedClobClient = getDefaultPolymarketClobClient();
    if (sharedClobClient) {
      tickerOpts.clobClient = sharedClobClient;
    }
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
