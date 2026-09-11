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
 * Per-market leaderboard. Same aggregation as global getLeaderboard but
 * scoped to one market_id. Provisional flag uses the market's own
 * resolved-count threshold -- an agent with 200 ETH-1h calls but 3 BTC-1h
 * calls is provisional on BTC-1h.
 *
 * P3 reframe rationale: "An agent with 200 BTC_24H calls
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

/** One agent's profile + its scoring facts scoped to a single market. */
interface MarketAgentAgg {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
  calls: LeaderboardCallFact[];
}

/**
 * Summarize + score one agent's calls at one market into the per-market row.
 * Per-market boards rank by the lower-bound score (preferLowerBound: true).
 * Shared by the single-market board and the batched markets-grid read so both
 * project the identical market tier / sparkline shape.
 */
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

/** Fold one facts row into its agent's aggregate, creating the group lazily. */
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

  // Shared scoring facts scoped to one market_id; per-market projection (market
  // tier, sparkline series) stays local to this Module.
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
 * Batched per-market leaderboard for the markets grid. ONE facts read across
 * every market (scope `markets_grid`), regrouped by market_id then ranked with
 * the exact per-market policy `getLeaderboardForMarket` uses — so the grid's N
 * per-market round-trips collapse to a single query + response. Only markets
 * with at least one scoring call appear; the grid defaults absent markets to an
 * empty top-3, unchanged from the per-market fetch it replaces.
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
    // The markets_grid scope filters market_id IS NOT NULL in SQL; this guard
    // narrows the nullable fact column for the group key.
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
 * Human labels for a set of market ids, read from each market's own
 * `config_json`.
 *
 * The grid keys on `market_id`, which for a venue market is a 66-character hex
 * condition id. Rendering forty-seven of those on an agent profile is a list
 * of hashes, not a record of what the agent called, so the row carries the
 * market's question alongside its id.
 *
 * `question` before `series_title`: each grid row IS one five-minute window, so
 * the window-specific question ("XRP Up or Down - August 24, 5:25AM-5:30AM ET")
 * distinguishes the rows, while the series title would repeat once per row.
 * Native price markets carry no config_json and resolve to null.
 *
 * Chunked at 300 ids per statement — SQLite caps bound parameters (999 by
 * default) and an agent that has traded for a while has more markets than that.
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
  // Shared scoring facts for one agent across every market it touched; this
  // Module regroups them by market_id for the heat grid.
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
    // The agent_markets scope filters market_id IS NOT NULL in SQL; this guard
    // narrows the nullable fact column for the group key.
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
