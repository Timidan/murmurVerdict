import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

/**
 * The venue's durable market identity. Instances are ephemeral, so registrations and prices
 * key to the series. Identity is (venue, series_slug); the key is `'<venue>:<series_slug>'`.
 */
export interface VenueMarketSeriesRow {
  venue_series_id: string;
  venue: string;
  series_slug: string;
  series_title: string;
  /** Venue-declared category. Genuinely absent (null) for the 5m crypto series. */
  venue_category: string | null;
  source_adapter_id: string;
  created_at: string;
  updated_at: string;
}

export interface VenueMarketSeriesInput {
  venue: string;
  series_slug: string;
  series_title: string;
  venue_category: string | null;
  source_adapter_id: string;
  now: string;
}

export function venueSeriesId(venue: string, seriesSlug: string): string {
  return `${venue}:${seriesSlug}`;
}

export const venueMarketSeriesRepo = {
  venueSeriesId,

  /**
   * Upsert by identity (venue, series_slug). Title, category, and adapter are
   * refreshed from the venue; the id and created_at never move.
   */
  upsert(db: Database.Database, input: VenueMarketSeriesInput): VenueMarketSeriesRow {
    if (!input.venue.trim()) throw new Error("venue must not be empty");
    if (!input.series_slug.trim()) throw new Error("series_slug must not be empty");
    if (!input.series_title.trim()) throw new Error("series_title must not be empty");
    if (!input.source_adapter_id.trim()) {
      throw new Error("source_adapter_id must not be empty");
    }
    const id = venueSeriesId(input.venue, input.series_slug);
    prep(
      db,
      `INSERT INTO venue_market_series (
         venue_series_id, venue, series_slug, series_title,
         venue_category, source_adapter_id, created_at, updated_at)
       VALUES (
         @venue_series_id, @venue, @series_slug, @series_title,
         @venue_category, @source_adapter_id, @now, @now)
       ON CONFLICT(venue, series_slug) DO UPDATE SET
         series_title      = excluded.series_title,
         venue_category    = excluded.venue_category,
         source_adapter_id = excluded.source_adapter_id,
         updated_at        = excluded.updated_at`,
    ).run({
      venue_series_id: id,
      venue: input.venue,
      series_slug: input.series_slug,
      series_title: input.series_title,
      venue_category: input.venue_category,
      source_adapter_id: input.source_adapter_id,
      now: input.now,
    });
    // Non-null: the row was just written under this id.
    return this.get(db, id) as VenueMarketSeriesRow;
  },

  get(db: Database.Database, venueSeriesIdValue: string): VenueMarketSeriesRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM venue_market_series WHERE venue_series_id = ?`,
      ).get(venueSeriesIdValue) as VenueMarketSeriesRow | undefined) ?? null
    );
  },

  list(db: Database.Database): VenueMarketSeriesRow[] {
    return prep(
      db,
      `SELECT * FROM venue_market_series ORDER BY venue, series_slug`,
    ).all() as VenueMarketSeriesRow[];
  },
};
