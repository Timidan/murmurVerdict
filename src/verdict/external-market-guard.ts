// Shared "is this market mintable?" gate for the gateway preflight and sealed-call acceptance.
// Fail-closed checks: registered adapter, matching market_family, `event_binary` kind,
// `multinomial_brier` scoring, and config_json valid against the adapter's schema.

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
 * Returns the market's adapter, or throws {@link ExternalMarketValidationError} on the first failing check.
 * Callers map the typed `cause` to their own wire error.
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
