// Shared venue-ticker wire types: the `/v2/venue/*` payloads. Types only, browser-safe.
// Kept out of venue-ticker.ts because that is a Node module the dashboard must not pull in.
// Renderers: `outcomes` are venue labels in payout-vector order, never map them to YES/NO;
// quote each outcome independently, never as 1 − the other; `venue_resolution` may repeat, upsert by `market_id`.

/** One outcome's live quote. Every price is a 0..1 probability, or null. */
export interface WireVenueOutcomeQuote {
  /** The venue's own outcome label, exactly as registered ("Up"/"Down"/…). */
  label: string;
  /** CLOB token id for this outcome (decimal string). */
  token_id: string;
  /** Mid of best bid/ask when both sides exist, else last trade, else null. */
  price: number | null;
  best_bid: number | null;
  best_ask: number | null;
  last_trade_price: number | null;
}

/**
 * Per-market freshness, computed from every outcome:
 * `warming`: at least one outcome has no venue answer yet (outranks `stale`). An empty book is an answer.
 * `stale`: all outcomes quoted, but at least one predates the last transport failure.
 * `live`: every outcome re-quoted since the last transport failure.
 * Tracked per field: a reconnect alone refreshes nothing, one outcome or field never vouches
 * for another, and null fields are exempt. A frame that fails validation refreshes nothing.
 */
export type WireVenueFreshness = "live" | "warming" | "stale";

export interface WireVenueMarketRow {
  market_id: string;
  outcomes: WireVenueOutcomeQuote[];
  /** ISO stamp of the last websocket frame applied, null while `warming`. */
  updated_at: string | null;
  freshness: WireVenueFreshness;
}

/** A well-formed condition id this daemon does not track. Carries no quotes. */
export interface WireVenueUnknownMarketRow {
  market_id: string;
  freshness: "unknown";
}

export interface WireVenueResolutionRow {
  market_id: string;
  /** Venue labels in the stored payout-vector order. */
  outcome_labels: string[];
  /** Normalized payout weights aligned to `outcome_labels` (sum 1). */
  outcome_prices: number[];
  /** The VENUE's resolution stamp (ISO), never the poll time. */
  resolved_at: string;
  /** Sole winning label, or null for a 50-50 / cancelled outcome. */
  winning_label: string | null;
  /** Which read produced it. */
  source: "gamma" | "clob";
}

/**
 * The `venue_tick` SSE frame body.
 * The first tick is a full snapshot: REPLACE the market map. Later ticks are deltas: merge by `market_id`.
 */
export interface WireVenueTickPayload {
  markets: WireVenueMarketRow[];
  /**
   * Delta frames only: ids the daemon stopped tracking. Delete each from the market map
   * AND the resolution map. An eviction-only frame (`markets: []`) is valid.
   */
  removed?: string[];
  /**
   * Snapshot frame only (possibly empty): every resolution the daemon holds.
   * REPLACE the resolution map with it, together with the market map.
   */
  resolutions?: WireVenueResolutionPayload[];
  /** ISO, millisecond precision. */
  ts: string;
}

/** The `venue_resolution` SSE frame body. Identical to the snapshot row. */
export type WireVenueResolutionPayload = WireVenueResolutionRow;

/** `GET /v2/venue/live` body. */
export interface WireVenueSnapshotResult {
  ts: string;
  markets: Array<WireVenueMarketRow | WireVenueUnknownMarketRow>;
  resolutions: WireVenueResolutionRow[];
  /** True when the caller asked for more ids than the cap and the tail was dropped. */
  truncated: boolean;
}
