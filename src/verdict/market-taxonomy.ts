import type { MarketRow } from "./repos/market-registry-repo.js";
import {
  parseMarketConfigJson,
} from "./market-adapter-config.js";
import {
  RESOLUTION_CLASSES,
  type ResolutionClass,
  type ScoringKind,
} from "./schema.js";

export type MarketSupportStatus = "live" | "reserved";
export type MarketPayoffModel =
  | "binary"
  | "categorical"
  | "scalar"
  | "range"
  | "ranking";
// No `price_oracle` model: outcomes come from a venue, a signed agent feed, or both.
export type MarketSettlementModel =
  | "venue_adapter"
  | "agent_feed"
  | "hybrid";

export interface MarketTaxonomyClass {
  resolution_class: ResolutionClass;
  label: string;
  support_status: MarketSupportStatus;
  payoff_model: MarketPayoffModel;
  settlement_model: MarketSettlementModel;
  /** A plain string, not {@link ScoringKind}, because reserved classes name scorers not yet implemented. */
  default_scoring_kind: string;
  compatible_market_kinds: string[];
  compatible_market_families: string[];
  compatible_adapters: string[];
}

export interface MarketTaxonomyAssignment extends MarketTaxonomyClass {
  classification_source: "config" | "market_kind" | "fallback";
}

export const MARKET_TAXONOMY_CLASSES: MarketTaxonomyClass[] = [
  {
    // Question class only ("will <asset> be above <level> by <time>?"); venue-settled, no price feed.
    resolution_class: "price_direction",
    label: "Price direction",
    support_status: "live",
    payoff_model: "binary",
    settlement_model: "venue_adapter",
    default_scoring_kind: "multinomial_brier",
    compatible_market_kinds: ["event_binary"],
    compatible_market_families: ["prediction-market-binary"],
    compatible_adapters: ["polymarket-gamma"],
  },
  {
    resolution_class: "event_binary",
    label: "Binary event",
    support_status: "live",
    payoff_model: "binary",
    settlement_model: "venue_adapter",
    default_scoring_kind: "multinomial_brier",
    compatible_market_kinds: ["event_binary"],
    compatible_market_families: ["prediction-market-binary"],
    compatible_adapters: ["polymarket-gamma"],
  },
  {
    resolution_class: "sports_match",
    label: "Sports match",
    support_status: "reserved",
    payoff_model: "binary",
    settlement_model: "venue_adapter",
    default_scoring_kind: "multinomial_brier",
    compatible_market_kinds: ["event_binary"],
    compatible_market_families: ["prediction-market-binary"],
    compatible_adapters: ["polymarket-gamma", "future-venue-adapter"],
  },
  {
    resolution_class: "price_threshold",
    label: "Price threshold",
    support_status: "reserved",
    payoff_model: "binary",
    settlement_model: "venue_adapter",
    default_scoring_kind: "threshold_hit",
    compatible_market_kinds: ["threshold_binary"],
    compatible_market_families: ["prediction-market-binary"],
    compatible_adapters: ["polymarket-gamma", "future-venue-adapter"],
  },
  {
    resolution_class: "range_prediction",
    label: "Range prediction",
    support_status: "reserved",
    payoff_model: "range",
    settlement_model: "venue_adapter",
    default_scoring_kind: "bracket_hit",
    compatible_market_kinds: ["range_bracket"],
    compatible_market_families: ["prediction-market-range"],
    compatible_adapters: ["future-venue-adapter"],
  },
  {
    resolution_class: "ranking_outcome",
    label: "Ranking outcome",
    support_status: "reserved",
    payoff_model: "ranking",
    settlement_model: "venue_adapter",
    default_scoring_kind: "rank_proximity_l1",
    compatible_market_kinds: ["ranking"],
    compatible_market_families: ["ranking-outcome"],
    compatible_adapters: ["future-venue-adapter"],
  },
  {
    resolution_class: "event_basket",
    label: "Event basket",
    support_status: "reserved",
    payoff_model: "categorical",
    settlement_model: "hybrid",
    default_scoring_kind: "multinomial_brier",
    compatible_market_kinds: ["event_basket"],
    compatible_market_families: ["prediction-market-basket"],
    compatible_adapters: ["future-venue-adapter"],
  },
  {
    resolution_class: "yield_or_savings",
    label: "Yield or savings",
    support_status: "reserved",
    payoff_model: "scalar",
    settlement_model: "agent_feed",
    default_scoring_kind: "rank_proximity_l1",
    compatible_market_kinds: ["yield_scalar"],
    compatible_market_families: ["yield-or-savings"],
    compatible_adapters: ["future-feed-adapter"],
  },
  {
    resolution_class: "risk_avoidance",
    label: "Risk avoidance",
    support_status: "reserved",
    payoff_model: "binary",
    settlement_model: "agent_feed",
    default_scoring_kind: "multinomial_brier",
    compatible_market_kinds: ["risk_binary"],
    compatible_market_families: ["risk-avoidance"],
    compatible_adapters: ["future-feed-adapter"],
  },
];

const TAXONOMY_BY_CLASS = new Map(
  MARKET_TAXONOMY_CLASSES.map((entry) => [entry.resolution_class, entry]),
);

export function marketTaxonomyForMarket(
  market: Pick<
    MarketRow,
    "adapter_id" | "market_family" | "market_kind" | "scoring_kind" | "config_json"
  >,
): MarketTaxonomyAssignment {
  const config = parseMarketConfigJson(market.config_json);
  const explicit = configuredResolutionClass(config);
  if (explicit) return assign(explicit, "config");

  // Default is event_binary; `config.resolution_class` above declares a finer class.
  if (
    market.market_kind === "event_binary" ||
    market.market_family === "prediction-market-binary"
  ) {
    return assign("event_binary", "market_kind");
  }

  return assign("event_binary", "fallback");
}

export function marketTaxonomyResponse(): {
  version: number;
  classes: MarketTaxonomyClass[];
  live_resolution_classes: ResolutionClass[];
  reserved_resolution_classes: ResolutionClass[];
} {
  return {
    version: 1,
    classes: MARKET_TAXONOMY_CLASSES,
    live_resolution_classes: MARKET_TAXONOMY_CLASSES
      .filter((entry) => entry.support_status === "live")
      .map((entry) => entry.resolution_class),
    reserved_resolution_classes: MARKET_TAXONOMY_CLASSES
      .filter((entry) => entry.support_status === "reserved")
      .map((entry) => entry.resolution_class),
  };
}

function assign(
  resolutionClass: ResolutionClass,
  classificationSource: MarketTaxonomyAssignment["classification_source"],
): MarketTaxonomyAssignment {
  const taxonomy = TAXONOMY_BY_CLASS.get(resolutionClass);
  if (!taxonomy) {
    throw new Error(`unknown market taxonomy class: ${resolutionClass}`);
  }
  return {
    ...taxonomy,
    classification_source: classificationSource,
  };
}

function configuredResolutionClass(
  config: Record<string, unknown>,
): ResolutionClass | null {
  const raw = config.resolution_class ?? config.question_class;
  if (typeof raw !== "string") return null;
  return (RESOLUTION_CLASSES as readonly string[]).includes(raw)
    ? (raw as ResolutionClass)
    : null;
}
