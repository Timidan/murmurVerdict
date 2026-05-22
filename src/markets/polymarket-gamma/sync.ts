/**
 * Polymarket sync ticker — drives the per-conditionId poll cadence the
 * resolver depends on.
 *
 * Why a ticker (RESEARCH §4, §7):
 *   The resolver itself polls per-call when a Polymarket call ages past
 *   its `resolve_after`. But Polymarket markets resolve in hours-to-weeks,
 *   and Gamma's 5-min CDN cache makes per-tick re-fetches wasteful for
 *   markets that aren't near `endDate`. The sync ticker maintains the
 *   `external_market_sync_state` row so we can adapt cadence per market:
 *
 *     · pre-endDate-1h     → poll every 5 min   (cheap; we're waiting)
 *     · endDate ±4h window → poll every 60 s    (high probability of resolution)
 *     · post-endDate+4h    → poll every 5 min   (slipped; we're chasing)
 *
 *   The ticker also fires two operator alerts:
 *     · `MARKET_DISAPPEARED`     — 24 consecutive 404s on a known conditionId
 *     · `MARKET_NEVER_RESOLVED`  — still unresolved 30 days past endDate
 *
 * NEVER throws from the tick body — the daemon's ticker harness expects
 * the inner function to handle its own errors.
 *
 * Cite: RESEARCH_polymarket_gamma_adapter.md §4, §6, §7, §8.
 */

import type Database from "better-sqlite3";
import { PolymarketGammaClient } from "./client.js";
import { ADAPTER_NAME } from "./index.js";

// ─── Cadence policy ─────────────────────────────────────────────────────────

const POLL_FAR_MS = 5 * 60 * 1000; // pre-endDate-1h
const POLL_NEAR_MS = 60 * 1000; // endDate ±4h
const POLL_SLIPPED_MS = 5 * 60 * 1000; // post-endDate+4h
const NEAR_WINDOW_PRE_MS = 60 * 60 * 1000; // 1h before endDate
const NEAR_WINDOW_POST_MS = 4 * 60 * 60 * 1000; // 4h after endDate
const NEVER_RESOLVED_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000;
const DISAPPEARED_THRESHOLD = 24;
const TICK_BUDGET = 50; // max rows scanned per tick (resolver-side budget)
// Resolved markets freeze for ~1y so they fall out of the per-tick
// selection without ever scheduling a poll.
const POLL_RESOLVED_FREEZE_MS = 365 * 24 * 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SyncStateRow {
  market_id: string;
  adapter_id: string;
  last_polled_at: string | null;
  last_observed_status: string | null;
  consecutive_failures: number;
  next_poll_at: string | null;
  last_error: string | null;
  alerted_disappeared_at: string | null;
  alerted_never_resolved_at: string | null;
  created_at: string;
}

export interface SyncTickerOpts {
  db: Database.Database;
  client?: PolymarketGammaClient;
  /** Override clock for deterministic smoke runs. */
  nowMs?: () => number;
  /** Operator-alert sink. Default: stderr log. */
  onAlert?: (alert: { code: string; market_id: string; details?: unknown }) => void;
  /** Per-tick row budget. */
  rowsPerTick?: number;
}

export interface SyncTickResult {
  scanned: number;
  polled: number;
  alerts: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function nowIsoFromMs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
}

function endDateMsForRow(
  db: Database.Database,
  market_id: string,
): number | null {
  const row = db
    .prepare("SELECT config_json FROM markets WHERE market_id = ?")
    .get(market_id) as { config_json: string } | undefined;
  if (!row) return null;
  try {
    const cfg = JSON.parse(row.config_json) as { endDate?: string };
    if (typeof cfg.endDate !== "string") return null;
    const ms = Date.parse(cfg.endDate);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

function conditionIdForRow(
  db: Database.Database,
  market_id: string,
): string | null {
  const row = db
    .prepare("SELECT config_json FROM markets WHERE market_id = ?")
    .get(market_id) as { config_json: string } | undefined;
  if (!row) return null;
  try {
    const cfg = JSON.parse(row.config_json) as { conditionId?: string };
    return typeof cfg.conditionId === "string" ? cfg.conditionId : null;
  } catch {
    return null;
  }
}

function pickPollIntervalMs(nowMs: number, endDateMs: number | null): number {
  if (endDateMs === null) return POLL_FAR_MS;
  const delta = endDateMs - nowMs;
  if (delta > NEAR_WINDOW_PRE_MS) return POLL_FAR_MS;
  if (delta >= -NEAR_WINDOW_POST_MS) return POLL_NEAR_MS;
  return POLL_SLIPPED_MS;
}

// ─── Tick ──────────────────────────────────────────────────────────────────

/**
 * One pass of the sync ticker. Walks up to `rowsPerTick` rows whose
 * `next_poll_at <= now` (or that lack a row entirely — first-time
 * markets that landed via lazy-insert), fetches them via the client,
 * and updates `external_market_sync_state` + fires alerts.
 *
 * Idempotent: re-running with the same clock + DB state produces the
 * same row writes. Never throws.
 */
export async function runPolymarketSyncTick(
  opts: SyncTickerOpts,
): Promise<SyncTickResult> {
  const db = opts.db;
  const client = opts.client ?? new PolymarketGammaClient();
  const nowMs = opts.nowMs ?? (() => Date.now());
  const onAlert =
    opts.onAlert ??
    ((a) => {
      console.warn(
        `[polymarket-sync] alert ${a.code} market=${a.market_id} details=${JSON.stringify(a.details ?? null)}`,
      );
    });
  const rowsPerTick = opts.rowsPerTick ?? TICK_BUDGET;
  const now = nowMs();
  const nowIso = nowIsoFromMs(now);

  // 1) Seed sync_state rows for every Polymarket markets entry that doesn't
  //    have one yet. Pure additive; the resolver's lazy-insert path creates
  //    the markets row, and this helper bridges it into sync_state on
  //    next tick.
  const unseeded = db
    .prepare(
      `SELECT m.market_id
         FROM markets m
    LEFT JOIN external_market_sync_state s
           ON s.market_id = m.market_id
        WHERE m.adapter_id = ?
          AND s.market_id IS NULL`,
    )
    .all(ADAPTER_NAME) as Array<{ market_id: string }>;
  const insertSeed = db.prepare(
    `INSERT INTO external_market_sync_state (
       market_id, adapter_id, last_polled_at, last_observed_status,
       consecutive_failures, next_poll_at, last_error,
       alerted_disappeared_at, alerted_never_resolved_at, created_at
     ) VALUES (?, ?, NULL, NULL, 0, NULL, NULL, NULL, NULL, ?)`,
  );
  for (const row of unseeded) insertSeed.run(row.market_id, ADAPTER_NAME, nowIso);

  // 2) Select due rows. `next_poll_at IS NULL` qualifies for "never polled."
  //    Resolved/disputed-final markets stop being scheduled here once
  //    `last_observed_status === 'resolved'`.
  const due = db
    .prepare(
      `SELECT market_id, adapter_id, last_polled_at, last_observed_status,
              consecutive_failures, next_poll_at, last_error,
              alerted_disappeared_at, alerted_never_resolved_at, created_at
         FROM external_market_sync_state
        WHERE adapter_id = ?
          AND (last_observed_status IS NULL OR last_observed_status <> 'resolved')
          AND (next_poll_at IS NULL OR next_poll_at <= ?)
        ORDER BY (next_poll_at IS NULL) DESC, next_poll_at ASC
        LIMIT ?`,
    )
    .all(ADAPTER_NAME, nowIso, rowsPerTick) as SyncStateRow[];

  let polled = 0;
  let alerts = 0;
  const updateRow = db.prepare(
    `UPDATE external_market_sync_state
        SET last_polled_at = ?,
            last_observed_status = ?,
            consecutive_failures = ?,
            next_poll_at = ?,
            last_error = ?,
            alerted_disappeared_at = COALESCE(alerted_disappeared_at, ?),
            alerted_never_resolved_at = COALESCE(alerted_never_resolved_at, ?)
      WHERE market_id = ?`,
  );

  for (const row of due) {
    const conditionId = conditionIdForRow(db, row.market_id);
    if (conditionId === null) {
      // Misconfigured markets row — no conditionId in config_json. Stay
      // 'error', back off the full 5min, and skip.
      const nextPoll = nowIsoFromMs(now + POLL_FAR_MS);
      updateRow.run(
        nowIso,
        "error",
        row.consecutive_failures + 1,
        nextPoll,
        "missing_conditionId",
        null,
        null,
        row.market_id,
      );
      continue;
    }
    const endDateMs = endDateMsForRow(db, row.market_id);
    let observedStatus: string;
    let failures: number;
    let lastError: string | null;
    try {
      const result = await client.fetchMarketByConditionId(conditionId);
      polled += 1;
      if (result.error === "http_404") {
        observedStatus = "404";
        failures = row.consecutive_failures + 1;
        lastError = "http_404";
      } else if (result.snapshot === null) {
        observedStatus = "error";
        failures = row.consecutive_failures + 1;
        lastError = result.error ?? "unknown";
      } else {
        // Stamp status from the snapshot itself.
        if (result.snapshot.closed === true) {
          if (result.snapshot.umaResolutionStatus === "resolved") {
            observedStatus = "resolved";
          } else {
            observedStatus = "disputed";
          }
        } else {
          observedStatus = "pending";
        }
        failures = 0;
        lastError = null;
      }
    } catch (err) {
      // Cardinal-rule safety net: the client is engineered not to throw,
      // but a future regression collapses here without aborting the tick.
      observedStatus = "error";
      failures = row.consecutive_failures + 1;
      lastError = `tick_threw:${err instanceof Error ? err.message : String(err)}`;
    }

    // Fire alerts BEFORE writing the row so the alert sink can read the
    // pre-update state if it wants. The COALESCE in the UPDATE locks the
    // alerted-at stamp in place once set.
    let alertDisappearedAt: string | null = null;
    let alertNeverResolvedAt: string | null = null;
    if (
      observedStatus === "404" &&
      failures >= DISAPPEARED_THRESHOLD &&
      row.alerted_disappeared_at === null
    ) {
      alertDisappearedAt = nowIso;
      alerts += 1;
      onAlert({
        code: "MARKET_DISAPPEARED",
        market_id: row.market_id,
        details: { consecutive_failures: failures, conditionId },
      });
    }
    if (
      observedStatus !== "resolved" &&
      endDateMs !== null &&
      now > endDateMs + NEVER_RESOLVED_DEADLINE_MS &&
      row.alerted_never_resolved_at === null
    ) {
      alertNeverResolvedAt = nowIso;
      alerts += 1;
      onAlert({
        code: "MARKET_NEVER_RESOLVED",
        market_id: row.market_id,
        details: {
          endDate: endDateMs ? nowIsoFromMs(endDateMs) : null,
          conditionId,
        },
      });
    }

    const nextPollMs =
      observedStatus === "resolved"
        ? now + POLL_RESOLVED_FREEZE_MS // resolved → freeze (next_poll_at far future)
        : now + pickPollIntervalMs(now, endDateMs);
    updateRow.run(
      nowIso,
      observedStatus,
      failures,
      nowIsoFromMs(nextPollMs),
      lastError,
      alertDisappearedAt,
      alertNeverResolvedAt,
      row.market_id,
    );
  }
  return { scanned: due.length, polled, alerts };
}

// ─── Long-running interval helper ──────────────────────────────────────────

/**
 * Schedule the sync tick on an interval. Returns a stop handle. The
 * tick body is guarded against overlap — if a previous tick is still
 * running when the next interval fires, the new tick is skipped (the
 * resolver harness uses the same posture in src/daemon/index.ts).
 */
export function startPolymarketSyncTicker(
  opts: SyncTickerOpts & { intervalMs?: number },
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 60_000;
  let running = false;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    runPolymarketSyncTick(opts)
      .catch((err) => {
        console.error(
          `[polymarket-sync] tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return {
    stop: () => clearInterval(handle),
  };
}
