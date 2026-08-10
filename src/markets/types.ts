/**
 * Market-maker adapter contracts (v2 architecture, ADR §2.4).
 *
 * Cite: `.claude/architecture/V2_DECISION_RECORD.md` §2.4.
 *
 * Directory purpose: `src/markets/` hosts pluggable market-maker adapters for
 * EXTERNAL prediction venues (Polymarket, UMA OOv3, Reality.eth, ...). Each
 * adapter declares its commitment / market-config Zod schemas, observes the
 * resolution the venue published, and scores calls. Murmur never authors a
 * market and never decides an outcome itself, so there is no self-resolving
 * adapter here. Wave 4b retired the receipts subsystem; call + reveal +
 * resolution rows are the canonical evidence.
 *
 * Only the type primitives + an in-memory registry live here; concrete
 * adapters are siblings (`src/markets/polymarket-gamma/`, ...).
 */

import type { ZodSchema } from "zod";
import type { Commitment, MarketRef, Outcome } from "../verdict/markets-core.js";

// ─── MarketRef ───────────────────────────────────────────────────────────────

// FIX 7 — single source of truth. The duplicate definition this file used
// to carry has been replaced with a re-export from markets-core. Adapters
// importing `MarketRef` from this module continue to compile byte-identically
// — same name, same shape — but every consumer now agrees on one type.
export type { MarketRef } from "../verdict/markets-core.js";

// ─── ObservationContext ─────────────────────────────────────────────────────

/**
 * Per-call resolver context the adapter needs to compute a universal
 * {@link Outcome} from a {@link Commitment}. The universal {@link MarketRef}
 * alone is intentionally context-free (protocol + sourceId + configVersion);
 * an adapter that needs protocol-native lookup keys (Polymarket's conditionId,
 * a UMA request id, ...) surfaces them through this structured context, built
 * by its own `buildObservationContext`.
 *
 * The shape is intentionally permissive (`unknown`-cast at the boundary) so
 * each adapter can carry its own payload without polluting the universal
 * surface — the adapter's `observeResolution` body narrows via `as` /
 * structural checks before reading any field.
 */
export type ObservationContext = Record<string, unknown>;

// ─── MarketMakerAdapter (V2 §2.4) ────────────────────────────────────────────

/**
 * The trait every market-maker implements. Maps (MarketRef + ObservationContext
 * → Outcome) on resolve. `score` runs adapter-private scoring on top of the
 * shared {@link Commitment} / {@link Outcome} primitives.
 *
 * Wave 4d note: this interface used to carry `acceptCommitment` /
 * `verifyReceipt` / `AcceptanceReceipt`, leftover from the pre-Wave-4b
 * receipts model. The receipts subsystem was retired in Wave 4b; the
 * call + reveal + resolution rows are the canonical evidence. The adapter
 * surface is now exactly "observe resolution" + "score the resolved outcome"
 * — both of which the resolver dispatches through {@link MarketMakerRegistry}
 * so cross-adapter dispatch stays load-bearing.
 *
 * `marketFamily` is open-set so future families can land without a core bump,
 * but Murmur curates an allowlist (`'prediction-market-binary' |
 * 'social-pulse' | 'prediction-market-categorical'`) before permissionless
 * families are accepted (V2 §5 risk 4). The shared external-market guard
 * additionally requires a market row's stored `market_family` to EQUAL the
 * dispatching adapter's own value.
 */
export interface MarketMakerAdapter {
  /** Stable name. Used as the registry key alongside {@link version}. */
  name: string;
  /** Semver. Bumped on commitment / market-config / scoring schema changes. */
  version: string;
  /** Curated taxonomy bucket — see V2 §5 risk 4. */
  marketFamily:
    | "prediction-market-binary"
    | "social-pulse"
    | (string & {});
  /** Adapter-supplied validator over the universal {@link Commitment} shape. */
  commitmentSchema: ZodSchema<Commitment>;
  /** Shape of `markets.config_json` for this adapter. Kept opaque to core. */
  marketConfigSchema: ZodSchema<unknown>;
  /**
   * Pull the universal {@link Outcome} for `marketRef` given the resolver's
   * per-call context. `'pending'` / `'disputed'` are non-terminal — the
   * resolver loops until an {@link Outcome} is returned. Disputes are routed
   * through `src/verdict/disputes.ts` on subsequent re-resolutions.
   *
   * Concrete adapter context shapes are adapter-private; see e.g. the
   * narrowed Polymarket context in `src/markets/polymarket-gamma/index.ts`.
   */
  observeResolution(
    marketRef: MarketRef,
    ctx: ObservationContext,
  ): Promise<Outcome | "pending" | "disputed">;
  /**
   * Adapter-owned interpretation of `markets.config_json` for the PUBLIC
   * REVEAL time — when murmur unseals the verdict. This is the value the
   * acceptance guard compares against the on-chain schedule, so it must match
   * the contract's `publicRevealAt` exactly.
   *
   * For embargoed series this is market end + embargo, which is strictly LATER
   * than when the market itself resolves. Do NOT use it as a resolution
   * horizon — see {@link marketResolutionAt}.
   *
   * Returning `null` falls back to accepted_at + horizon_seconds.
   */
  expectedRevealOpenAt?(input: {
    marketRef: MarketRef;
    config: Record<string, unknown>;
    acceptedAtMs: number;
    horizonSeconds: number;
  }): number | null;
  /**
   * Adapter-owned MARKET RESOLUTION time — when the venue determines the
   * outcome. Distinct from {@link expectedRevealOpenAt}: reveal is embargoed
   * past resolution, so a single value would make a prediction's commitment
   * claim the market resolves at murmur's reveal deadline.
   *
   * Used for the commitment horizon. Returning `null` falls back to the
   * reveal-open value, which is correct only when the embargo is zero.
   */
  marketResolutionAt?(input: {
    marketRef: MarketRef;
    config: Record<string, unknown>;
    acceptedAtMs: number;
    horizonSeconds: number;
  }): number | null;
  /**
   * Adapter-owned labels for binary reveals. Keeps `config_json.outcomes`
   * parsing behind the adapter seam instead of leaking it into API/watchers.
   */
  outcomeLabels?(input: {
    marketRef: MarketRef;
    config: Record<string, unknown>;
  }): string[] | null;
  /**
   * Adapter-owned resolution context built from `markets.config_json`.
   * Resolver code should not need to know adapter-private keys like
   * Polymarket's `conditionId`.
   */
  buildObservationContext?(input: {
    marketRef: MarketRef;
    config: Record<string, unknown>;
    market_id: string;
  }): ObservationContext;
  /**
   * Score a commitment against its resolution. `call_score ∈ [0, 1]`.
   * `components` is adapter-private (e.g. a confidence-weighted breakdown);
   * the resolver stamps it on the resolution row for replay but never
   * consumes it directly.
   */
  score(
    c: Commitment,
    o: Outcome,
  ): { call_score: number | null; components?: unknown };
  /**
   * Optional push channel. Adapters with native event streams (UMA OO,
   * Reality.eth, CTF events, Chainlink Functions callbacks) override this
   * to short-circuit the resolver-tick poll loop. Returns an unsubscribe
   * function — caller is responsible for invoking it on shutdown.
   */
  subscribeResolutions?(
    onResolved: (marketRef: MarketRef, o: Outcome) => void,
  ): () => void;
}

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * In-memory market-maker registry.
 *
 * Version-aware: the same adapter `name` may be registered under multiple
 * `version` values during a rolling schema migration. Lookups default to
 * the highest semver-sorted version.
 */
export class MarketMakerRegistry {
  private adapters: Map<string, MarketMakerAdapter> = new Map();

  /** Internal composite key: `name@version`. */
  private static keyOf(name: string, version: string): string {
    return `${name}@${version}`;
  }

  /**
   * Register an adapter. Throws if `(name, version)` is already taken — the
   * intended migration path is "register vNext alongside vCurrent, swap
   * default reads, then unregister vCurrent." Re-registering the same key
   * would silently shadow live receipts, which is a footgun.
   */
  register(adapter: MarketMakerAdapter): void {
    const key = MarketMakerRegistry.keyOf(adapter.name, adapter.version);
    if (this.adapters.has(key)) {
      throw new Error(
        `MarketMakerRegistry: adapter '${adapter.name}@${adapter.version}' already registered`,
      );
    }
    this.adapters.set(key, adapter);
  }

  /**
   * Look up an adapter by `name` and optional `version`. When `version` is
   * omitted, returns the highest-semver registered version. Returns `null`
   * when no matching adapter is registered.
   */
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

  /** All registered adapters across every (name, version) pair. */
  list(): MarketMakerAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** All registered adapters whose `marketFamily` matches `family` exactly. */
  byFamily(family: string): MarketMakerAdapter[] {
    return this.list().filter((a) => a.marketFamily === family);
  }
}

/**
 * Lexicographic-by-numeric-segment semver comparison. Returns
 * `> 0` when `a > b`, `< 0` when `a < b`, `0` when equal.
 *
 * Lenient: pre-release tags ('-rc.1' / '+build') are stripped before compare.
 * Adequate for adapter-version dispatch; not a full semver parser.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(/[-+]/, 1)[0]!.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(/[-+]/, 1)[0]!.split(".").map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) {
      // Fall back to string compare on non-numeric segments.
      const as = a.split(/[-+]/, 1)[0]!;
      const bs = b.split(/[-+]/, 1)[0]!;
      return as < bs ? -1 : as > bs ? 1 : 0;
    }
    if (ai !== bi) return ai - bi;
  }
  return 0;
}
