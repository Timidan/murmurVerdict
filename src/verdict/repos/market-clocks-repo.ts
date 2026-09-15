import type Database from "better-sqlite3";

import type { SeriesClock, SeriesClockConfig } from "../series-clock.js";

/**
 * Series and per-instance clock persistence. `market_clocks` is a snapshot written once at
 * registration and never updated, so a venue end-time change cannot retime an armed market.
 * Drift is detected against `derived_from_end_date_ms` and settled by delist and refund.
 */

export interface MarketSeriesRow {
  series_id: string;
  venue: string;
  display_name: string;
  window_seconds: number;
  submission_open_lead_sec: number;
  commit_margin_sec: number;
  delivery_budget_sec: number;
  embargo_sec: number;
  max_armed_per_call: number;
  status: "active" | "paused" | "delisted";
  created_at: string;
  updated_at: string;
}

export interface MarketClockRow {
  market_id: string;
  series_id: string;
  arm_close_at_ms: number;
  submission_open_at_ms: number;
  early_access_cutoff_at_ms: number;
  submission_close_at_ms: number;
  resolution_at_ms: number;
  public_reveal_at_ms: number;
  derived_from_end_date_ms: number;
  drift_detected_at: string | null;
  created_at: string;
}

function prep(db: Database.Database, sql: string) {
  return db.prepare(sql);
}

/** A series' cohort cap changed without a version bump; it would resize cohorts already sold. */
export class SeriesCapConflictError extends Error {
  constructor(
    readonly seriesId: string,
    readonly stored: number,
    readonly incoming: number,
  ) {
    super(
      `series ${seriesId} already exists with max_armed_per_call=${stored}, ` +
        `incoming ${incoming}. The cohort cap is immutable for a series id: ` +
        `eligibility reads the current series row, so changing it here would ` +
        `resize cohorts for calls already sold under the stored cap. Bump the ` +
        `series version so new markets bind to a new series id.`,
    );
    this.name = "SeriesCapConflictError";
  }
}

export class SeriesClockConflictError extends Error {
  constructor(
    readonly seriesId: string,
    readonly stored: SeriesClockConfig,
    readonly incoming: SeriesClockConfig,
  ) {
    super(
      `series ${seriesId} already exists with different clock constants ` +
        `(stored: ${JSON.stringify(stored)}, incoming: ${JSON.stringify(incoming)}). ` +
        `Clock constants are immutable for a series id: existing markets carry ` +
        `on-chain schedules derived from the stored values, so accepting new ones ` +
        `would compare live markets against a schedule they were never registered ` +
        `with and bulk-freeze them. Use a new series id instead.`,
    );
    this.name = "SeriesClockConflictError";
  }
}

export const marketSeriesRepo = {
  upsert(
    db: Database.Database,
    input: {
      series_id: string;
      venue: string;
      display_name: string;
      window_seconds: number;
      clock: SeriesClockConfig;
      max_armed_per_call: number;
      now: string;
    },
  ): void {
    // Fail closed on a clock-constant change: existing markets carry schedules from the stored values.
    const existing = marketSeriesRepo.get(db, input.series_id);
    if (existing) {
      const stored: SeriesClockConfig = {
        submissionOpenLeadSec: existing.submission_open_lead_sec,
        commitMarginSec: existing.commit_margin_sec,
        deliveryBudgetSec: existing.delivery_budget_sec,
        embargoSec: existing.embargo_sec,
      };
      const incoming = input.clock;
      const same =
        stored.submissionOpenLeadSec === incoming.submissionOpenLeadSec &&
        stored.commitMarginSec === incoming.commitMarginSec &&
        stored.deliveryBudgetSec === incoming.deliveryBudgetSec &&
        stored.embargoSec === incoming.embargoSec;
      if (!same) throw new SeriesClockConflictError(input.series_id, stored, incoming);
      if (existing.window_seconds !== input.window_seconds) {
        throw new SeriesClockConflictError(input.series_id, stored, incoming);
      }
      // The cohort cap is as immutable as the clock: eligibility reads the current series row.
      if (existing.max_armed_per_call !== input.max_armed_per_call) {
        throw new SeriesCapConflictError(
          input.series_id,
          existing.max_armed_per_call,
          input.max_armed_per_call,
        );
      }
    }

    prep(
      db,
      `INSERT INTO market_series (
         series_id, venue, display_name, window_seconds,
         submission_open_lead_sec, commit_margin_sec, delivery_budget_sec,
         embargo_sec, max_armed_per_call, status, created_at, updated_at)
       VALUES (
         @series_id, @venue, @display_name, @window_seconds,
         @submission_open_lead_sec, @commit_margin_sec, @delivery_budget_sec,
         @embargo_sec, @max_armed_per_call, 'active', @now, @now)
       ON CONFLICT(series_id) DO UPDATE SET
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`,
    ).run({
      series_id: input.series_id,
      venue: input.venue,
      display_name: input.display_name,
      window_seconds: input.window_seconds,
      submission_open_lead_sec: input.clock.submissionOpenLeadSec,
      commit_margin_sec: input.clock.commitMarginSec,
      delivery_budget_sec: input.clock.deliveryBudgetSec,
      embargo_sec: input.clock.embargoSec,
      max_armed_per_call: input.max_armed_per_call,
      now: input.now,
    });
  },

  get(db: Database.Database, seriesId: string): MarketSeriesRow | null {
    return (prep(db, `SELECT * FROM market_series WHERE series_id = ?`).get(
      seriesId,
    ) as MarketSeriesRow | undefined) ?? null;
  },

  setStatus(
    db: Database.Database,
    seriesId: string,
    status: MarketSeriesRow["status"],
    now: string,
  ): void {
    prep(
      db,
      `UPDATE market_series SET status = @status, updated_at = @now
       WHERE series_id = @series_id`,
    ).run({ series_id: seriesId, status, now });
  },
};

export const marketClocksRepo = {
  /** Write the immutable snapshot. INSERT-only: a second write would be a retime, so a duplicate throws. */
  insert(
    db: Database.Database,
    input: {
      market_id: string;
      series_id: string;
      clock: SeriesClock;
      derived_from_end_date_ms: number;
      now: string;
    },
  ): void {
    prep(
      db,
      `INSERT INTO market_clocks (
         market_id, series_id, arm_close_at_ms, submission_open_at_ms,
         early_access_cutoff_at_ms, submission_close_at_ms, resolution_at_ms,
         public_reveal_at_ms, derived_from_end_date_ms, drift_detected_at,
         created_at)
       VALUES (
         @market_id, @series_id, @arm_close_at_ms, @submission_open_at_ms,
         @early_access_cutoff_at_ms, @submission_close_at_ms, @resolution_at_ms,
         @public_reveal_at_ms, @derived_from_end_date_ms, NULL, @now)`,
    ).run({
      market_id: input.market_id,
      series_id: input.series_id,
      arm_close_at_ms: input.clock.armCloseAtMs,
      submission_open_at_ms: input.clock.submissionOpenAtMs,
      early_access_cutoff_at_ms: input.clock.earlyAccessCutoffAtMs,
      submission_close_at_ms: input.clock.submissionCloseAtMs,
      resolution_at_ms: input.clock.marketResolutionAtMs,
      public_reveal_at_ms: input.clock.publicRevealAtMs,
      derived_from_end_date_ms: input.derived_from_end_date_ms,
      now: input.now,
    });
  },

  get(db: Database.Database, marketId: string): MarketClockRow | null {
    return (prep(db, `SELECT * FROM market_clocks WHERE market_id = ?`).get(
      marketId,
    ) as MarketClockRow | undefined) ?? null;
  },

  /** Flag that the venue moved its end date. The schedule is never touched; delist/refund settles it. */
  flagDrift(
    db: Database.Database,
    marketId: string,
    now: string,
  ): boolean {
    const res = prep(
      db,
      `UPDATE market_clocks SET drift_detected_at = @now
       WHERE market_id = @market_id AND drift_detected_at IS NULL`,
    ).run({ market_id: marketId, now });
    return res.changes > 0;
  },

  /** True when the venue's current end date differs from the snapshot's. */
  hasDrifted(row: MarketClockRow, currentEndDateMs: number): boolean {
    return row.derived_from_end_date_ms !== currentEndDateMs;
  },
};
