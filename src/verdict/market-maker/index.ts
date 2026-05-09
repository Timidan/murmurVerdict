/**
 * Market-maker entry point for code living under `src/verdict/`.
 *
 * Re-exports the canonical {@link MarketMakerAdapter} / {@link MarketMakerRegistry}
 * primitives from `src/markets/types.js`, plus the lifecycle types
 * ({@link MarketRef}, {@link AcceptanceReceipt}). Consumers inside the verdict
 * tree should import from this barrel rather than reaching across the source
 * tree boundary into `src/markets/`.
 *
 * The registry singleton + concrete `NativePriceAdapter` are exported from
 * sibling modules:
 *   - `./registry.js` → {@link getMarketMakerRegistry}, {@link registerMarketMaker}
 *   - `./native-price.js` → `NativePriceAdapter` instance + class
 *
 * Cite: V2_DECISION_RECORD §2.4 (interface), V2_IMPLEMENTATION_PLAN Phase 3.
 */

export type {
  AcceptanceReceipt,
  MarketMakerAdapter,
  MarketRef,
} from "../../markets/types.js";
export { MarketMakerRegistry } from "../../markets/types.js";
