import type Database from "better-sqlite3";
import { projectCallRow, shouldExposePlaintext } from "./projections.js";

// ─── /v1/feed/today data shape ────────────────────────────────────────────────
// Live tape backing the Today page. Three rolling lists:
//   - accepted_recent: last N accepted calls (the entry tape)
//   - pending_resolution: calls past their t1 expiry but not yet resolved
//                         OR calls with the closest upcoming t1
//                         (the suspense surface)
//   - resolved_recent: last N resolutions (the outcome tape)
// All three return enough fields to render a card without a second fetch.
//
// P2 Phase E: committed-mode rows scrub side / asset_id / horizon_hours /
// confidence / rationale / strategy_tag / t1_estimate until a valid reveal;
// only commit_hash + acceptance_receipt_hash + privacy_mode are surfaced.

export interface TodayFeedRow {
  call_id: string;
  agent_id: string;
  agent_slug: string;
  agent_kind: string;
  privacy_mode: string;
  commit_hash?: string | null;
  acceptance_receipt_hash?: string | null;
  // Plaintext envelope — populated only when shouldExposePlaintext().
  side?: "BUY" | "SELL";
  asset_id?: string;
  horizon_hours?: number;
  confidence?: number;
  submitted_at?: string;
  accepted_at: string;
  status: string;
  // Resolved-only
  outcome?: string | null;
  signed_return?: string | null;
  call_score?: number | null;
  resolved_at?: string | null;
  // Pending-only — scrubbed when committed (would leak the horizon)
  t1_estimate?: string | null;
}

export interface TodayMover {
  agent_id: string;
  agent_slug: string;
  display_name: string;
  rank: number | null;
  verdict_score: number | null;
  delta_24h_calls: number;
  delta_24h_wins: number;
}

export interface TodayFeed {
  schema_version: 1;
  served_at: string;
  accepted_recent: TodayFeedRow[];
  pending_resolution: TodayFeedRow[];
  resolved_recent: TodayFeedRow[];
  movers: TodayMover[];
  totals: {
    accepted_24h: number;
    resolved_24h: number;
    wins_24h: number;
    losses_24h: number;
    void_24h: number;
  };
}

// Hand-tuned limits — tape is meant to be readable, not exhaustive.
const ACCEPTED_LIMIT = 20;
const PENDING_LIMIT = 20;
const RESOLVED_LIMIT = 20;
const MOVERS_LIMIT = 5;

export function getTodayFeed(db: Database.Database, now: Date = new Date()): TodayFeed {
  const nowIso = now.toISOString().replace(/\.\d+Z$/, "Z");

  // SQL pulls the FULL row including plaintext columns; the projection
  // helper scrubs committed rows until a valid reveal exists. One source
  // of truth so feed/api/SSE/RSS/MCP can't drift apart.
  const rawAccepted = db
    .prepare(
      `SELECT s.call_id, s.agent_id, a.display_slug AS agent_slug, a.kind AS agent_kind,
              s.side, s.asset_id, s.horizon_hours, s.confidence, s.rationale, s.strategy_tag,
              s.submitted_at, s.accepted_at, s.status,
              s.privacy_mode, s.commit_hash,
              ar.receipt_hash AS acceptance_receipt_hash,
              cr.reveal_hash_valid
       FROM submissions s
       JOIN agents a ON a.agent_id = s.agent_id
       LEFT JOIN receipts ar ON ar.call_id = s.call_id AND ar.kind = 'acceptance'
       LEFT JOIN call_reveals cr ON cr.call_id = s.call_id
       ORDER BY s.accepted_at DESC
       LIMIT ?`,
    )
    .all(ACCEPTED_LIMIT) as Array<Record<string, unknown> & { agent_slug: string; agent_kind: string; agent_id: string }>;
  const acceptedRows: TodayFeedRow[] = rawAccepted.map(toFeedRow);

  const rawPending = db
    .prepare(
      `SELECT s.call_id, s.agent_id, a.display_slug AS agent_slug, a.kind AS agent_kind,
              s.side, s.asset_id, s.horizon_hours, s.confidence, s.rationale, s.strategy_tag,
              s.submitted_at, s.accepted_at, s.status,
              s.privacy_mode, s.commit_hash,
              ar.receipt_hash AS acceptance_receipt_hash,
              cr.reveal_hash_valid
       FROM submissions s
       JOIN agents a ON a.agent_id = s.agent_id
       LEFT JOIN receipts ar ON ar.call_id = s.call_id AND ar.kind = 'acceptance'
       LEFT JOIN call_reveals cr ON cr.call_id = s.call_id
       WHERE s.status IN ('accepted','pending_t0','pending_t1')
       ORDER BY s.accepted_at DESC
       LIMIT ?`,
    )
    .all(PENDING_LIMIT) as Array<Record<string, unknown> & { agent_slug: string; agent_kind: string; agent_id: string }>;
  const pendingRows: TodayFeedRow[] = rawPending.map((row) => {
    const projected = toFeedRow(row);
    // t1_estimate leaks horizon, so only emit it when the row's
    // plaintext is exposed (not committed-pending).
    if (
      shouldExposePlaintext(
        (row.privacy_mode as string | null) ?? null,
        row.status as string,
        row.reveal_hash_valid as number | null,
      ) &&
      typeof row.horizon_hours === "number"
    ) {
      const t1 = new Date(
        Date.parse(row.accepted_at as string) +
          (row.horizon_hours as number) * 3600 * 1000,
      );
      projected.t1_estimate = t1.toISOString().replace(/\.\d+Z$/, "Z");
    }
    return projected;
  });

  const rawResolved = db
    .prepare(
      `SELECT s.call_id, s.agent_id, a.display_slug AS agent_slug, a.kind AS agent_kind,
              s.side, s.asset_id, s.horizon_hours, s.confidence, s.rationale, s.strategy_tag,
              s.submitted_at, s.accepted_at, s.status,
              s.privacy_mode, s.commit_hash,
              ar.receipt_hash AS acceptance_receipt_hash,
              r.outcome, r.signed_return, r.call_score, r.resolved_at,
              cr.reveal_hash_valid
       FROM t1_resolutions r
       JOIN submissions s ON s.call_id = r.call_id
       JOIN agents a ON a.agent_id = s.agent_id
       LEFT JOIN receipts ar ON ar.call_id = s.call_id AND ar.kind = 'acceptance'
       LEFT JOIN call_reveals cr ON cr.call_id = s.call_id
       ORDER BY r.resolved_at DESC
       LIMIT ?`,
    )
    .all(RESOLVED_LIMIT) as Array<Record<string, unknown> & { agent_slug: string; agent_kind: string; agent_id: string }>;
  const resolvedRows: TodayFeedRow[] = rawResolved.map(toFeedRow);

  // Movers: agents with the most resolved-call activity in the last 24h.
  // verdict_score and rank come from the live leaderboard; we only join the
  // 24h delta counts here.
  const moverRows = db
    .prepare(
      `SELECT a.agent_id, a.display_slug AS agent_slug, a.display_name,
              SUM(CASE WHEN r.outcome IN ('win','loss','void','oracle_unavailable') THEN 1 ELSE 0 END) AS resolved_24h,
              SUM(CASE WHEN r.outcome = 'win' THEN 1 ELSE 0 END) AS wins_24h
       FROM agents a
       JOIN submissions s ON s.agent_id = a.agent_id
       JOIN t1_resolutions r ON r.call_id = s.call_id
       WHERE r.resolved_at >= datetime('now', '-1 day')
         AND a.kind IN ('verified','benchmark')
       GROUP BY a.agent_id
       ORDER BY resolved_24h DESC, wins_24h DESC
       LIMIT ?`,
    )
    .all(MOVERS_LIMIT) as Array<{
    agent_id: string;
    agent_slug: string;
    display_name: string;
    resolved_24h: number;
    wins_24h: number;
  }>;

  const movers: TodayMover[] = moverRows.map((r) => ({
    agent_id: r.agent_id,
    agent_slug: r.agent_slug,
    display_name: r.display_name,
    rank: null, // populated below if the leaderboard has them
    verdict_score: null,
    delta_24h_calls: r.resolved_24h,
    delta_24h_wins: r.wins_24h,
  }));

  const totalsRow = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM submissions WHERE accepted_at >= datetime('now','-1 day')) AS accepted_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= datetime('now','-1 day')) AS resolved_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= datetime('now','-1 day') AND outcome='win') AS wins_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= datetime('now','-1 day') AND outcome='loss') AS losses_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= datetime('now','-1 day') AND outcome='void') AS void_24h`,
    )
    .get() as {
    accepted_24h: number;
    resolved_24h: number;
    wins_24h: number;
    losses_24h: number;
    void_24h: number;
  };

  return {
    schema_version: 1,
    served_at: nowIso,
    accepted_recent: acceptedRows,
    pending_resolution: pendingRows,
    resolved_recent: resolvedRows,
    movers,
    totals: totalsRow,
  };
}

/**
 * Map a raw SQL row to a TodayFeedRow, scrubbing committed-mode
 * plaintext from pending rows. agent_id + agent_slug + agent_kind
 * are passed through (they're public). Plaintext fields are dropped
 * when shouldExposePlaintext returns false.
 */
function toFeedRow(row: Record<string, unknown>): TodayFeedRow {
  const projected = projectCallRow(
    {
      call_id: row.call_id as string,
      status: row.status as string,
      accepted_at: row.accepted_at as string,
      privacy_mode: row.privacy_mode as string | null,
      commit_hash: row.commit_hash as string | null,
      acceptance_receipt_hash: row.acceptance_receipt_hash as string | null,
      side: row.side as string | null,
      asset_id: row.asset_id as string | null,
      horizon_hours: row.horizon_hours as number | null,
      confidence: row.confidence as number | null,
      rationale: row.rationale as string | null,
      strategy_tag: row.strategy_tag as string | null,
      outcome: row.outcome as string | null,
      call_score: row.call_score as number | null,
      signed_return: row.signed_return as string | null,
      resolved_at: row.resolved_at as string | null,
      submitted_at: row.submitted_at as string | null,
      reveal_hash_valid: row.reveal_hash_valid as number | null,
    },
    row.agent_slug as string,
  );
  return {
    ...projected,
    agent_id: row.agent_id as string,
    agent_slug: row.agent_slug as string,
    agent_kind: row.agent_kind as string,
    side: projected.side as TodayFeedRow["side"],
  } as TodayFeedRow;
}
