import type Database from "better-sqlite3";

import type { SeriesClock, SeriesClockConfig } from "../series-clock.js";

/**
 * Series + per-instance clock persistence.
 *
 * `market_clocks` is a SNAPSHOT, written once at registration and never
 * updated. That is the whole point: the venue can move its own end time, and
 * re-deriving a schedule on read would silently retime a market that consumers
 * have already armed and providers have already submitted against. Drift is
 * detected by comparing the venue's current end date against
 * `derived_from_end_date_ms` and is resolved by delisting and refunding — never
 * by rebinding the schedule someone already paid against.
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

/**
 * A series' cohort cap changed without a version bump. Separate from
 * SeriesClockConflictError because the failure mode differs: a clock change
 * bulk-freezes live markets, while a cap change silently resizes cohorts that
 * subscribers already bought into.
 */
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
    // FAIL CLOSED on a clock-constant change. Silently keeping the stored
    // values (the previous behaviour) split a single series id across two
    // configurations: existing markets keep on-chain schedules from the old
    // constants while newly derived clocks use the new ones, so every existing
    // market fails its exact-schedule check and gets frozen.
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
      // The cohort cap is as immutable as the clock. Eligibility reads the
      // CURRENT series row, so an upsert that changed it retroactively resized
      // every cohort in the series — including calls already sold under the
      // old cap. Change it the same way a clock constant changes: bump the
      // series version so new markets bind to a new series.
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
  /**
   * Write the immutable snapshot. Deliberately INSERT-only with no upsert: a
   * second write for the same market would be a retime, which is the exact
   * failure this table exists to prevent. A duplicate throws.
   */
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

  /**
   * Record that the venue moved its end date away from what this snapshot was
   * derived from. Records only — the schedule itself is never touched, so a
   * flagged market is settled by the delist/refund path.
   */
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

  /**
   * Snapshots whose venue end date no longer matches. Cheap enough to compare
   * in the caller, but exposed here so drift scans do not have to re-derive.
   */
  hasDrifted(row: MarketClockRow, currentEndDateMs: number): boolean {
    return row.derived_from_end_date_ms !== currentEndDateMs;
  },
};
