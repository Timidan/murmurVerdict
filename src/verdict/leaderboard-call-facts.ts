import type Database from "better-sqlite3";
import type { AgentKind, CallStatus, Outcome } from "./schema.js";

/**
 * Leaderboard Call-Facts Module.
 *
 * Owns the canonical `agents ⋈ submissions ⋈ t1_resolutions` scoring-facts
 * read and its row vocabulary. Every ranking Surface (global, per-market,
 * per-family, cross-family) used to hand-copy this join + row shape; they now
 * consume typed facts from this one seam instead of embedding raw SQL.
 *
 * This Module owns the join and the status/outcome vocabulary only. It does no
 * scoring and no grouping-into-response projection: the ranking Modules keep
 * their genuinely-different aggregation (tier field names, cross-family
 * averaging, per-market grid grouping) on top of these shared facts.
 */

/**
 * A single scoring-relevant fact: one submission optionally paired with its
 * t1 resolution, decorated with the agent profile. This is the minimal shape
 * `leaderboardCallSummary` consumes — `LeaderboardCallFactRow` extends it with
 * the columns the ranking Modules group / project on.
 */
export interface LeaderboardCallFact {
  status: CallStatus;
  outcome: Outcome | null;
  call_score: number | null;
  resolved_at?: string | null;
}

/**
 * One row of the canonical scoring-facts read. `market_id` / `market_family`
 * are nullable submission columns (a call need not belong to a market or
 * family); scopes that filter on them still surface the column typed so
 * consumers can group without re-reading. `resolved_at` is null while pending.
 */
export interface LeaderboardCallFactRow extends LeaderboardCallFact {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
  call_id: string;
  status: CallStatus;
  outcome: Outcome | null;
  call_score: number | null;
  resolved_at: string | null;
  market_id: string | null;
  market_family: string | null;
}

/**
 * Scope discriminator: which slice of scoring facts to read. Each variant maps
 * onto one ranking Surface's WHERE / ORDER-BY, so the read stays a single seam
 * while every Surface keeps its exact filter and chronological ordering.
 *
 *  - `global`        — all agents of the given kinds (global board)
 *  - `market`        — all agents, one market_id (per-market board)
 *  - `markets_grid`  — all agents, every market_id (batched per-market grid)
 *  - `agent_markets` — one agent, every market it touched (agent heat grid)
 *  - `family`        — all agents, one market_family (per-family board)
 *  - `cross_family`  — all agents, every family (cross-family board)
 */
export type LeaderboardCallFactScope =
  | { kind: "global"; includeKinds: AgentKind[] }
  | { kind: "market"; includeKinds: AgentKind[]; market_id: string }
  | { kind: "markets_grid"; includeKinds: AgentKind[] }
  | { kind: "agent_markets"; agent_id: string }
  | { kind: "family"; includeKinds: AgentKind[]; market_family: string }
  | { kind: "cross_family"; includeKinds: AgentKind[] };

const SELECT_CLAUSE = `SELECT a.agent_id, a.display_slug, a.display_name, a.kind,
              s.call_id, s.status, s.market_id, s.market_family,
              r.outcome, r.call_score, r.resolved_at
       FROM agents a
       JOIN submissions s ON s.agent_id = a.agent_id
       LEFT JOIN t1_resolutions r ON r.call_id = s.call_id`;

function kindPlaceholders(includeKinds: AgentKind[]): string {
  return includeKinds.map(() => "?").join(",");
}

/**
 * Read scoring facts for one scope, ordered chronologically per group so
 * downstream `call_scores` sparklines land in accepted_at order. The row shape
 * is uniform across scopes; the WHERE / ORDER-BY vary per the discriminator.
 */
export function queryLeaderboardCallFacts(
  db: Database.Database,
  scope: LeaderboardCallFactScope,
): LeaderboardCallFactRow[] {
  let sql: string;
  let params: unknown[];

  switch (scope.kind) {
    case "global": {
      const placeholders = kindPlaceholders(scope.includeKinds);
      sql = `${SELECT_CLAUSE}
       WHERE a.kind IN (${placeholders})
       ORDER BY a.agent_id, s.accepted_at`;
      params = [...scope.includeKinds];
      break;
    }
    case "market": {
      const placeholders = kindPlaceholders(scope.includeKinds);
      sql = `${SELECT_CLAUSE}
       WHERE a.kind IN (${placeholders})
         AND s.market_id = ?
       ORDER BY a.agent_id, s.accepted_at`;
      params = [...scope.includeKinds, scope.market_id];
      break;
    }
    case "markets_grid": {
      const placeholders = kindPlaceholders(scope.includeKinds);
      // Every market's rows in one read, grouped by market_id then agent so the
      // grid Surface can regroup and rank each market without a per-market query.
      sql = `${SELECT_CLAUSE}
       WHERE a.kind IN (${placeholders})
         AND s.market_id IS NOT NULL
       ORDER BY s.market_id, a.agent_id, s.accepted_at`;
      params = [...scope.includeKinds];
      break;
    }
    case "agent_markets": {
      sql = `${SELECT_CLAUSE}
       WHERE a.agent_id = ?
         AND s.market_id IS NOT NULL
       ORDER BY s.market_id, s.accepted_at`;
      params = [scope.agent_id];
      break;
    }
    case "family": {
      const placeholders = kindPlaceholders(scope.includeKinds);
      sql = `${SELECT_CLAUSE}
       WHERE a.kind IN (${placeholders})
         AND s.market_family = ?
       ORDER BY a.agent_id, s.accepted_at`;
      params = [...scope.includeKinds, scope.market_family];
      break;
    }
    case "cross_family": {
      const placeholders = kindPlaceholders(scope.includeKinds);
      sql = `${SELECT_CLAUSE}
       WHERE a.kind IN (${placeholders})
         AND s.market_family IS NOT NULL
       ORDER BY a.agent_id, s.market_family, s.accepted_at`;
      params = [...scope.includeKinds];
      break;
    }
  }

  return db.prepare(sql).all(...params) as LeaderboardCallFactRow[];
}

/**
 * The canonical pending-call predicate: statuses that count toward
 * `pending_calls` but have no resolution yet. Centralized here so the status
 * vocabulary lives in one place instead of being redefined per ranking Module.
 */
export function isPendingLeaderboardStatus(status: CallStatus): boolean {
  return (
    status === "accepted" ||
    status === "pending_t0" ||
    status === "pending_t1"
  );
}
