/**
 * Singleton {@link MarketMakerRegistry} for the verdict runtime.
 *
 * Concrete market-maker adapters land as a sibling file plus a single
 * `register()` call at module load. Lookups dispatch by `name` and
 * (optionally) `version`; the highest semver-sorted version wins when
 * `version` is omitted.
 *
 * Every registered adapter is an EXTERNAL venue: Murmur never authors or
 * resolves a market itself. The resolver dispatches BOTH t1 observation
 * (`adapter.observeResolution(marketRef, ctx)`) AND scoring
 * (`scoreOutcomeVector(commitment, outcome, adapter)` → `adapter.score(...)`)
 * through this registry, so the abstraction is load-bearing, not decorative.
 * An adapter this daemon does not register cannot mint or settle a call —
 * see requireMintableExternalMarket in ../external-market-guard.ts.
 *
 * Cite: V2_IMPLEMENTATION_PLAN.md "Phase 3 MarketMaker Adapter Framework",
 *       V2_DECISION_RECORD.md §2.4.
 */

import { MarketMakerRegistry, type MarketMakerAdapter } from "../../markets/types.js";
import { polymarketGammaAdapter } from "../../markets/polymarket-gamma/index.js";

// ─── Module-singleton registry ──────────────────────────────────────────────

const registry = new MarketMakerRegistry();

// Bootstrap the adapters that ship in this daemon. Registration is local and
// does not start any external poller; Polymarket network I/O happens only when
// an operator syncs/upserts a market or the resolver observes a listed row.
registry.register(polymarketGammaAdapter);

/**
 * Returns the process-wide {@link MarketMakerRegistry} singleton. Callers MUST
 * NOT cache the registry across `import.meta.url` boundaries; treat it as a
 * runtime accessor so test harnesses can swap the implementation under their
 * feet (jest's `vi.mock` style is sufficient — no DI plumbing needed).
 */
export function getMarketMakerRegistry(): MarketMakerRegistry {
  return registry;
}

/**
 * Convenience for late-binding adapters at boot. Equivalent to
 * `getMarketMakerRegistry().register(adapter)` — exposed as a top-level
 * function so the registration call site stays terse and grep-able
 * (`grep -rn registerMarketMaker src/` enumerates every concrete adapter).
 */
export function registerMarketMaker(adapter: MarketMakerAdapter): void {
  registry.register(adapter);
}
