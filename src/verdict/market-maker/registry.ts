/**
 * Singleton {@link MarketMakerRegistry}. Every adapter is an external venue; the resolver
 * dispatches observation and scoring through it, and an unregistered adapter cannot mint or
 * settle a call (see requireMintableExternalMarket). Omitting `version` picks the highest semver.
 */

import { MarketMakerRegistry, type MarketMakerAdapter } from "../../markets/types.js";
import { polymarketGammaAdapter } from "../../markets/polymarket-gamma/index.js";

// ─── Module-singleton registry ──────────────────────────────────────────────

const registry = new MarketMakerRegistry();

// Bootstrap the adapters that ship in this daemon. Registration is local and
// does not start any external poller; Polymarket network I/O happens only when
// an operator syncs/upserts a market or the resolver observes a listed row.
registry.register(polymarketGammaAdapter);

/** The process-wide registry. Do not cache it across modules; tests may swap it. */
export function getMarketMakerRegistry(): MarketMakerRegistry {
  return registry;
}

/** Register an adapter at boot; `grep -rn registerMarketMaker src/` lists every one. */
export function registerMarketMaker(adapter: MarketMakerAdapter): void {
  registry.register(adapter);
}
