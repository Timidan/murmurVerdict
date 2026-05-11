/**
 * Singleton {@link MarketMakerRegistry} for the verdict runtime.
 *
 * Mirrors the existing oracle-adapter registry pattern at
 * `src/integrations/oracles/registry.ts` — one level up. Concrete market-maker
 * adapters land as a sibling file plus a single `register()` call at module
 * load. Lookups dispatch by `name` and (optionally) `version`; the highest
 * semver-sorted version wins when `version` is omitted.
 *
 * This file owns the registration of the legacy native-price market path as
 * the FIRST {@link MarketMakerAdapter}. Post-Wave-4d, the resolver dispatches
 * BOTH t1 observation (`adapter.observeResolution(marketRef, ctx)`) AND
 * scoring (`scoreOutcomeVector(commitment, outcome, adapter)` →
 * `adapter.score(...)`) through this registry — the abstraction is
 * load-bearing, not decorative.
 *
 * Cite: V2_IMPLEMENTATION_PLAN.md "Phase 3 MarketMaker Adapter Framework",
 *       V2_DECISION_RECORD.md §2.4.
 */

import { MarketMakerRegistry, type MarketMakerAdapter } from "../../markets/types.js";
import { nativePriceAdapter } from "./native-price.js";

// ─── Module-singleton registry ──────────────────────────────────────────────

const registry = new MarketMakerRegistry();

// Bootstrap the legacy native-price adapter at module load. Adapters that
// land in later phases (Polymarket Gamma, UMA OOv3, Reality.eth, ...) call
// `registerMarketMaker(adapter)` from their own module.
registry.register(nativePriceAdapter);

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
