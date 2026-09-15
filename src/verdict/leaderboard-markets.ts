import type Database from "better-sqlite3";
import type { AgentKind, LeaderboardTier } from "./schema.js";
import { leaderboardCallSummary } from "./leaderboard-call-summary.js";
import {
  queryLeaderboardCallFacts,
  type LeaderboardCallFact,
  type LeaderboardCallFactRow,
} from "./leaderboard-call-facts.js";
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
  /** The market's own question — see WireAgentMarketRow.market_label. */
  market_label?: string | null;
}

export interface AgentMarketGridOptions {
  limit?: number;
}

type ComputedAgentMarketRow = AgentMarketRow & { _sortKey: number };

/**
 * Per-market leaderboard: the global aggregation scoped to one market_id.
 * The tier threshold counts only this market's calls (200 ETH-1h calls + 3 BTC-1h is provisional on BTC-1h).
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

/** One agent's profile + its scoring facts scoped to a single market. */
interface MarketAgentAgg {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
  calls: LeaderboardCallFact[];
}

/** Scores one agent's calls at one market. Per-market boards rank by the lower-bound score. */
function computeMarketAgentRow(
  agg: MarketAgentAgg,
  market_id: string,
): ComputedAgentMarketRow {
  const summary = leaderboardCallSummary(agg.calls);
  const { mainTier, sortKey } = resolveTierAndSort(summary, {
    preferLowerBound: true,
  });
  return {
    agent_id: agg.agent_id,
    display_slug: agg.display_slug,
    display_name: agg.display_name,
    kind: agg.kind,
    market_id,
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
}

function foldMarketAgentRow(
  byAgent: Map<string, MarketAgentAgg>,
  row: LeaderboardCallFactRow,
): void {
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

function computeMarketLeaderboardRows(
  db: Database.Database,
  opts: Omit<MarketLeaderboardOptions, "limit">,
): ComputedAgentMarketRow[] {
  const includeKinds = opts.includeKinds ?? DEFAULT_KINDS;

  const rows = queryLeaderboardCallFacts(db, {
    kind: "market",
    includeKinds,
    market_id: opts.market_id,
  });

  const byAgent = new Map<string, MarketAgentAgg>();
  for (const row of rows) foldMarketAgentRow(byAgent, row);

  const computed = Array.from(byAgent.values()).map((a) =>
    computeMarketAgentRow(a, opts.market_id),
  );

  return rankedLeaderboardRows(computed, {
    tier: opts.tier,
    isMain: (row) => row.market_main_tier,
  });
}

export interface MarketsGridOptions {
  /** Per-market cap on returned rows. Default 3 (the grid's top-3 cell). */
  limitPerMarket?: number;
  includeKinds?: AgentKind[];
  tier?: LeaderboardTier;
}

/** One market's ranked top rows — the batched grid's per-market entry. */
export interface MarketGridEntry {
  market_id: string;
  agents: AgentMarketRow[];
}

/**
 * Markets grid: one facts read across every market, regrouped by market_id and ranked like
 * getLeaderboardForMarket. Markets with no scoring call are omitted.
 */
export function getLeaderboardForMarkets(
  db: Database.Database,
  opts: MarketsGridOptions = {},
): MarketGridEntry[] {
  const includeKinds = opts.includeKinds ?? DEFAULT_KINDS;
  const limitPerMarket = opts.limitPerMarket ?? 3;

  const rows = queryLeaderboardCallFacts(db, {
    kind: "markets_grid",
    includeKinds,
  });

  const byMarket = new Map<string, Map<string, MarketAgentAgg>>();
  for (const row of rows) {
    // SQL already filters null market_id; this narrows the type.
    if (row.market_id === null) continue;
    let agents = byMarket.get(row.market_id);
    if (!agents) {
      agents = new Map();
      byMarket.set(row.market_id, agents);
    }
    foldMarketAgentRow(agents, row);
  }

  const entries: MarketGridEntry[] = [];
  for (const [market_id, agents] of byMarket) {
    const computed = Array.from(agents.values()).map((a) =>
      computeMarketAgentRow(a, market_id),
    );
    const ranked = rankedLeaderboardRows(computed, {
      tier: opts.tier,
      isMain: (row) => row.market_main_tier,
    });
    entries.push({
      market_id,
      agents: publicRankedLeaderboardRows(ranked.slice(0, limitPerMarket)),
    });
  }
  return entries;
}

/**
 * Market labels from each market's config_json: `question` (window-specific) before `series_title`.
 * Chunked at 300 ids per statement to stay under SQLite's bound-parameter cap.
 */
function marketLabels(
  db: Database.Database,
  marketIds: string[],
): Map<string, string> {
  const labels = new Map<string, string>();
  for (let i = 0; i < marketIds.length; i += 300) {
    const chunk = marketIds.slice(i, i + 300);
    const rows = db
      .prepare(
        `SELECT market_id, config_json FROM markets
          WHERE market_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk) as Array<{ market_id: string; config_json: string | null }>;
    for (const row of rows) {
      if (typeof row.config_json !== "string" || row.config_json.length === 0) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.config_json) as Record<string, unknown>;
      } catch {
        continue; // a malformed blob costs this row its label, nothing more
      }
      const label =
        typeof parsed.question === "string" && parsed.question.trim().length > 0
          ? parsed.question.trim()
          : typeof parsed.series_title === "string" && parsed.series_title.trim().length > 0
            ? parsed.series_title.trim()
            : null;
      if (label !== null) labels.set(row.market_id, label);
    }
  }
  return labels;
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
  const rows = queryLeaderboardCallFacts(db, {
    kind: "agent_markets",
    agent_id,
  });

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
    // SQL already filters null market_id; this narrows the type.
    if (row.market_id === null) continue;
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

  const labels = marketLabels(db, Array.from(byMarket.keys()));
  const computed = Array.from(byMarket.values()).map((a) => {
    const summary = leaderboardCallSummary(a.calls);
    const { mainTier, sortKey } = resolveTierAndSort(summary, {
      preferLowerBound: true,
    });
    return {
      market_label: labels.get(a.market_id) ?? null,
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
