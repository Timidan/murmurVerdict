import type Database from "better-sqlite3";
import type { AgentKind } from "./schema.js";
import {
  leaderboardCallSummary,
  type LeaderboardCallFact,
} from "./leaderboard-call-summary.js";
import {
  DEFAULT_KINDS,
  publicRankedLeaderboardRows,
  rankedLeaderboardRows,
  resolveTierAndSort,
  type LeaderboardOptions,
} from "./leaderboard-shared.js";

export interface MarketLeaderboardOptions extends LeaderboardOptions {
  /** Restrict to one market_id. Required for getLeaderboardForMarket. */
  market_id: string;
}

export interface AgentMarketRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
  market_id: string;
  verdict_score: number | null;
  verdict_score_lb: number | null;
  resolved_calls: number;
  pending_calls: number;
  win_rate: number | null;
  last_resolved_at: string | null;
  /** True iff resolved_calls >= MAIN tier threshold AT THIS MARKET. */
  market_main_tier: boolean;
  /**
   * Chronological resolved-call score series for this market (nulls for
   * void / oracle_unavailable), powering the per-market trend sparkline.
   */
  call_scores: (number | null)[];
}

export interface AgentMarketGridOptions {
  limit?: number;
}

type ComputedAgentMarketRow = AgentMarketRow & { _sortKey: number };

/**
 * Per-market leaderboard. Same aggregation as global getLeaderboard but
 * scoped to one market_id. Provisional flag uses the market's own
 * resolved-count threshold -- an agent with 200 ETH-1h calls but 3 BTC-1h
 * calls is provisional on BTC-1h.
 *
 * P3 reframe rationale (Codex audit): "An agent with 200 BTC_24H calls
 * and 3 SOL_5M calls should not appear as a SOL_5M leader." -- this query
 * makes that physical.
 */
export function getLeaderboardForMarket(
  db: Database.Database,
  opts: MarketLeaderboardOptions,
): AgentMarketRow[] {
  const limit = opts.limit ?? 200;
  return publicRankedLeaderboardRows(
    computeMarketLeaderboardRows(db, opts).slice(0, limit),
  );
}

function computeMarketLeaderboardRows(
  db: Database.Database,
  opts: Omit<MarketLeaderboardOptions, "limit">,
): ComputedAgentMarketRow[] {
  const includeKinds = opts.includeKinds ?? DEFAULT_KINDS;
  const placeholders = includeKinds.map(() => "?").join(",");

  const rows = db
    .prepare(
      `SELECT a.agent_id, a.display_slug, a.display_name, a.kind,
              s.call_id, s.status, s.market_id,
              r.outcome, r.call_score, r.resolved_at
       FROM agents a
       JOIN submissions s ON s.agent_id = a.agent_id
       LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
       WHERE a.kind IN (${placeholders})
         AND s.market_id = ?
       ORDER BY a.agent_id, s.accepted_at`,
    )
    .all(...includeKinds, opts.market_id) as Array<{
    agent_id: string;
    display_slug: string;
    display_name: string;
    kind: AgentKind;
    call_id: string;
    status: string;
    market_id: string;
    outcome: string | null;
    call_score: number | null;
    resolved_at: string | null;
  }>;

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

  const computed: ComputedAgentMarketRow[] = [];
  for (const a of byAgent.values()) {
    const summary = leaderboardCallSummary(a.calls);
    // Per-market boards rank by the lower-bound score (preferLowerBound: true).
    const { mainTier, sortKey } = resolveTierAndSort(summary, {
      preferLowerBound: true,
    });
    computed.push({
      agent_id: a.agent_id,
      display_slug: a.display_slug,
      display_name: a.display_name,
      kind: a.kind,
      market_id: opts.market_id,
      verdict_score: summary.verdict_score,
      verdict_score_lb: summary.verdict_score_lb,
      resolved_calls: summary.resolved_calls,
      pending_calls: summary.pending_calls,
      win_rate: summary.win_rate,
      last_resolved_at: summary.last_resolved_at,
      market_main_tier: mainTier,
      call_scores: summary.call_scores,
      _sortKey: sortKey,
    });
  }

  return rankedLeaderboardRows(computed, {
    tier: opts.tier,
    isMain: (row) => row.market_main_tier,
  });
}

/**
 * Heat grid: every (market_id, score) pair this agent has resolved at least
 * one call on. Sub-threshold cells are still returned; UI distinguishes
 * provisional via market_main_tier.
 */
export function getAgentMarketGrid(
  db: Database.Database,
  agent_id: string,
  opts: AgentMarketGridOptions = {},
): AgentMarketRow[] {
  const rows = db
    .prepare(
      `SELECT a.agent_id, a.display_slug, a.display_name, a.kind,
              s.call_id, s.status, s.market_id,
              r.outcome, r.call_score, r.resolved_at
       FROM agents a
       JOIN submissions s ON s.agent_id = a.agent_id
       LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
       WHERE a.agent_id = ?
         AND s.market_id IS NOT NULL
       ORDER BY s.market_id, s.accepted_at`,
    )
    .all(agent_id) as Array<{
    agent_id: string;
    display_slug: string;
    display_name: string;
    kind: AgentKind;
    call_id: string;
    status: string;
    market_id: string;
    outcome: string | null;
    call_score: number | null;
    resolved_at: string | null;
  }>;

  type Agg = {
    market_id: string;
    calls: LeaderboardCallFact[];
    profile: {
      agent_id: string;
      display_slug: string;
      display_name: string;
      kind: AgentKind;
    };
  };
  const byMarket = new Map<string, Agg>();
  for (const row of rows) {
    let a = byMarket.get(row.market_id);
    if (!a) {
      a = {
        market_id: row.market_id,
        calls: [],
        profile: {
          agent_id: row.agent_id,
          display_slug: row.display_slug,
          display_name: row.display_name,
          kind: row.kind,
        },
      };
      byMarket.set(row.market_id, a);
    }
    a.calls.push(row);
  }

  const computed = Array.from(byMarket.values()).map((a) => {
    const summary = leaderboardCallSummary(a.calls);
    const { mainTier, sortKey } = resolveTierAndSort(summary, {
      preferLowerBound: true,
    });
    return {
      agent_id: a.profile.agent_id,
      display_slug: a.profile.display_slug,
      display_name: a.profile.display_name,
      kind: a.profile.kind,
      market_id: a.market_id,
      verdict_score: summary.verdict_score,
      verdict_score_lb: summary.verdict_score_lb,
      resolved_calls: summary.resolved_calls,
      pending_calls: summary.pending_calls,
      win_rate: summary.win_rate,
      last_resolved_at: summary.last_resolved_at,
      market_main_tier: mainTier,
      call_scores: summary.call_scores,
      _sortKey: sortKey,
    };
  });
  const limit = opts.limit;
  return publicRankedLeaderboardRows(
    typeof limit === "number" ? computed.slice(0, limit) : computed,
  );
}
