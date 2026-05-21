import type Database from "better-sqlite3";
import {
  AgentKind,
  LeaderboardRow,
  LeaderboardTier,
  MIN_RESOLVED_CALLS_FOR_MAIN_TIER,
  MIN_RESOLVED_CALLS_FOR_MARKETPLACE_TIER,
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

// Wave 3 collapse — the leaderboard's default audience is every kind that
// represents a marketplace-eligible reputation surface: operator-owned
// agents (the 'agent' kind, the only path post-Wave-1) plus benchmarks
// (Murmur-run baselines that anchor the top of the board) plus attested
// (Olas-bonded variant of 'agent'). `internal_test` stays off the board.
const DEFAULT_KINDS: AgentKind[] = ["agent", "benchmark", "attested"];

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

  const revealReliability = getRevealReliability(db);
  type Computed = LeaderboardRow & { _sortKey: number };
  const all: Computed[] = [];
  for (const a of byAgent.values()) {
    const score = computeVerdictScore(a.call_scores);
    const reveal = revealReliability.get(a.agent_id) ?? {
      total: 0,
      revealed: 0,
      failed: 0,
    };
    const tier: LeaderboardTier =
      score.resolved_calls >= MIN_RESOLVED_CALLS_FOR_MAIN_TIER ? "main" : "provisional";
    const win_rate = a.wins + a.losses > 0 ? a.wins / (a.wins + a.losses) : null;
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
      reveal_reliability: reveal.total > 0 ? reveal.revealed / reveal.total : null,
      agent_reveals: reveal.revealed,
      daemon_fallback_reveals: 0,
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
      // Surface 3 Wave 2 — expose the chronological per-call score series so
      // the dashboard's per-market trend sparkline can render real data.
      // Null entries are void/oracle_unavailable resolutions; the client
      // sparkline renders them as gaps, not zeros.
      call_scores: a.call_scores,
    };
  });
}

// ─── Phase 10 — per-family leaderboard ─────────────────────────────────────
//
// A `market_family` (e.g. 'financial-direction', 'prediction-market-binary')
// groups markets of the same scoring shape. Agents who only play one
// family shouldn't be penalized in cross-family rankings; per-family LBs
// answer "who's best at THIS kind of question." V2 §3.2 risk 4 — taxonomy
// is operator-curated, kept open at the DB layer, so adding a new family
// (e.g. 'category-multi') is a code-only change.
//
// Sources of family on the row:
//   - submissions.market_family — denormalized at submit time from the
//     market row's adapter.marketFamily. Backfilled in MIGRATION_016 for
//     pre-v2 native-price rows ('financial-direction').
//
// Provisional tier inside a family is the same MAIN_TIER threshold as
// global — keeps the surface intuitive. Cross-family is a separate
// function below.

export interface FamilyLeaderboardOptions extends LeaderboardOptions {
  /** Required. Matches submissions.market_family exactly. */
  market_family: string;
}

export interface AgentFamilyRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
  market_family: string;
  verdict_score: number | null;
  verdict_score_lb: number | null;
  resolved_calls: number;
  pending_calls: number;
  win_rate: number | null;
  last_resolved_at: string | null;
  /** True iff resolved_calls >= MAIN tier threshold WITHIN this family. */
  family_main_tier: boolean;
  /** Number of distinct market_ids this agent has TOUCHED inside the
   *  family — counts any submission with a market_id (pending or
   *  resolved). Helps the dashboard distinguish "one-market specialist"
   *  from "broad family practitioner." Resolved-only is a stricter
   *  signal expressible via resolved_calls; this field is intentionally
   *  inclusive of pending so a new agent's reach is visible. */
  distinct_markets: number;
}

export function getLeaderboardForFamily(
  db: Database.Database,
  opts: FamilyLeaderboardOptions,
): AgentFamilyRow[] {
  const includeKinds = opts.includeKinds ?? DEFAULT_KINDS;
  const limit = opts.limit ?? 200;
  const placeholders = includeKinds.map(() => "?").join(",");

  const rows = db
    .prepare(
      `SELECT a.agent_id, a.display_slug, a.display_name, a.kind,
              s.call_id, s.status, s.market_id, s.market_family,
              r.outcome, r.call_score, r.resolved_at
       FROM agents a
       JOIN submissions s ON s.agent_id = a.agent_id
       LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
       WHERE a.kind IN (${placeholders})
         AND s.market_family = ?
       ORDER BY a.agent_id, s.accepted_at`,
    )
    .all(...includeKinds, opts.market_family) as Array<{
    agent_id: string;
    display_slug: string;
    display_name: string;
    kind: AgentKind;
    call_id: string;
    status: string;
    market_id: string | null;
    market_family: string;
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
    distinct_markets: Set<string>;
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
        distinct_markets: new Set(),
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
    if (row.market_id) a.distinct_markets.add(row.market_id);
    if (row.resolved_at) {
      if (!a.last_resolved_at || row.resolved_at > a.last_resolved_at) {
        a.last_resolved_at = row.resolved_at;
      }
    }
  }

  type Computed = AgentFamilyRow & { _sortKey: number };
  const computed: Computed[] = [];
  for (const a of byAgent.values()) {
    const score = computeVerdictScore(a.call_scores);
    const win_rate = a.wins + a.losses > 0 ? a.wins / (a.wins + a.losses) : null;
    computed.push({
      agent_id: a.agent_id,
      display_slug: a.display_slug,
      display_name: a.display_name,
      kind: a.kind,
      market_family: opts.market_family,
      verdict_score: score.verdict_score,
      verdict_score_lb: score.verdict_score_lb,
      resolved_calls: score.resolved_calls,
      pending_calls: a.pending,
      win_rate,
      last_resolved_at: a.last_resolved_at,
      family_main_tier:
        score.resolved_calls >= MIN_RESOLVED_CALLS_FOR_MAIN_TIER,
      distinct_markets: a.distinct_markets.size,
      _sortKey: score.verdict_score_lb ?? score.verdict_score ?? -Infinity,
    });
  }

  // Tier filter mirrors getLeaderboard()'s contract: 'main' → only ranked,
  // 'provisional' → only sub-threshold, omit → both with main first.
  const filtered = opts.tier
    ? computed.filter((r) =>
        opts.tier === "main" ? r.family_main_tier : !r.family_main_tier,
      )
    : computed;
  const main = filtered
    .filter((r) => r.family_main_tier)
    .sort((a, b) => b._sortKey - a._sortKey);
  const provisional = filtered
    .filter((r) => !r.family_main_tier)
    .sort((a, b) => b._sortKey - a._sortKey);
  return [...main, ...provisional]
    .slice(0, limit)
    .map(({ _sortKey, ...row }) => {
      void _sortKey;
      return row;
    });
}

// ─── Phase 10 — cross-family aggregate leaderboard ─────────────────────────
//
// "Who's the best agent across ALL families?" is harder than per-family
// because the score distributions differ. financial-direction Brier and
// prediction-market-binary L1 are both scaled to [0,1] but the difficulty
// landscape is not the same. Aggregating raw call_scores would let an
// agent who only plays the "easy" family dominate.
//
// Approach: per-family normalize, then average.
//
//   1. Compute per-family verdict_score for the agent.
//   2. Per family, require at least MIN_RESOLVED_CALLS_FOR_MAIN_TIER
//      resolved calls; otherwise the family contributes a null and is
//      excluded from the cross-family mean (the agent is provisional in
//      that family, so we don't pretend they're ranked there).
//   3. The cross-family score is the unweighted mean of the per-family
//      verdict_scores the agent qualifies in. cross_family_main_tier
//      requires at least 2 qualifying families — a single-family
//      specialist appears on the per-family LB, not the cross-family one.
//
// The unweighted mean is the v0 choice. A future revision can swap in
// family-difficulty calibration (e.g. divide each per-family score by
// the family's own historical mean) once we have stable cross-family
// sample sizes; the API shape stays the same.

export interface CrossFamilyOptions {
  includeKinds?: AgentKind[];
  limit?: number;
}

export interface AgentCrossFamilyRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
  /** Mean of qualifying per-family verdict_scores. null when the agent
   *  doesn't qualify in any family. */
  cross_family_score: number | null;
  /** Per-family detail. Each entry is { market_family, verdict_score,
   *  resolved_calls, qualifies } so the dashboard can render the
   *  breakdown without a second query. */
  families: Array<{
    market_family: string;
    verdict_score: number | null;
    resolved_calls: number;
    qualifies: boolean;
  }>;
  /** Number of families with resolved_calls >= MAIN_TIER. */
  qualifying_families: number;
  /** True iff qualifying_families >= 2. */
  cross_family_main_tier: boolean;
}

export function getCrossFamilyLeaderboard(
  db: Database.Database,
  opts: CrossFamilyOptions = {},
): AgentCrossFamilyRow[] {
  const includeKinds = opts.includeKinds ?? DEFAULT_KINDS;
  const limit = opts.limit ?? 200;
  const placeholders = includeKinds.map(() => "?").join(",");

  const rows = db
    .prepare(
      `SELECT a.agent_id, a.display_slug, a.display_name, a.kind,
              s.call_id, s.status, s.market_family,
              r.outcome, r.call_score
       FROM agents a
       JOIN submissions s ON s.agent_id = a.agent_id
       LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
       WHERE a.kind IN (${placeholders})
         AND s.market_family IS NOT NULL
       ORDER BY a.agent_id, s.market_family, s.accepted_at`,
    )
    .all(...includeKinds) as Array<{
    agent_id: string;
    display_slug: string;
    display_name: string;
    kind: AgentKind;
    call_id: string;
    status: string;
    market_family: string;
    outcome: string | null;
    call_score: number | null;
  }>;

  type FamilyAgg = { call_scores: (number | null)[] };
  type Agg = {
    agent_id: string;
    display_slug: string;
    display_name: string;
    kind: AgentKind;
    byFamily: Map<string, FamilyAgg>;
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
        byFamily: new Map(),
      };
      byAgent.set(row.agent_id, a);
    }
    let fam = a.byFamily.get(row.market_family);
    if (!fam) {
      fam = { call_scores: [] };
      a.byFamily.set(row.market_family, fam);
    }
    if (row.outcome === "win" || row.outcome === "loss") {
      fam.call_scores.push(row.call_score);
    } else if (row.outcome === "void" || row.outcome === "oracle_unavailable") {
      fam.call_scores.push(null);
    }
  }

  type Computed = AgentCrossFamilyRow & { _sortKey: number };
  const computed: Computed[] = [];
  for (const a of byAgent.values()) {
    const families = Array.from(a.byFamily.entries()).map(([family, fam]) => {
      const score = computeVerdictScore(fam.call_scores);
      const qualifies = score.resolved_calls >= MIN_RESOLVED_CALLS_FOR_MAIN_TIER;
      return {
        market_family: family,
        verdict_score: score.verdict_score,
        resolved_calls: score.resolved_calls,
        qualifies,
      };
    });
    const qualifyingScores = families
      .filter((f) => f.qualifies && f.verdict_score !== null)
      .map((f) => f.verdict_score as number);
    const cross_family_score =
      qualifyingScores.length > 0
        ? qualifyingScores.reduce((s, x) => s + x, 0) / qualifyingScores.length
        : null;
    const qualifying_families = qualifyingScores.length;
    computed.push({
      agent_id: a.agent_id,
      display_slug: a.display_slug,
      display_name: a.display_name,
      kind: a.kind,
      cross_family_score,
      families,
      qualifying_families,
      cross_family_main_tier: qualifying_families >= 2,
      _sortKey: cross_family_score ?? -Infinity,
    });
  }

  return computed
    .sort((a, b) => {
      // Main-tier (qualifying ≥2 families) sorts ahead of provisional;
      // within each band sort by cross_family_score descending.
      if (a.cross_family_main_tier !== b.cross_family_main_tier) {
        return a.cross_family_main_tier ? -1 : 1;
      }
      return b._sortKey - a._sortKey;
    })
    .slice(0, limit)
    .map(({ _sortKey, ...row }) => {
      void _sortKey;
      return row;
    });
}

/**
 * 24h Verdict Volume — count of `submission_accepted` events in the last
 * 24 hours from kinds that surface on the public leaderboard ('agent' and
 * 'attested'). Wave 3 collapsed the agent.kind enum; the prior 'verified'
 * filter is now the union of 'agent' + 'attested'. Benchmarks are excluded
 * here because they're Murmur-operated baselines, not operator activity.
 * v0.1 has no fees yet, so this number is a count proxy until the
 * billing/meter wiring lands.
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
         AND a.kind IN ('agent', 'attested')
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
