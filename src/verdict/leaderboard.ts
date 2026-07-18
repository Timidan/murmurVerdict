import type Database from "better-sqlite3";
import {
  AgentKind,
  LeaderboardRow,
  LeaderboardTier,
  MIN_RESOLVED_CALLS_FOR_MARKETPLACE_TIER,
} from "./schema.js";
import { leaderboardCallSummary } from "./leaderboard-call-summary.js";
import {
  queryLeaderboardCallFacts,
  type LeaderboardCallFact,
} from "./leaderboard-call-facts.js";
import {
  DEFAULT_KINDS,
  publicRankedLeaderboardRows,
  rankedLeaderboardRows,
  resolveTierAndSort,
  type LeaderboardOptions,
} from "./leaderboard-shared.js";
import { publicActivityWindow } from "./public-activity-window.js";

export type { LeaderboardOptions } from "./leaderboard-shared.js";
export {
  getAgentMarketGrid,
  getLeaderboardForMarket,
  getLeaderboardForMarkets,
} from "./leaderboard-markets.js";
export type {
  AgentMarketRow,
  MarketGridEntry,
  MarketLeaderboardOptions,
  MarketsGridOptions,
} from "./leaderboard-markets.js";
export {
  getCrossFamilyLeaderboard,
  getLeaderboardForFamily,
} from "./leaderboard-families.js";
export type {
  AgentCrossFamilyRow,
  AgentFamilyRow,
  CrossFamilyOptions,
  FamilyLeaderboardOptions,
} from "./leaderboard-families.js";

/**
 * Compute the global public leaderboard from current DB state. The query joins
 * resolutions to submissions to agents and aggregates per agent. Win-rate is
 * computed only over win/loss outcomes.
 */
export function getLeaderboard(
  db: Database.Database,
  opts: LeaderboardOptions = {},
): LeaderboardRow[] {
  const limit = opts.limit ?? 200;
  return publicRankedLeaderboardRows(
    computeLeaderboardRows(db, opts).slice(0, limit),
  );
}

export function getLeaderboardRowForAgent(
  db: Database.Database,
  agentId: string,
  opts: Omit<LeaderboardOptions, "limit"> = {},
): LeaderboardRow | null {
  const row = computeLeaderboardRows(db, opts).find(
    (candidate) => candidate.agent_id === agentId,
  );
  return row ? publicRankedLeaderboardRows([row])[0] : null;
}

type ComputedLeaderboardRow = LeaderboardRow & { _sortKey: number };

function computeLeaderboardRows(
  db: Database.Database,
  opts: Omit<LeaderboardOptions, "limit"> = {},
): ComputedLeaderboardRow[] {
  const includeKinds = opts.includeKinds ?? DEFAULT_KINDS;

  // Read shared scoring facts from the leaderboard-call-facts seam; this Module
  // keeps its own global projection (lower-bound sort, marketplace tier).
  const rows = queryLeaderboardCallFacts(db, { kind: "global", includeKinds });

  type Agg = {
    agent_id: string;
    display_slug: string;
    display_name: string;
    kind: AgentKind;
    calls: LeaderboardCallFact[];
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
        calls: [],
      };
      byAgent.set(row.agent_id, a);
    }
    a.calls.push(row);
  }

  const revealReliability = getRevealReliability(db);
  const all: ComputedLeaderboardRow[] = [];
  for (const a of byAgent.values()) {
    const summary = leaderboardCallSummary(a.calls);
    const reveal = revealReliability.get(a.agent_id) ?? {
      total: 0,
      revealed: 0,
      failed: 0,
    };
    // Global board sorts by the lower-bound score so lucky streaks do not
    // outrank steadier agents with stronger confidence-adjusted records.
    const { mainTier, sortKey } = resolveTierAndSort(summary, {
      preferLowerBound: true,
    });
    const tier: LeaderboardTier = mainTier ? "main" : "provisional";
    const marketplace_eligible =
      summary.resolved_calls >= MIN_RESOLVED_CALLS_FOR_MARKETPLACE_TIER &&
      summary.verdict_score_lb !== null &&
      summary.verdict_score_lb >= 0;
    all.push({
      agent_id: a.agent_id,
      display_slug: a.display_slug,
      display_name: a.display_name,
      kind: a.kind,
      tier,
      rank: null,
      verdict_score: summary.verdict_score,
      verdict_score_lb: summary.verdict_score_lb,
      resolved_calls: summary.resolved_calls,
      win_rate: summary.win_rate,
      pending_calls: summary.pending_calls,
      last_resolved_at: summary.last_resolved_at,
      reveal_reliability: reveal.total > 0 ? reveal.revealed / reveal.total : null,
      agent_reveals: reveal.revealed,
      daemon_fallback_reveals: 0,
      marketplace_eligible,
      operator_trust_score: null,
      stake_at_risk: null,
      _sortKey: sortKey,
    });
  }

  return rankedLeaderboardRows(all, {
    tier: opts.tier,
    isMain: (row) => row.tier === "main",
    onMainRank: (row, index) => {
      row.rank = index + 1;
    },
  });
}

function getRevealReliability(
  db: Database.Database,
): Map<string, { total: number; revealed: number; failed: number }> {
  const rows = db
    .prepare(
      `SELECT s.agent_id,
              SUM(CASE WHEN f.reveal_status = 'revealed' THEN 1 ELSE 0 END) AS revealed,
              SUM(CASE WHEN f.reveal_status IN ('invalid','missed') THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN f.reveal_status IN ('revealed','invalid','missed') THEN 1 ELSE 0 END) AS total
       FROM fhenix_sealed_calls f
       JOIN submissions s ON s.call_id = f.call_id
       GROUP BY s.agent_id`,
    )
    .all() as Array<{
      agent_id: string;
      revealed: number | null;
      failed: number | null;
      total: number | null;
    }>;
  return new Map(
    rows.map((row) => [
      row.agent_id,
      {
        total: row.total ?? 0,
        revealed: row.revealed ?? 0,
        failed: row.failed ?? 0,
      },
    ]),
  );
}

/**
 * 24h Verdict Volume: count of `submission_accepted` events in the last
 * 24 hours from kinds that surface on the public leaderboard. v0.1 has no
 * fees yet, so this number is a count proxy until billing/meter wiring lands.
 */
export function get24hVerifiedVolume(db: Database.Database, now: Date): {
  count: number;
  since_iso: string;
} {
  const activityWindow = publicActivityWindow(now);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM usage_events u
       JOIN agents a ON a.agent_id = u.agent_id
       WHERE u.kind = 'submission_accepted'
         AND a.kind IN ('agent', 'attested')
         AND u.ts >= ?`,
    )
    .get(activityWindow.since_iso) as { n: number } | undefined;
  return {
    count: row?.n ?? 0,
    since_iso: activityWindow.since_iso,
  };
}
