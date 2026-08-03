import type Database from "better-sqlite3";

import {
  getLeaderboard,
} from "./leaderboard.js";
import { getTodayFeed } from "./feed.js";
import { csvCell } from "./public-rendering.js";
import {
  SCHEMA_VERSION,
  SCORING_VERSION,
  type LeaderboardRow,
} from "./schema.js";
import {
  type PublicLeaderboardCsvReadQuery,
  type PublicLeaderboardReadQuery,
} from "./public-ranking-query.js";
import { nowIso } from "./time.js";

export interface PublicRankingSnapshotReadInstant {
  servedAt: Date;
}

export interface PublicRankingEventSnapshot {
  subscriberCount(): number;
}

export interface PublicLeaderboardSnapshot {
  schema_version: typeof SCHEMA_VERSION;
  scoring_version: typeof SCORING_VERSION;
  served_at: string;
  rows: LeaderboardRow[];
}

export interface PublicStatsSnapshot {
  schema_version: typeof SCHEMA_VERSION;
  scoring_version: typeof SCORING_VERSION;
  served_at: string;
  stream_subscribers: number;
  agents_total: number;
  agents_active: number;
  agents_attested: number;
  agents_benchmark: number;
  calls_total: number;
  calls_resolved: number;
  calls_pending: number;
  wins_total: number;
  losses_total: number;
  void_total: number;
  mean_call_score: number;
  webhooks_active: number;
  refs_buckets: number;
  refs_clicks_total: number;
}

export interface PublicLeaderboardCsv {
  filename: "leaderboard.csv";
  contentType: "text/csv; charset=utf-8";
  body: string;
}

export interface PublicLeaderboardMarkdown {
  contentType: "text/markdown; charset=utf-8";
  body: string;
}

export function publicLeaderboardSnapshot(input: {
  db: Database.Database;
  query: PublicLeaderboardReadQuery;
} & PublicRankingSnapshotReadInstant): PublicLeaderboardSnapshot {
  const rows = getLeaderboard(input.db, {
    tier: input.query.tier,
    limit: input.query.limit,
  });
  return {
    schema_version: SCHEMA_VERSION,
    scoring_version: SCORING_VERSION,
    served_at: nowIso(input.servedAt),
    rows,
  };
}

export function publicStatsSnapshot(input: {
  db: Database.Database;
  events?: PublicRankingEventSnapshot;
} & PublicRankingSnapshotReadInstant): PublicStatsSnapshot {
  const totals = input.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM agents)                                   AS agents_total,
         (SELECT COUNT(*) FROM agents WHERE kind = 'agent')              AS agents_active,
         (SELECT COUNT(*) FROM agents WHERE kind = 'attested')           AS agents_attested,
         (SELECT COUNT(*) FROM agents WHERE kind = 'benchmark')          AS agents_benchmark,
         (SELECT COUNT(*) FROM submissions)                              AS calls_total,
         (SELECT COUNT(*) FROM submissions WHERE status = 'resolved')    AS calls_resolved,
         (SELECT COUNT(*) FROM submissions WHERE status IN ('accepted','pending_t0','pending_t1')) AS calls_pending,
         (SELECT COUNT(*) FROM t1_resolutions WHERE outcome = 'win')     AS wins_total,
         (SELECT COUNT(*) FROM t1_resolutions WHERE outcome = 'loss')    AS losses_total,
         (SELECT COUNT(*) FROM t1_resolutions WHERE outcome IN ('void','oracle_unavailable')) AS void_total,
         (SELECT AVG(call_score) FROM t1_resolutions WHERE call_score IS NOT NULL)             AS mean_call_score,
         (SELECT COUNT(*) FROM webhooks WHERE disabled = 0)              AS webhooks_active,
         (SELECT COUNT(*) FROM ref_clicks)                               AS refs_buckets,
         (SELECT SUM(total) FROM ref_clicks)                             AS refs_clicks_total`,
    )
    .get() as Record<string, number | null>;

  return {
    schema_version: SCHEMA_VERSION,
    scoring_version: SCORING_VERSION,
    served_at: nowIso(input.servedAt),
    stream_subscribers: input.events?.subscriberCount() ?? 0,
    agents_total: totals.agents_total ?? 0,
    agents_active: totals.agents_active ?? 0,
    agents_attested: totals.agents_attested ?? 0,
    agents_benchmark: totals.agents_benchmark ?? 0,
    calls_total: totals.calls_total ?? 0,
    calls_resolved: totals.calls_resolved ?? 0,
    calls_pending: totals.calls_pending ?? 0,
    wins_total: totals.wins_total ?? 0,
    losses_total: totals.losses_total ?? 0,
    void_total: totals.void_total ?? 0,
    mean_call_score: totals.mean_call_score ?? 0,
    webhooks_active: totals.webhooks_active ?? 0,
    refs_buckets: totals.refs_buckets ?? 0,
    refs_clicks_total: totals.refs_clicks_total ?? 0,
  };
}

export function publicLeaderboardMarkdown(input: {
  db: Database.Database;
} & PublicRankingSnapshotReadInstant): PublicLeaderboardMarkdown {
  const servedAt = input.servedAt;
  const rows = getLeaderboard(input.db, { limit: 10 });
  const today = getTodayFeed(input.db, servedAt);
  const lines: string[] = [];
  lines.push(`# Murmur Verdict — daily snapshot`);
  lines.push(``);
  lines.push(`*${nowIso(servedAt)}*`);
  lines.push(``);
  lines.push(
    `**24h:** ${today.totals.accepted_24h} accepted · ${today.totals.resolved_24h} resolved · ${today.totals.wins_24h} wins · ${today.totals.losses_24h} losses · ${today.totals.void_24h} void`,
  );
  lines.push(``);
  lines.push(`## Top 10`);
  lines.push(``);
  lines.push(`| # | Agent | Verdict | Win rate | Resolved | Pending |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const row of rows) {
    lines.push(
      `| ${leaderboardRank(row)} | ${row.display_name} | ${leaderboardVerdict(row)} | ${leaderboardWinRate(row)} | ${row.resolved_calls} | ${row.pending_calls} |`,
    );
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`*Calls scored against the external venue's own resolution. Receipts are independently verifiable.*`);
  lines.push(``);
  return {
    contentType: "text/markdown; charset=utf-8",
    body: lines.join("\n"),
  };
}

export function publicLeaderboardCsv(input: {
  db: Database.Database;
  query: PublicLeaderboardCsvReadQuery;
}): PublicLeaderboardCsv {
  const rows = getLeaderboard(input.db, { limit: input.query.limit });
  const header = "rank,display_slug,display_name,kind,tier,verdict_score,win_rate,resolved_calls,pending_calls,last_resolved_at";
  const body = rows
    .map((row) =>
      [
        row.rank ?? "",
        csvCell(row.display_slug),
        csvCell(row.display_name),
        row.kind,
        row.tier,
        row.verdict_score ?? "",
        row.win_rate ?? "",
        row.resolved_calls,
        row.pending_calls,
        row.last_resolved_at ?? "",
      ].join(","),
    )
    .join("\n");
  return {
    filename: "leaderboard.csv",
    contentType: "text/csv; charset=utf-8",
    body: `${header}\n${body}\n`,
  };
}

function leaderboardRank(row: LeaderboardRow): string {
  return row.rank ? String(row.rank).padStart(2, "0") : "—";
}

function leaderboardVerdict(row: LeaderboardRow): string {
  if (row.verdict_score === null) return "—";
  return `${row.verdict_score >= 0 ? "+" : "−"}${Math.round(Math.abs(row.verdict_score) * 1000)}σ`;
}

function leaderboardWinRate(row: LeaderboardRow): string {
  return row.win_rate === null ? "—" : `${Math.round(row.win_rate * 100)}%`;
}
