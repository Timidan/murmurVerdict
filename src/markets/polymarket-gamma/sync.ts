/**
 * Polymarket sync ticker. Keeps `external_market_sync_state` so each market
 * polls at a cadence set by its endDate (60s near it, 5 min otherwise), and
 * raises MARKET_DISAPPEARED (24 consecutive 404s) and MARKET_NEVER_RESOLVED
 * (30 days past endDate). The tick never throws.
 */

import type Database from "better-sqlite3";
import { PolymarketGammaClient } from "./client.js";
import { PolymarketClobClient } from "./clob-client.js";
import { clobMarketToOutcome } from "./clob-transform.js";
import { ADAPTER_NAME, getDefaultPolymarketClobClient } from "./index.js";
import {
  conditionIdForMarketConfig,
  endDateMsForMarketConfig,
  parseMarketConfigJson,
} from "../../verdict/market-adapter-config.js";

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
  /** Shared with the resolver so cache and breaker state span both. */
  clobClient?: PolymarketClobClient;
  /** Operation clock for poll scheduling and alert timestamps. */
  nowMs: () => number;
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
  return endDateMsForMarketConfig(row.config_json);
}

function conditionIdForRow(
  db: Database.Database,
  market_id: string,
): string | null {
  const row = db
    .prepare("SELECT config_json FROM markets WHERE market_id = ?")
    .get(market_id) as { config_json: string } | undefined;
  if (!row) return null;
  return conditionIdForMarketConfig(row.config_json);
}

function pickPollIntervalMs(nowMs: number, endDateMs: number | null): number {
  if (endDateMs === null) return POLL_FAR_MS;
  const delta = endDateMs - nowMs;
  if (delta > NEAR_WINDOW_PRE_MS) return POLL_FAR_MS;
  if (delta >= -NEAR_WINDOW_POST_MS) return POLL_NEAR_MS;
  return POLL_SLIPPED_MS;
}

/**
 * After a post-end Gamma 404, ask CLOB. 'resolved' / 'pending' mean Gamma
 * just dropped the market (expected); null keeps the 404 alert path.
 * Never throws.
 */
async function clobFallbackStatusForRow(input: {
  db: Database.Database;
  clobClient: PolymarketClobClient;
  market_id: string;
  conditionId: string;
}): Promise<"resolved" | "pending" | null> {
  try {
    const row = input.db
      .prepare("SELECT config_json FROM markets WHERE market_id = ?")
      .get(input.market_id) as { config_json: string } | undefined;
    if (!row) return null;
    const config = parseMarketConfigJson(row.config_json);
    const outcomes = Array.isArray(config.outcomes)
      ? config.outcomes.filter((label): label is string => typeof label === "string")
      : [];
    const clobTokenIds =
      config.clobTokenIds !== null &&
      typeof config.clobTokenIds === "object" &&
      !Array.isArray(config.clobTokenIds) &&
      Object.values(config.clobTokenIds).every((id) => typeof id === "string")
        ? (config.clobTokenIds as Record<string, string>)
        : undefined;
    const result = await input.clobClient.fetchMarketByConditionId(
      input.conditionId,
    );
    if (result.snapshot === null) return null;
    const mapped = clobMarketToOutcome({
      conditionId: input.conditionId,
      storedOutcomes: outcomes,
      storedClobTokenIds: clobTokenIds,
      endDate: typeof config.endDate === "string" ? config.endDate : null,
      snapshot: result.snapshot,
    });
    if (mapped.kind === "outcome") return "resolved";
    // Held-pending isn't a disappearance; other errors keep the alert.
    if (mapped.error === null || mapped.error.endsWith("_held_pending")) {
      return "pending";
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Tick ──────────────────────────────────────────────────────────────────

/** Last-resort CLOB client for standalone tick callers (see below). */
let fallbackClobClient: PolymarketClobClient | null = null;

/** One pass over up to `rowsPerTick` due rows. Idempotent; never throws. */
export async function runPolymarketSyncTick(
  opts: SyncTickerOpts,
): Promise<SyncTickResult> {
  const db = opts.db;
  const nowMs = opts.nowMs;
  const client = opts.client ?? new PolymarketGammaClient({ nowMs });
  const clobClient =
    opts.clobClient ??
    getDefaultPolymarketClobClient() ??
    // Memoized so standalone callers keep cache state; keeps the first caller's clock.
    (fallbackClobClient ??= new PolymarketClobClient({ nowMs }));
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

  // 1) Seed sync_state for Polymarket markets that have none.
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

  // 2) Due rows, never-polled first. Resolved markets are never due.
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
      // No conditionId in config_json: back off and skip.
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
        // Gamma drops 5-min markets after close; ask CLOB before counting a failure.
        const clobStatus =
          endDateMs !== null && now > endDateMs
            ? await clobFallbackStatusForRow({
                db,
                clobClient,
                market_id: row.market_id,
                conditionId,
              })
            : null;
        if (clobStatus === "resolved") {
          observedStatus = "resolved";
          failures = 0;
          lastError = null;
        } else if (clobStatus === "pending") {
          observedStatus = "pending";
          failures = 0;
          lastError = null;
        } else {
          observedStatus = "404";
          failures = row.consecutive_failures + 1;
          lastError = "http_404";
        }
      } else if (result.snapshot === null) {
        observedStatus = "error";
        failures = row.consecutive_failures + 1;
        lastError = result.error ?? "unknown";
      } else {
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
      // Safety net: the client shouldn't throw.
      observedStatus = "error";
      failures = row.consecutive_failures + 1;
      lastError = `tick_threw:${err instanceof Error ? err.message : String(err)}`;
    }

    // Alert once: COALESCE in the UPDATE keeps the first alerted-at stamp.
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
        ? now + POLL_RESOLVED_FREEZE_MS
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

/** Run the tick on an interval, skipping any tick that would overlap the previous one. */
export function startPolymarketSyncTicker(
  opts: SyncTickerOpts & { intervalMs?: number },
): { stop: () => Promise<void> } {
  const intervalMs = opts.intervalMs ?? 60_000;
  let running = false;
  let inFlightPromise: Promise<unknown> = Promise.resolve();
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    inFlightPromise = runPolymarketSyncTick(opts)
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
    stop: async () => {
      clearInterval(handle);
      await inFlightPromise;
    },
  };
}
