// Shared "is this market actually mintable?" gate for the two sealed-call
// entry points: the gateway preflight (before we spend an owner-key broadcast)
// and sealed-call acceptance (before we persist a call).
//
// It replaces the old `derivePolicyFromMarket` call both sites used to make.
// That helper answered a native-price question — "which Chainlink/Pyth feeds
// anchor this market?" — and returned `null` (i.e. "fine, carry on") for every
// external adapter, which meant the external path was effectively ungated.
//
// Murmur is a pure referee over external venues, so the question the gate has
// to answer is instead: does this row name a venue adapter this daemon can
// actually observe a resolution from, and is the row shaped the way that
// adapter's scoring expects? Five checks, all fail-closed:
//
//   1. `markets.adapter_id` is set and names a REGISTERED adapter.
//   2. `markets.market_family` is set and equals that adapter's own
//      `marketFamily`, so a row can't be dispatched to an adapter that
//      classifies it differently.
//   3. `markets.market_kind` is an externally-resolved kind (`event_binary`).
//   4. `markets.scoring_kind` is the universal payout-vector scorer
//      (`multinomial_brier`) — the only scorer left after the native
//      signed-return path was removed.
//   5. `markets.config_json` parses against the adapter's own
//      `marketConfigSchema`, so a row missing e.g. Polymarket's conditionId is
//      refused at submit time instead of sitting unresolvable in pending_t1.

import type { MarketRow } from "./repos/market-registry-repo.js";
import type { MarketMakerAdapter } from "../markets/types.js";
import { AdapterNotFoundError, getAdapterForMarket } from "./markets.js";
import { parseMarketConfigJson } from "./market-adapter-config.js";

/** Market kinds Murmur will mint new sealed calls on. */
export const MINTABLE_MARKET_KINDS = ["event_binary"] as const;
/** Scoring kinds Murmur can still score. */
export const MINTABLE_SCORING_KINDS = ["multinomial_brier"] as const;

export type ExternalMarketRejectionCause =
  | "adapter_missing"
  | "adapter_not_registered"
  | "market_family_missing"
  | "market_family_mismatch"
  | "market_kind_unsupported"
  | "scoring_kind_unsupported"
  | "market_config_invalid";

export class ExternalMarketValidationError extends Error {
  constructor(
    message: string,
    public readonly market_id: string,
    public readonly cause: ExternalMarketRejectionCause,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ExternalMarketValidationError";
  }
}

type GuardMarket = Pick<
  MarketRow,
  | "market_id"
  | "adapter_id"
  | "market_family"
  | "market_kind"
  | "scoring_kind"
  | "config_json"
  | "market_config_version"
>;

/**
 * Assert `market` is a live externally-resolved market this daemon can settle,
 * and return the adapter that owns it. Throws
 * {@link ExternalMarketValidationError} on the first failing check.
 *
 * Callers translate the typed `cause` into their own wire error; the guard
 * itself is transport-agnostic so the gateway preflight and the acceptance
 * path cannot drift apart.
 */
export function requireMintableExternalMarket(
  market: GuardMarket,
): MarketMakerAdapter {
  let adapter: MarketMakerAdapter;
  try {
    adapter = getAdapterForMarket(market as MarketRow);
  } catch (err) {
    if (err instanceof AdapterNotFoundError) {
      throw new ExternalMarketValidationError(
        err.message,
        market.market_id,
        err.adapter_id === null ? "adapter_missing" : "adapter_not_registered",
        { adapter_id: err.adapter_id },
      );
    }
    throw err;
  }

  if (!market.market_family) {
    throw new ExternalMarketValidationError(
      `market ${market.market_id} has no market_family; adapter '${adapter.name}' declares '${adapter.marketFamily}'`,
      market.market_id,
      "market_family_missing",
      { adapter_id: adapter.name, adapter_market_family: adapter.marketFamily },
    );
  }
  if (market.market_family !== adapter.marketFamily) {
    throw new ExternalMarketValidationError(
      `market ${market.market_id} market_family='${market.market_family}' but adapter '${adapter.name}' declares '${adapter.marketFamily}'`,
      market.market_id,
      "market_family_mismatch",
      {
        adapter_id: adapter.name,
        market_family: market.market_family,
        adapter_market_family: adapter.marketFamily,
      },
    );
  }

  if (!(MINTABLE_MARKET_KINDS as readonly string[]).includes(market.market_kind)) {
    throw new ExternalMarketValidationError(
      `market ${market.market_id} market_kind='${market.market_kind}' is not externally resolved (expected ${MINTABLE_MARKET_KINDS.join("|")})`,
      market.market_id,
      "market_kind_unsupported",
      { market_kind: market.market_kind },
    );
  }
  if (!(MINTABLE_SCORING_KINDS as readonly string[]).includes(market.scoring_kind)) {
    throw new ExternalMarketValidationError(
      `market ${market.market_id} scoring_kind='${market.scoring_kind}' is not scoreable (expected ${MINTABLE_SCORING_KINDS.join("|")})`,
      market.market_id,
      "scoring_kind_unsupported",
      { scoring_kind: market.scoring_kind },
    );
  }

  const parsed = adapter.marketConfigSchema.safeParse(
    parseMarketConfigJson(market.config_json),
  );
  if (!parsed.success) {
    throw new ExternalMarketValidationError(
      `market ${market.market_id} config_json does not satisfy adapter '${adapter.name}' marketConfigSchema`,
      market.market_id,
      "market_config_invalid",
      { adapter_id: adapter.name, issues: parsed.error.format() },
    );
  }

  return adapter;
}
