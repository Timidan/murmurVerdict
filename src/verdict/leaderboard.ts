import type Database from "better-sqlite3";
import {
  AgentKind,
  LeaderboardRow,
  LeaderboardTier,
  MIN_RESOLVED_CALLS_FOR_MAIN_TIER,
  MIN_RESOLVED_CALLS_FOR_MARKETPLACE_TIER,
} from "./schema.js";
import { computeVerdictScore } from "./scoring.js";
import { callRevealsRepo } from "./db.js";

// ─── Public API ──────────────────────────────────────────────────────────────

export interface LeaderboardOptions {
  /** Minimum kind that gets ranked at all (defaults to verified+benchmark). */
  includeKinds?: AgentKind[];
  /** Cap rows returned. Default 200. */
  limit?: number;
  /** "main" → only ranked agents. "provisional" → only sub-threshold. omit → both. */
  tier?: LeaderboardTier;
}

// wallet_only agents proved control of a wallet via /claim/wallet-only —
// they're real marketplace participants and appear on the default
// leaderboard alongside verified (X/Telegram-bound) and benchmark agents.
// Dashboards distinguish them via the `kind` field on each row.
const DEFAULT_KINDS: AgentKind[] = ["verified", "benchmark", "wallet_only"];

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

  // Phase F D26 — three-axis reputation. Pull reveal-reliability counts
  // per agent in one query so we can populate marketplace_eligible +
  // reveal_reliability without N round-trips.
  const reliabilityRows = callRevealsRepo.reliabilityByAgent(db);
  const reliabilityByAgent = new Map<
    string,
    { agent_reveals: number; daemon_reveals: number }
  >();
  for (const r of reliabilityRows) {
    reliabilityByAgent.set(r.agent_id, {
      agent_reveals: r.agent_reveals ?? 0,
      daemon_reveals: r.daemon_reveals ?? 0,
    });
  }

  type Computed = LeaderboardRow & { _sortKey: number };
  const all: Computed[] = [];
  for (const a of byAgent.values()) {
    const score = computeVerdictScore(a.call_scores);
    const tier: LeaderboardTier =
      score.resolved_calls >= MIN_RESOLVED_CALLS_FOR_MAIN_TIER ? "main" : "provisional";
    const win_rate = a.wins + a.losses > 0 ? a.wins / (a.wins + a.losses) : null;
    const reliability = reliabilityByAgent.get(a.agent_id) ?? {
      agent_reveals: 0,
      daemon_reveals: 0,
    };
    const reliabilityDenom =
      reliability.agent_reveals + reliability.daemon_reveals;
    const reveal_reliability =
      reliabilityDenom > 0
        ? reliability.agent_reveals / reliabilityDenom
        : null;
    // D25: marketplace eligibility — stricter than tier=main.
    const marketplace_eligible =
      score.resolved_calls >= MIN_RESOLVED_CALLS_FOR_MARKETPLACE_TIER &&
      score.verdict_score_lb !== null &&
      score.verdict_score_lb >= 0;
    all.push({
      agent_id: a.agent_id,
      display_slug: a.display_slug,
      display_name: a.display_name,
      kind: a.kind,
      tier,
      rank: null,
      verdict_score: score.verdict_score,
      verdict_score_lb: score.verdict_score_lb,
      resolved_calls: score.resolved_calls,
      win_rate,
      pending_calls: a.pending,
      last_resolved_at: a.last_resolved_at,
      reveal_reliability,
      agent_reveals: reliability.agent_reveals,
      daemon_fallback_reveals: reliability.daemon_reveals,
      marketplace_eligible,
      // D26 axes 2 + 3 — populated in v0.3 once operator_trust + stake
      // schemas land. Today they're explicitly null so consumers can
      // distinguish "not yet wired" from "score=0".
      operator_trust_score: null,
      stake_at_risk: null,
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

// ─── P3 Phase 3a — per-market leaderboard ────────────────────────────────────
//
// The Phase 3 reframe makes the markets registry the unit of competition.
// Instead of one global verdict_score per agent, we expose an (agent, market)
// matrix. UI surfaces:
//   - /v1/markets/:market_id/leaderboard  → top agents on this market
//   - /v1/agents/:slug                    → heat grid: markets × scores
//
// Today's getLeaderboard() stays unchanged for back-compat — it's the global
// summary that lives on the homepage. The new functions below filter by
// market_id (single-market) or aggregate across markets (heat grid).

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
}

/**
 * Per-market leaderboard. Same aggregation as global getLeaderboard but
 * scoped to one market_id. Provisional flag uses the market's own
 * resolved-count threshold — an agent with 200 ETH-1h calls but 3 BTC-1h
 * calls is provisional on BTC-1h.
 *
 * P3 reframe rationale (Codex audit): "An agent with 200 BTC_24H calls
 * and 3 SOL_5M calls should not appear as a SOL_5M leader." — this query
 * makes that physical.
 */
export function getLeaderboardForMarket(
  db: Database.Database,
  opts: MarketLeaderboardOptions,
): AgentMarketRow[] {
  const includeKinds = opts.includeKinds ?? DEFAULT_KINDS;
  const limit = opts.limit ?? 200;
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
    } else if (
      row.status === "accepted" ||
      row.status === "pending_t0" ||
      row.status === "pending_t1"
    ) {
      a.pending++;
    }
    if (row.resolved_at) {
      if (!a.last_resolved_at || row.resolved_at > a.last_resolved_at) {
        a.last_resolved_at = row.resolved_at;
      }
    }
  }

  type Computed = AgentMarketRow & { _sortKey: number };
  const computed: Computed[] = [];
  for (const a of byAgent.values()) {
    const score = computeVerdictScore(a.call_scores);
    const win_rate = a.wins + a.losses > 0 ? a.wins / (a.wins + a.losses) : null;
    computed.push({
      agent_id: a.agent_id,
      display_slug: a.display_slug,
      display_name: a.display_name,
      kind: a.kind,
      market_id: opts.market_id,
      verdict_score: score.verdict_score,
      verdict_score_lb: score.verdict_score_lb,
      resolved_calls: score.resolved_calls,
      pending_calls: a.pending,
      win_rate,
      last_resolved_at: a.last_resolved_at,
      market_main_tier:
        score.resolved_calls >= MIN_RESOLVED_CALLS_FOR_MAIN_TIER,
      _sortKey: score.verdict_score_lb ?? score.verdict_score ?? -Infinity,
    });
  }

  return computed
    .sort((a, b) => b._sortKey - a._sortKey)
    .slice(0, limit)
    .map(({ _sortKey, ...row }) => {
      void _sortKey;
      return row;
    });
}

/**
 * Heat grid: every (market_id, score) pair this agent has resolved at least
 * one call on. Sub-threshold cells are still returned — UI distinguishes
 * provisional via market_main_tier. Markets the agent has never touched are
 * NOT returned (no zero-row); the consumer can layer those in from
 * marketsRepo.listed() if it wants the full grid.
 */
export function getAgentMarketGrid(
  db: Database.Database,
  agent_id: string,
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
    call_scores: (number | null)[];
    wins: number;
    losses: number;
    pending: number;
    last_resolved_at: string | null;
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
        call_scores: [],
        wins: 0,
        losses: 0,
        pending: 0,
        last_resolved_at: null,
        profile: {
          agent_id: row.agent_id,
          display_slug: row.display_slug,
          display_name: row.display_name,
          kind: row.kind,
        },
      };
      byMarket.set(row.market_id, a);
    }
    if (row.outcome === "win") {
      a.wins++;
      a.call_scores.push(row.call_score);
    } else if (row.outcome === "loss") {
      a.losses++;
      a.call_scores.push(row.call_score);
    } else if (row.outcome === "void" || row.outcome === "oracle_unavailable") {
      a.call_scores.push(null);
    } else if (
      row.status === "accepted" ||
      row.status === "pending_t0" ||
      row.status === "pending_t1"
    ) {
      a.pending++;
    }
    if (row.resolved_at) {
      if (!a.last_resolved_at || row.resolved_at > a.last_resolved_at) {
        a.last_resolved_at = row.resolved_at;
      }
    }
  }

  return Array.from(byMarket.values()).map((a) => {
    const score = computeVerdictScore(a.call_scores);
    const win_rate = a.wins + a.losses > 0 ? a.wins / (a.wins + a.losses) : null;
    return {
      agent_id: a.profile.agent_id,
      display_slug: a.profile.display_slug,
      display_name: a.profile.display_name,
      kind: a.profile.kind,
      market_id: a.market_id,
      verdict_score: score.verdict_score,
      verdict_score_lb: score.verdict_score_lb,
      resolved_calls: score.resolved_calls,
      pending_calls: a.pending,
      win_rate,
      last_resolved_at: a.last_resolved_at,
      market_main_tier:
        score.resolved_calls >= MIN_RESOLVED_CALLS_FOR_MAIN_TIER,
    };
  });
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
