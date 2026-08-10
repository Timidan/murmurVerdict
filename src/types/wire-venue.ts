// Shared venue-ticker wire types — the `/v2/venue/*` payloads.
//
// These live here, not in src/integrations/venue-ticker.ts, for one reason:
// the dashboard has to name them, and venue-ticker.ts is a NODE module. It
// imports `better-sqlite3`, `ws`, and the Gamma/CLOB HTTP clients at the top
// level, so a browser bundle that reaches for a type in that file drags the
// whole graph in behind it (or, with `import type`, works today and breaks the
// first time someone drops the `type` keyword).
//
// So: the payload shapes are declared here, `venue-ticker.ts` re-exports them
// as its own public wire types (nothing that already imports from there has to
// change), and `venue-ticker-surface.ts` imports them from here. The dashboard
// imports from `@shared/wire-venue` and from NOWHERE else.
//
// Browser-safe: types only, zero runtime, zero imports.
//
// The route contract these describe is documented in full at the top of
// src/integrations/venue-ticker-surface.ts. Three rules a renderer must honor:
//   · `outcomes` is NOT YES/NO — the labels are arbitrary venue strings already
//     in the stored payout-vector order. Render them; never map them.
//   · Both outcomes are quoted independently. Never derive one as 1 − the
//     other; a wide or one-sided book makes that wrong.
//   · `venue_resolution` is idempotent and may repeat across daemon restarts.
//     Upsert by `market_id`.

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
 * One field per market, but computed from EVERY outcome:
 *
 * `warming` — the venue has not answered for at least one outcome yet. Prices
 *             are still null. Outranks `stale`: an outcome that never had
 *             numbers has none to be stale about. Note that an EMPTY book is an
 *             answer — a market with no resting orders leaves `warming` with
 *             every price still null, which is the venue's real state and not a
 *             loading condition.
 * `stale`   — every outcome has quotes, but at least one of them predates a
 *             transport failure and has not been re-quoted since. What is on
 *             screen is the last thing seen and cannot be verified right now.
 * `live`    — EVERY outcome has been re-quoted since the last transport
 *             failure. The strictly strongest claim, and the only one that
 *             licenses showing the numbers without a caveat.
 *
 * Freshness is tracked per FIELD — `best_bid`, `best_ask`, `last_trade_price`
 * each carry their own — and reported per market. Three rules follow, and every
 * one of them exists because it was once violated:
 *
 *   · A reconnect does not make anything live — receiving the data does. An
 *     open socket says the transport works, not that these numbers are current.
 *   · One outcome never vouches for the other. Both sides are quoted
 *     independently, so after a drop the market stays `stale` until BOTH have
 *     been refreshed.
 *   · One FIELD never vouches for another. A `last_trade_price` print says
 *     where someone traded, not where the book now rests, so it refreshes the
 *     last trade and nothing else; a book that answers only its ask side
 *     refreshes only the ask. `live` means every number you can see arrived
 *     after the last transport failure.
 *
 * A field whose value is null is exempt: it renders as nothing, so it cannot
 * misinform, and it does not hold the row on `stale`. A frame whose values all
 * fail validation applies nothing and refreshes nothing — it can neither seed
 * an outcome nor clear any staleness.
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
 *
 * The FIRST tick on a connection carries the whole current cache — treat it as
 * a full snapshot and REPLACE the market map. Every later tick carries only the
 * markets that changed in that batch interval, so merge those by `market_id`.
 * A client that merges the first frame instead of replacing it will keep
 * showing markets the daemon has since stopped tracking.
 */
export interface WireVenueTickPayload {
  markets: WireVenueMarketRow[];
  /**
   * Market ids the daemon STOPPED tracking since the previous frame. Delete
   * each one from the market map AND from the resolution map.
   *
   * Present only on delta frames — the full-snapshot first frame needs no
   * tombstones, because replacing the map already drops everything absent.
   * Without acting on this, a long-lived tab accumulates every market the
   * daemon ever tracked, each frozen at its final price with a stale badge.
   *
   * Dropping the resolution too is safe and correct: eviction means the market
   * aged out of the daemon's 30-minute post-resolution lookback, so nothing on
   * screen still refers to it.
   *
   * An eviction-only frame (`markets: []`, `removed: [...]`) is valid and
   * includes the everything-evicted case.
   */
  removed?: string[];
  /**
   * Every resolution the daemon currently holds. Present ONLY on the
   * full-snapshot first frame (as an array, possibly empty); never on a delta.
   *
   * REPLACE the resolution map with it, exactly as you replace the market map.
   *
   * It rides the snapshot frame because the two maps have to be replaced
   * together or not at all. Replaying resolutions as separate `venue_resolution`
   * frames after the snapshot could only ADD, so a resolution the daemon
   * evicted while the client was disconnected had no way to leave the client —
   * it stayed on screen for the life of the tab. It also made the initial paint
   * one frame per settled market, which is what overflowed a slow reader's
   * queue on connect.
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
  /** True when the caller asked for more ids than the cap and the tail was
   *  dropped. */
  truncated: boolean;
}
