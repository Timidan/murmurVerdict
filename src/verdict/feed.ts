import type Database from "better-sqlite3";

// ─── /v1/feed/today data shape ────────────────────────────────────────────────
// Live tape backing the Today page. Three rolling lists:
//   - accepted_recent: last N accepted calls (the entry tape)
//   - pending_resolution: calls past their t1 expiry but not yet resolved
//                         OR calls with the closest upcoming t1
//                         (the suspense surface)
//   - resolved_recent: last N resolutions (the outcome tape)
// All three return enough fields to render a card without a second fetch.

export interface TodayFeedRow {
  call_id: string;
  agent_id: string;
  agent_slug: string;
  agent_kind: string;
  side: "BUY" | "SELL";
  asset_id: string;
  horizon_hours: number;
  confidence: number;
  submitted_at: string;
  accepted_at: string;
  status: string;
  // Resolved-only
  outcome?: string | null;
  signed_return?: string | null;
  call_score?: number | null;
  resolved_at?: string | null;
  // Pending-only
  t1_estimate?: string | null; // accepted_at + horizon_hours, ISO
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

  const acceptedRows = db
    .prepare(
      `SELECT s.call_id, s.agent_id, a.display_slug AS agent_slug, a.kind AS agent_kind,
              s.side, s.asset_id, s.horizon_hours, s.confidence,
              s.submitted_at, s.accepted_at, s.status
       FROM submissions s
       JOIN agents a ON a.agent_id = s.agent_id
       ORDER BY s.accepted_at DESC
       LIMIT ?`,
    )
    .all(ACCEPTED_LIMIT) as TodayFeedRow[];

  const pendingRows = db
    .prepare(
      `SELECT s.call_id, s.agent_id, a.display_slug AS agent_slug, a.kind AS agent_kind,
              s.side, s.asset_id, s.horizon_hours, s.confidence,
              s.submitted_at, s.accepted_at, s.status
       FROM submissions s
       JOIN agents a ON a.agent_id = s.agent_id
       WHERE s.status IN ('accepted','pending_t0','pending_t1')
       ORDER BY datetime(s.accepted_at, '+' || s.horizon_hours || ' hours') ASC
       LIMIT ?`,
    )
    .all(PENDING_LIMIT) as TodayFeedRow[];
  for (const row of pendingRows) {
    const t1 = new Date(Date.parse(row.accepted_at) + row.horizon_hours * 3600 * 1000);
    row.t1_estimate = t1.toISOString().replace(/\.\d+Z$/, "Z");
  }

  const resolvedRows = db
    .prepare(
      `SELECT s.call_id, s.agent_id, a.display_slug AS agent_slug, a.kind AS agent_kind,
              s.side, s.asset_id, s.horizon_hours, s.confidence,
              s.submitted_at, s.accepted_at, s.status,
              r.outcome, r.signed_return, r.call_score, r.resolved_at
       FROM t1_resolutions r
       JOIN submissions s ON s.call_id = r.call_id
       JOIN agents a ON a.agent_id = s.agent_id
       ORDER BY r.resolved_at DESC
       LIMIT ?`,
    )
    .all(RESOLVED_LIMIT) as TodayFeedRow[];

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
