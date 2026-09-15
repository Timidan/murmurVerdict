// Shared REST wire types: markets registry, taxonomy, oracle and venue snapshots.
// Browser-safe; see wire-agent.ts.

export type WireMarketStatus = "draft" | "listed" | "frozen" | "retired";

export type WireMarketResolutionClass =
  | "event_binary"
  | "event_basket"
  | "price_threshold"
  | "price_direction"
  | "range_prediction"
  | "sports_match"
  | "ranking_outcome"
  | "yield_or_savings"
  | "risk_avoidance";

export type WireMarketSupportStatus = "live" | "reserved";

export type WireMarketPayoffModel =
  | "binary"
  | "categorical"
  | "scalar"
  | "range"
  | "ranking";

export type WireMarketSettlementModel =
  | "venue_adapter"
  | "agent_feed"
  | "hybrid";

export type WireMarketOracleHealth = "ok" | "warn" | "fail";

export interface WireMarketOracleRef {
  role: "primary" | "fallback";
  oracle_id: string;
  status: WireMarketStatus | "missing";
  kind: string | null;
  adapter: string | null;
  chain: string | null;
  asset_id: string | null;
  asset_match: boolean | null;
}

export interface WireMarketOracleSummary {
  health: WireMarketOracleHealth;
  primary: WireMarketOracleRef;
  fallback: WireMarketOracleRef | null;
}

export interface WireMarketTaxonomyClass {
  resolution_class: WireMarketResolutionClass;
  label: string;
  support_status: WireMarketSupportStatus;
  payoff_model: WireMarketPayoffModel;
  settlement_model: WireMarketSettlementModel;
  default_scoring_kind: string;
  compatible_market_kinds: string[];
  compatible_market_families: string[];
  compatible_adapters: string[];
}

export interface WireMarketTaxonomyAssignment extends WireMarketTaxonomyClass {
  classification_source: "config" | "market_kind" | "fallback";
}

export interface WireMarketTaxonomyResponse {
  version: number;
  classes: WireMarketTaxonomyClass[];
  live_resolution_classes: WireMarketResolutionClass[];
  reserved_resolution_classes: WireMarketResolutionClass[];
}

/** One outcome's live venue price (0..1). May be a decimal string; coerce before math. */
export interface WireMarketVenuePricePoint {
  outcome: string;
  price: number | string;
}

/** Live venue snapshot on venue-adapter market rows. Null fields when the venue is down. */
export interface WireMarketVenueSnapshot {
  prices: WireMarketVenuePricePoint[] | null;
  volume: number | null;
  liquidity: number | null;
  end_date: string | null;
  url: string | null;
  fetched_at: string | null;
}

/**
 * The market's immutable schedule. Epoch milliseconds, UTC.
 * Absent means no submission window exists, not that it has passed.
 */
export interface WireMarketClock {
  series_id: string;
  arm_close_at_ms: number;
  submission_open_at_ms: number;
  early_access_cutoff_at_ms: number;
  submission_close_at_ms: number;
  resolution_at_ms: number;
  public_reveal_at_ms: number;
}

/** One market row from GET /v1/markets. Extra registry columns pass through the index signature. */
export interface WireMarketRow {
  market_id: string; // venue conditionId, e.g. "0x1f2e…"
  asset_id: string; // venue synthetic, e.g. "polymarket:event"
  market_kind: string; // "event_binary"
  horizon_seconds: number;
  primary_oracle_id: string;
  fallback_oracle_id: string | null;
  void_band: string; // decimal as string
  status: WireMarketStatus;
  market_config_version: number;
  /** Provider key ("polymarket-gamma"). */
  adapter_id?: string;
  market_taxonomy?: WireMarketTaxonomyAssignment;
  oracles?: WireMarketOracleSummary;
  /** Venue-adapter markets ONLY — live odds/volume snapshot. */
  venue?: WireMarketVenueSnapshot;
  /** Scheduled markets ONLY — the window instants the matrix groups by. */
  clock?: WireMarketClock;
  [extra: string]: unknown;
}
