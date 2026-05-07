import type Database from "better-sqlite3";
import {
  AgentKind,
  LeaderboardRow,
  LeaderboardTier,
  MIN_RESOLVED_CALLS_FOR_MAIN_TIER,
} from "./schema.js";
import { computeVerdictScore } from "./scoring.js";

// ─── Public API ──────────────────────────────────────────────────────────────

export interface LeaderboardOptions {
  /** Minimum kind that gets ranked at all (defaults to verified+benchmark). */
  includeKinds?: AgentKind[];
  /** Cap rows returned. Default 200. */
  limit?: number;
  /** "main" → only ranked agents. "provisional" → only sub-threshold. omit → both. */
  tier?: LeaderboardTier;
}

const DEFAULT_KINDS: AgentKind[] = ["verified", "benchmark"];

/**
 * Compute the leaderboard from current DB state. The query joins resolutions
 * to submissions to agents and aggregates per agent. Win-rate is computed only
 * over win/loss outcomes (void and oracle_unavailable do not count).
 */
export function getLeaderboard(
  db: Database.Database,
  opts: LeaderboardOptions = {},
): LeaderboardRow[] {
  const includeKinds = opts.includeKinds ?? DEFAULT_KINDS;
  const limit = opts.limit ?? 200;

  const placeholders = includeKinds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.agent_id, a.display_slug, a.display_name, a.kind,
              s.call_id, s.status,
              r.outcome, r.call_score, r.resolved_at
       FROM agents a
       JOIN submissions s ON s.agent_id = a.agent_id
       LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
       WHERE a.kind IN (${placeholders})
       ORDER BY a.agent_id, s.accepted_at`,
    )
    .all(...includeKinds) as Array<{
    agent_id: string;
    display_slug: string;
    display_name: string;
    kind: AgentKind;
    call_id: string;
    status: string;
    outcome: string | null;
    call_score: number | null;
    resolved_at: string | null;
  }>;

  type Agg = {
    agent_id: string;
    display_slug: string;
    display_name: string;
    kind: AgentKind;
    call_scores: (number | null)[];
    wins: number;
    losses: number;
    pending: number;
    last_resolved_at: string | null;
  };
  const byAgent = new Map<string, Agg>();
  for (const row of rows) {
    let a = byAgent.get(row.agent_id);
    if (!a) {
      a = {
        agent_id: row.agent_id,
        display_slug: row.display_slug,
        display_name: row.display_name,
        kind: row.kind,
        call_scores: [],
        wins: 0,
        losses: 0,
        pending: 0,
        last_resolved_at: null,
      };
      byAgent.set(row.agent_id, a);
    }
    if (row.outcome === "win") {
      a.wins++;
      a.call_scores.push(row.call_score);
    } else if (row.outcome === "loss") {
      a.losses++;
      a.call_scores.push(row.call_score);
    } else if (row.outcome === "void" || row.outcome === "oracle_unavailable") {
      a.call_scores.push(null);
    } else {
      // unresolved
      if (
        row.status === "accepted" ||
        row.status === "pending_t0" ||
        row.status === "pending_t1"
      ) {
        a.pending++;
      }
    }
    if (row.resolved_at) {
      if (!a.last_resolved_at || row.resolved_at > a.last_resolved_at) {
        a.last_resolved_at = row.resolved_at;
      }
    }
  }

  type Computed = LeaderboardRow & { _sortKey: number };
  const all: Computed[] = [];
  for (const a of byAgent.values()) {
    const score = computeVerdictScore(a.call_scores);
    const tier: LeaderboardTier =
      score.resolved_calls >= MIN_RESOLVED_CALLS_FOR_MAIN_TIER ? "main" : "provisional";
    const win_rate = a.wins + a.losses > 0 ? a.wins / (a.wins + a.losses) : null;
    all.push({
      agent_id: a.agent_id,
      display_slug: a.display_slug,
      display_name: a.display_name,
      kind: a.kind,
      tier,
      rank: null,
      verdict_score: score.verdict_score,
      resolved_calls: score.resolved_calls,
      win_rate,
      pending_calls: a.pending,
      last_resolved_at: a.last_resolved_at,
      _sortKey: score.verdict_score ?? -Infinity,
    });
  }

  // Filter by requested tier if given.
  const filtered = opts.tier ? all.filter((r) => r.tier === opts.tier) : all;

  // Rank only `main`-tier entries; provisional entries get rank=null.
  const main = filtered
    .filter((r) => r.tier === "main")
    .sort((a, b) => b._sortKey - a._sortKey);
  main.forEach((r, i) => {
    r.rank = i + 1;
  });
  const provisional = filtered
    .filter((r) => r.tier === "provisional")
    .sort((a, b) => b._sortKey - a._sortKey);

  const ordered = [...main, ...provisional].slice(0, limit).map(({ _sortKey, ...row }) => {
    void _sortKey;
    return row;
  });
  return ordered;
}

/**
 * 24h Verified Verdict Volume — count of `submission_accepted` events from
 * verified agents in the last 24 hours. v0.1 has no fees yet, so this number
 * is a count proxy until the billing/meter wiring lands.
 */
export function get24hVerifiedVolume(db: Database.Database): {
  count: number;
  since_iso: string;
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM usage_events u
       JOIN agents a ON a.agent_id = u.agent_id
       WHERE u.kind = 'submission_accepted'
         AND a.kind = 'verified'
         AND u.ts >= datetime('now', '-1 day')`,
    )
    .get() as { n: number } | undefined;
  return {
    count: row?.n ?? 0,
    since_iso: new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, "Z"),
  };
}
