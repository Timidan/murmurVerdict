import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import type {
  CallStatus,
  Outcome,
} from "../schema.js";

export interface ResolutionWriteInput {
  call_id: string;
  t1: string;
  // LEGACY PERSISTED COLUMNS. p1 / t1_feed / signed_return were the
  // native-price anchor evidence; migration 055 made them nullable and
  // Murmur no longer observes prices, so every row written today passes NULL.
  // The columns stay so historical rows remain readable — they are never
  // dropped.
  p1: string | null;
  t1_feed: string | null;
  signed_return: string | null;
  outcome: Outcome;
  call_score: number | null;
  resolved_at: string;
  resolved_outcome_json?: string | null;
  payout_vector_json?: string | null;
}

export interface FullCallResolutionView {
  submission: {
    call_id: string;
    agent_id: string;
    client_order_id: string;
    horizon_seconds: number;
    submitted_at: string;
    accepted_at: string;
    status: CallStatus;
    rationale: string | null;
    strategy_tag: string | null;
    privacy_mode: string | null;
    commit_hash: string | null;
    market_id: string | null;
    adapter_id: string | null;
    market_family: string | null;
  };
  t0: { t0: string; p0: string; feed: string } | null;
  resolution:
    | {
        t1: string;
        // Native-price price-anchor evidence; NULL for adapter /
        // oracle-unavailable resolutions (migration 055).
        p1: string | null;
        t1_feed: string | null;
        signed_return: string | null;
        outcome: string;
        call_score: number | null;
        resolved_at: string;
        resolved_outcome_json: string | null;
        payout_vector_json: string | null;
      }
    | null;
}

/**
 * Submission statuses that mark a call's verdict as final. Once a submission
 * reaches one of these, the t1_resolutions row should never be overwritten —
 * a concurrent oracle_unavailable / late adapter tick must not clobber a real
 * resolved/disputed/etc. verdict. The guard lives in the repo so all writers
 * inherit it; bypassing requires an explicit re-resolution path.
 */
export const TERMINAL_RESOLUTION_STATUSES = [
  "resolved",
  "disputed",
  "re_resolved",
  "rejected",
  "invalid_reveal",
  "missed_reveal",
] as const;

const TERMINAL_LIST_SQL = TERMINAL_RESOLUTION_STATUSES.map((s) => `'${s}'`).join(",");

export const resolutionsRepo = {
  /**
   * Insert or update the t1_resolutions row for a call. Returns `true` when a
   * row was written and `false` when the write was skipped because the
   * submission has already reached a terminal status — see
   * [[TERMINAL_RESOLUTION_STATUSES]]. The guard is enforced in SQL (single
   * statement, atomic vs the submissions.status read) to close the race
   * window where a concurrent writer could overwrite a finalized verdict.
   */
  setResolution(
    db: Database.Database,
    input: ResolutionWriteInput,
  ): boolean {
    const result = prep(
      db,
      `INSERT INTO t1_resolutions
       (call_id, t1, p1, t1_feed, signed_return, outcome, call_score, resolved_at,
        resolved_outcome_json, payout_vector_json)
       SELECT @call_id, @t1, @p1, @t1_feed, @signed_return, @outcome, @call_score, @resolved_at,
              @resolved_outcome_json, @payout_vector_json
       WHERE NOT EXISTS (
         SELECT 1 FROM submissions
         WHERE submissions.call_id = @call_id
           AND submissions.status IN (${TERMINAL_LIST_SQL})
       )
       ON CONFLICT(call_id) DO UPDATE SET
         t1 = excluded.t1, p1 = excluded.p1, t1_feed = excluded.t1_feed,
         signed_return = excluded.signed_return, outcome = excluded.outcome,
         call_score = excluded.call_score, resolved_at = excluded.resolved_at,
         resolved_outcome_json = excluded.resolved_outcome_json,
         payout_vector_json = excluded.payout_vector_json
       WHERE NOT EXISTS (
         SELECT 1 FROM submissions
         WHERE submissions.call_id = t1_resolutions.call_id
           AND submissions.status IN (${TERMINAL_LIST_SQL})
       )`,
    ).run({
      ...input,
      resolved_outcome_json: input.resolved_outcome_json ?? null,
      payout_vector_json: input.payout_vector_json ?? null,
    });
    return result.changes > 0;
  },

  loadFullCall(
    db: Database.Database,
    call_id: string,
  ): FullCallResolutionView | null {
    const subRow = prep(
      db,
      `SELECT call_id, agent_id, client_order_id,
              horizon_seconds,
              submitted_at, accepted_at, status,
              rationale, strategy_tag,
              privacy_mode, commit_hash, market_id,
              adapter_id, market_family
       FROM submissions
       WHERE call_id = ?`,
    ).get(call_id) as FullCallResolutionView["submission"] | undefined;
    if (!subRow) return null;
    const t0Row = prep(
      db,
      "SELECT t0, p0, feed FROM t0_anchors WHERE call_id = ?",
    ).get(call_id) as FullCallResolutionView["t0"] | undefined;
    const resRow = prep(
      db,
      `SELECT t1, p1, t1_feed, signed_return, outcome, call_score,
              resolved_at, resolved_outcome_json, payout_vector_json
       FROM t1_resolutions
       WHERE call_id = ?`,
    ).get(call_id) as NonNullable<FullCallResolutionView["resolution"]> | undefined;
    return {
      submission: {
        call_id: subRow.call_id,
        agent_id: subRow.agent_id,
        client_order_id: subRow.client_order_id,
        horizon_seconds: subRow.horizon_seconds,
        submitted_at: subRow.submitted_at,
        accepted_at: subRow.accepted_at,
        status: subRow.status,
        rationale: subRow.rationale,
        strategy_tag: subRow.strategy_tag,
        privacy_mode: subRow.privacy_mode,
        commit_hash: subRow.commit_hash,
        market_id: subRow.market_id,
        adapter_id: subRow.adapter_id,
        market_family: subRow.market_family,
      },
      t0: t0Row ?? null,
      resolution: resRow
        ? {
            t1: resRow.t1,
            p1: resRow.p1,
            t1_feed: resRow.t1_feed,
            signed_return: resRow.signed_return,
            outcome: resRow.outcome,
            call_score: resRow.call_score ?? null,
            resolved_at: resRow.resolved_at,
            resolved_outcome_json: resRow.resolved_outcome_json,
            payout_vector_json: resRow.payout_vector_json,
          }
        : null,
    };
  },
};
