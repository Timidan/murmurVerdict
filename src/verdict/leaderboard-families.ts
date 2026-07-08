import type Database from "better-sqlite3";
import type { AgentKind } from "./schema.js";
import {
  leaderboardCallSummary,
  type LeaderboardCallFact,
} from "./leaderboard-call-summary.js";
import {
  DEFAULT_KINDS,
  meetsMainTierThreshold,
  publicRankedLeaderboardRows,
  rankedLeaderboardRows,
  resolveTierAndSort,
  type LeaderboardOptions,
} from "./leaderboard-shared.js";

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
  /** Number of distinct market_ids this agent has TOUCHED inside the family. */
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
    calls: LeaderboardCallFact[];
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
        calls: [],
        distinct_markets: new Set(),
      };
      byAgent.set(row.agent_id, a);
    }
    a.calls.push(row);
    if (row.market_id) a.distinct_markets.add(row.market_id);
  }

  type Computed = AgentFamilyRow & { _sortKey: number };
  const computed: Computed[] = [];
  for (const a of byAgent.values()) {
    const summary = leaderboardCallSummary(a.calls);
    // Per-family boards rank by the lower-bound score (preferLowerBound: true).
    const { mainTier, sortKey } = resolveTierAndSort(summary, {
      preferLowerBound: true,
    });
    computed.push({
      agent_id: a.agent_id,
      display_slug: a.display_slug,
      display_name: a.display_name,
      kind: a.kind,
      market_family: opts.market_family,
      verdict_score: summary.verdict_score,
      verdict_score_lb: summary.verdict_score_lb,
      resolved_calls: summary.resolved_calls,
      pending_calls: summary.pending_calls,
      win_rate: summary.win_rate,
      last_resolved_at: summary.last_resolved_at,
      family_main_tier: mainTier,
      distinct_markets: a.distinct_markets.size,
      _sortKey: sortKey,
    });
  }

  return publicRankedLeaderboardRows(
    rankedLeaderboardRows(computed, {
      tier: opts.tier,
      isMain: (row) => row.family_main_tier,
    }).slice(0, limit),
  );
}

export interface CrossFamilyOptions {
  includeKinds?: AgentKind[];
  limit?: number;
  tier?: LeaderboardOptions["tier"];
}

export interface AgentCrossFamilyRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
  cross_family_score: number | null;
  general_score: number | null;
  families: Array<{
    market_family: string;
    verdict_score: number | null;
    verdict_score_lb: number | null;
    resolved_calls: number;
    qualifies: boolean;
  }>;
  qualifying_families: number;
  available_families: number;
  coverage_ratio: number;
  cross_family_main_tier: boolean;
}

type ComputedCrossFamilyRow = AgentCrossFamilyRow & { _sortKey: number };

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

  type FamilyAgg = { calls: LeaderboardCallFact[] };
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
      fam = { calls: [] };
      a.byFamily.set(row.market_family, fam);
    }
    fam.calls.push(row);
  }

  const available_families = new Set(rows.map((row) => row.market_family)).size;
  const computed: ComputedCrossFamilyRow[] = [];
  for (const a of byAgent.values()) {
    const families = Array.from(a.byFamily.entries()).map(([family, fam]) => {
      const summary = leaderboardCallSummary(fam.calls);
      // A family "qualifies" on the same MAIN threshold as every other scope.
      const qualifies = meetsMainTierThreshold(summary.resolved_calls);
      return {
        market_family: family,
        verdict_score: summary.verdict_score,
        verdict_score_lb: summary.verdict_score_lb,
        resolved_calls: summary.resolved_calls,
        qualifies,
      };
    });
    const qualifyingScores = families
      .filter((f) =>
        f.qualifies &&
        (f.verdict_score_lb !== null || f.verdict_score !== null),
      )
      .map((f) => (f.verdict_score_lb ?? f.verdict_score) as number);
    const cross_family_score =
      qualifyingScores.length > 0
        ? qualifyingScores.reduce((s, x) => s + x, 0) / qualifyingScores.length
        : null;
    const qualifying_families = qualifyingScores.length;
    const coverage_ratio =
      available_families > 0 ? qualifying_families / available_families : 0;
    const general_score = cross_family_score === null
      ? null
      : cross_family_score * Math.max(0, Math.min(1, coverage_ratio));
    computed.push({
      agent_id: a.agent_id,
      display_slug: a.display_slug,
      display_name: a.display_name,
      kind: a.kind,
      cross_family_score,
      general_score,
      families,
      qualifying_families,
      available_families,
      coverage_ratio,
      cross_family_main_tier: qualifying_families >= 2,
      _sortKey: general_score ?? -Infinity,
    });
  }

  return publicRankedLeaderboardRows(
    rankedLeaderboardRows(computed, {
      tier: opts.tier,
      isMain: (row) => row.cross_family_main_tier,
    }).slice(0, limit),
  );
}
