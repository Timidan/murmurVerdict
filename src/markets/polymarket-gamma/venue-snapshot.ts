/**
 * Adds live Gamma odds / volume / liquidity to the public market rows.
 * `end_date` and `url` come from stored config and survive outages. Live
 * fields are cached per market (60s) and bounded by a 2s budget: past it the
 * row is served without them while the fetch warms the cache in the background.
 */

import {
  PolymarketGammaClient,
  type PolymarketGammaTimers,
} from "./client.js";
import { parseOutcomeLabels, type GammaMarketSnapshot } from "./transform.js";
import {
  conditionIdForMarketConfig,
  parseMarketConfigJson,
} from "../../verdict/market-adapter-config.js";
import { isoFromMs } from "../../verdict/time.js";

export const VENUE_ADAPTER_ID = "polymarket-gamma" as const;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_FETCH_BUDGET_MS = 2_000;

// ─── Wire types ─────────────────────────────────────────────────────────────

export interface MarketVenuePricePoint {
  outcome: string;
  price: number;
}

/**
 * The `venue` object stamped onto venue-market rows (list + single).
 * Live fields are null when Gamma has not answered (yet / at all);
 * `end_date`/`url` come from the stored config and survive outages.
 */
export interface MarketVenueSnapshot {
  prices: MarketVenuePricePoint[] | null;
  volume: number | null;
  liquidity: number | null;
  end_date: string | null;
  url: string | null;
  fetched_at: string | null;
}

/** Row subset the provider needs — structurally satisfied by both raw
 *  MarketRow and the enriched public registry row. */
export interface MarketVenueSnapshotSource {
  market_id: string;
  adapter_id: string | null;
  config_json: string;
}

/** Injection seam for the market read surfaces (smokes stub this). */
export interface MarketVenueSnapshotAdapter {
  /** `undefined` for non-venue (native) markets — the row gets no `venue` key. */
  venueForMarket(
    market: MarketVenueSnapshotSource,
  ): Promise<MarketVenueSnapshot | undefined>;
}

// ─── Provider ───────────────────────────────────────────────────────────────

export interface PolymarketVenueSnapshotProviderOpts {
  /** Inject a pre-wired client (smokes pass a stub-fetch client). */
  client?: PolymarketGammaClient;
  /** Cache clock. Defaults to Date.now. */
  nowMs?: () => number;
  /** Per-market snapshot TTL. Default 60s. */
  ttlMs?: number;
  /** Hard bound on request-path fetch latency. Default 2s. */
  fetchBudgetMs?: number;
  /** Timer Adapter for the fetch budget (smokes may inject). */
  timers?: PolymarketGammaTimers;
}

interface LiveVenueFields {
  prices: MarketVenuePricePoint[] | null;
  volume: number | null;
  liquidity: number | null;
  fetched_at: string;
}

interface VenueCacheEntry {
  /** null = last refresh failed (negative-cached for one TTL). */
  live: LiveVenueFields | null;
  expiresAtMs: number;
}

export class PolymarketVenueSnapshotProvider
  implements MarketVenueSnapshotAdapter
{
  private readonly client: PolymarketGammaClient;
  private readonly nowMs: () => number;
  private readonly ttlMs: number;
  private readonly fetchBudgetMs: number;
  private readonly timers: PolymarketGammaTimers;

  private readonly cache = new Map<string, VenueCacheEntry>();
  private readonly inflight = new Map<string, Promise<LiveVenueFields | null>>();

  constructor(opts: PolymarketVenueSnapshotProviderOpts = {}) {
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.client = opts.client ?? new PolymarketGammaClient({ nowMs: this.nowMs });
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchBudgetMs = opts.fetchBudgetMs ?? DEFAULT_FETCH_BUDGET_MS;
    this.timers = opts.timers ?? {
      setTimeout(callback, ms) {
        return setTimeout(callback, ms);
      },
      clearTimeout(handle) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    };
  }

  async venueForMarket(
    market: MarketVenueSnapshotSource,
  ): Promise<MarketVenueSnapshot | undefined> {
    if (market.adapter_id !== VENUE_ADAPTER_ID) {
      return undefined;
    }
    const config = parseMarketConfigJson(market.config_json);
    const skeleton: MarketVenueSnapshot = {
      prices: null,
      volume: null,
      liquidity: null,
      end_date: typeof config.endDate === "string" ? config.endDate : null,
      url: typeof config.gamma_url === "string" ? config.gamma_url : null,
      fetched_at: null,
    };
    const conditionId = conditionIdForMarketConfig(market.config_json);
    if (conditionId === null) return skeleton;
    const live = await this.liveFieldsWithinBudget(
      market.market_id,
      conditionId,
      config,
    );
    return live === null ? skeleton : { ...skeleton, ...live };
  }

  /** Smoke helper — current cache size. */
  cacheSize(): number {
    return this.cache.size;
  }

  private async liveFieldsWithinBudget(
    marketId: string,
    conditionId: string,
    config: Record<string, unknown>,
  ): Promise<LiveVenueFields | null> {
    const cached = this.cache.get(marketId);
    if (cached && cached.expiresAtMs > this.nowMs()) return cached.live;
    return this.raceBudget(this.refresh(marketId, conditionId, config));
  }

  /**
   * Single-flighted refresh per market_id. NEVER rejects — failures cache
   * `live: null` for one TTL so an outage cannot spin request-path fetches.
   */
  private refresh(
    marketId: string,
    conditionId: string,
    config: Record<string, unknown>,
  ): Promise<LiveVenueFields | null> {
    const existing = this.inflight.get(marketId);
    if (existing) return existing;
    const promise = (async () => {
      let live: LiveVenueFields | null = null;
      try {
        const result = await this.client.fetchMarketByConditionId(conditionId);
        if (result.snapshot !== null) {
          live = liveVenueFieldsFromSnapshot(
            result.snapshot,
            config,
            isoFromMs(this.nowMs()),
          );
        }
      } catch {
        // The client shouldn't throw; stay always-200 if it does.
        live = null;
      } finally {
        this.inflight.delete(marketId);
      }
      this.cache.set(marketId, {
        live,
        expiresAtMs: this.nowMs() + this.ttlMs,
      });
      return live;
    })();
    this.inflight.set(marketId, promise);
    return promise;
  }

  /**
   * Bound `promise` to the fetch budget. On timeout the caller gets `null`
   * now while the losing refresh continues in the background (it owns its
   * own cache write + inflight cleanup, and never rejects).
   */
  private raceBudget(
    promise: Promise<LiveVenueFields | null>,
  ): Promise<LiveVenueFields | null> {
    let handle: unknown;
    const budget = new Promise<null>((resolve) => {
      handle = this.timers.setTimeout(() => resolve(null), this.fetchBudgetMs);
    });
    return Promise.race([promise, budget]).finally(() => {
      this.timers.clearTimeout(handle);
    });
  }
}

// ─── Snapshot mapping ───────────────────────────────────────────────────────

/**
 * Map a Gamma market row onto the live venue fields. Field-by-field
 * fail-soft: a malformed `outcomePrices` nulls `prices` without dropping
 * `volume`/`liquidity`, and vice versa.
 */
export function liveVenueFieldsFromSnapshot(
  snapshot: GammaMarketSnapshot,
  config: Record<string, unknown>,
  fetchedAtIso: string,
): LiveVenueFields {
  return {
    prices: venuePricePoints(snapshot, config),
    volume: finiteNumber(snapshot.volumeNum) ?? finiteNumber(snapshot.volume),
    liquidity:
      finiteNumber(snapshot.liquidityNum) ?? finiteNumber(snapshot.liquidity),
    fetched_at: fetchedAtIso,
  };
}

function venuePricePoints(
  snapshot: GammaMarketSnapshot,
  config: Record<string, unknown>,
): MarketVenuePricePoint[] | null {
  const prices = decimalArray(snapshot.outcomePrices);
  if (prices === null) return null;
  const labels =
    parseOutcomeLabels(
      typeof snapshot.outcomes === "string" ? snapshot.outcomes : undefined,
    ) ?? configOutcomeLabels(config);
  if (labels === null || labels.length !== prices.length) return null;
  return prices.map((price, index) => ({
    outcome: labels[index] as string,
    price,
  }));
}

function configOutcomeLabels(
  config: Record<string, unknown>,
): string[] | null {
  const labels = config.outcomes;
  if (
    Array.isArray(labels) &&
    labels.length > 0 &&
    labels.every((label) => typeof label === "string" && label.length > 0)
  ) {
    return labels as string[];
  }
  return null;
}

/** JSON-encoded string or plain array; null unless every entry is a finite number. */
function decimalArray(raw: unknown): number[] | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length === 0) return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const numbers: number[] = [];
  for (const entry of parsed) {
    const value = finiteNumber(entry);
    if (value === null) return null;
    numbers.push(value);
  }
  return numbers;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
