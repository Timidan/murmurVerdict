/**
 * Market-maker adapter contract for external venues. Murmur never authors or
 * resolves markets: adapters observe the venue's resolution and score calls.
 */

import type { ZodSchema } from "zod";
import type { Commitment, MarketRef, Outcome } from "../verdict/markets-core.js";

export type { MarketRef } from "../verdict/markets-core.js";

/** Adapter-private resolver context (e.g. Polymarket's conditionId); each adapter narrows it. */
export type ObservationContext = Record<string, unknown>;

/**
 * Observes a venue's resolution and scores calls against it. The shared
 * external-market guard requires a market row's `market_family` to equal the
 * dispatching adapter's.
 */
export interface MarketMakerAdapter {
  /** Registry key, together with {@link version}. */
  name: string;
  /** Bump on commitment / market-config / scoring schema changes. */
  version: string;
  marketFamily:
    | "prediction-market-binary"
    | "social-pulse"
    | (string & {});
  commitmentSchema: ZodSchema<Commitment>;
  /** Shape of `markets.config_json`; opaque to core. */
  marketConfigSchema: ZodSchema<unknown>;
  /** `'pending'` / `'disputed'` are non-terminal; the resolver retries. */
  observeResolution(
    marketRef: MarketRef,
    ctx: ObservationContext,
  ): Promise<Outcome | "pending" | "disputed">;
  /**
   * Public reveal time (market end + embargo). Must equal the contract's
   * `publicRevealAt` exactly. Not a resolution horizon: see
   * {@link marketResolutionAt}. `null` falls back to accepted_at + horizon_seconds.
   */
  expectedRevealOpenAt?(input: {
    marketRef: MarketRef;
    config: Record<string, unknown>;
    acceptedAtMs: number;
    horizonSeconds: number;
  }): number | null;
  /**
   * When the venue decides the outcome; used for the commitment horizon.
   * `null` falls back to the reveal time, correct only with zero embargo.
   */
  marketResolutionAt?(input: {
    marketRef: MarketRef;
    config: Record<string, unknown>;
    acceptedAtMs: number;
    horizonSeconds: number;
  }): number | null;
  /** Labels for binary reveals, from `config_json.outcomes`. */
  outcomeLabels?(input: {
    marketRef: MarketRef;
    config: Record<string, unknown>;
  }): string[] | null;
  /** Resolver context built from `config_json`. */
  buildObservationContext?(input: {
    marketRef: MarketRef;
    config: Record<string, unknown>;
    market_id: string;
  }): ObservationContext;
  /** `call_score ∈ [0, 1]`. `components` is stored for replay, never read back. */
  score(
    c: Commitment,
    o: Outcome,
  ): { call_score: number | null; components?: unknown };
  /** Push channel for venues with event streams. Caller must call the returned unsubscribe on shutdown. */
  subscribeResolutions?(
    onResolved: (marketRef: MarketRef, o: Outcome) => void,
  ): () => void;
}

/** Adapters keyed by `name@version`; lookups without a version get the highest semver. */
export class MarketMakerRegistry {
  private adapters: Map<string, MarketMakerAdapter> = new Map();

  private static keyOf(name: string, version: string): string {
    return `${name}@${version}`;
  }

  /** Throws on a duplicate `(name, version)`: re-registering would shadow live receipts. */
  register(adapter: MarketMakerAdapter): void {
    const key = MarketMakerRegistry.keyOf(adapter.name, adapter.version);
    if (this.adapters.has(key)) {
      throw new Error(
        `MarketMakerRegistry: adapter '${adapter.name}@${adapter.version}' already registered`,
      );
    }
    this.adapters.set(key, adapter);
  }

  get(name: string, version?: string): MarketMakerAdapter | null {
    if (version !== undefined) {
      return this.adapters.get(MarketMakerRegistry.keyOf(name, version)) ?? null;
    }
    let best: MarketMakerAdapter | null = null;
    for (const adapter of this.adapters.values()) {
      if (adapter.name !== name) continue;
      if (best === null || compareSemver(adapter.version, best.version) > 0) {
        best = adapter;
      }
    }
    return best;
  }

  list(): MarketMakerAdapter[] {
    return Array.from(this.adapters.values());
  }

  byFamily(family: string): MarketMakerAdapter[] {
    return this.list().filter((a) => a.marketFamily === family);
  }
}

/** Numeric-segment semver compare; pre-release/build tags are ignored. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(/[-+]/, 1)[0]!.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(/[-+]/, 1)[0]!.split(".").map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) {
      // Non-numeric segment: fall back to string compare.
      const as = a.split(/[-+]/, 1)[0]!;
      const bs = b.split(/[-+]/, 1)[0]!;
      return as < bs ? -1 : as > bs ? 1 : 0;
    }
    if (ai !== bi) return ai - bi;
  }
  return 0;
}
