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

/** Global public leaderboard. Win rate counts only win/loss outcomes. */
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
  return getLeaderboardRowsForAgentIds(db, [agentId], opts).get(agentId) ?? null;
}

/**
 * Leaderboard rows for many agents in one pass. Ranks are global, not within `agentIds`.
 * Agents with no scoring facts are absent from the map; callers show them as unscored.
 */
export function getLeaderboardRowsForAgentIds(
  db: Database.Database,
  agentIds: readonly string[],
  opts: Omit<LeaderboardOptions, "limit"> = {},
): Map<string, LeaderboardRow> {
  const out = new Map<string, LeaderboardRow>();
  if (agentIds.length === 0) return out;
  const wanted = new Set(agentIds);
  for (const row of publicRankedLeaderboardRows(computeLeaderboardRows(db, opts))) {
    if (wanted.has(row.agent_id)) out.set(row.agent_id, row);
  }
  return out;
}

type ComputedLeaderboardRow = LeaderboardRow & { _sortKey: number };

function computeLeaderboardRows(
  db: Database.Database,
  opts: Omit<LeaderboardOptions, "limit"> = {},
): ComputedLeaderboardRow[] {
  const includeKinds = opts.includeKinds ?? DEFAULT_KINDS;

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
      nonDaemon: 0,
      daemonFallback: 0,
      genuineMisses: 0,
    };
    const revealDenominator =
      reveal.nonDaemon + reveal.daemonFallback + reveal.genuineMisses;
    // Global sorts by raw verdict_score; market/family boards use the lower bound. The smoke pins both.
    const { mainTier, sortKey } = resolveTierAndSort(summary, {
      preferLowerBound: false,
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
      // Fraction of reveals that didn't need the murmur fallback; an invalid decrypted value still counts as revealed.
      reveal_reliability:
        revealDenominator > 0 ? reveal.nonDaemon / revealDenominator : null,
      agent_reveals: reveal.nonDaemon,
      daemon_fallback_reveals: reveal.daemonFallback,
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

// Reveal buckets per agent from reveal_source. Anyone but the daemon fallback counts as non-daemon,
// including NULL reveal_source (pre-migration 057). `missed` is only set manually for irrecoverable calls.
function getRevealReliability(
  db: Database.Database,
): Map<
  string,
  { nonDaemon: number; daemonFallback: number; genuineMisses: number }
> {
  const rows = db
    .prepare(
      `SELECT s.agent_id,
              SUM(CASE WHEN f.reveal_status IN ('revealed','invalid')
                        AND (f.reveal_source IS NULL OR f.reveal_source != 'daemon_fallback')
                       THEN 1 ELSE 0 END) AS non_daemon,
              SUM(CASE WHEN f.reveal_status IN ('revealed','invalid')
                        AND f.reveal_source = 'daemon_fallback'
                       THEN 1 ELSE 0 END) AS daemon_fallback,
              SUM(CASE WHEN f.reveal_status = 'missed' THEN 1 ELSE 0 END) AS genuine_misses
       FROM fhenix_sealed_calls f
       JOIN submissions s ON s.call_id = f.call_id
       GROUP BY s.agent_id`,
    )
    .all() as Array<{
      agent_id: string;
      non_daemon: number | null;
      daemon_fallback: number | null;
      genuine_misses: number | null;
    }>;
  return new Map(
    rows.map((row) => [
      row.agent_id,
      {
        nonDaemon: row.non_daemon ?? 0,
        daemonFallback: row.daemon_fallback ?? 0,
        genuineMisses: row.genuine_misses ?? 0,
      },
    ]),
  );
}

/** Count of `submission_accepted` events in the last 24h from public-leaderboard kinds. A count, not fees. */
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
