import type Database from "better-sqlite3";
import type { AgentKind, CallStatus, Outcome } from "./schema.js";

/**
 * The shared `agents ⋈ submissions ⋈ t1_resolutions` scoring-facts read for every leaderboard.
 * No scoring or grouping here; the ranking modules aggregate on top.
 */

/** One submission with its optional t1 resolution; the minimal shape leaderboardCallSummary consumes. */
export interface LeaderboardCallFact {
  status: CallStatus;
  outcome: Outcome | null;
  call_score: number | null;
  resolved_at?: string | null;
}

/** One facts row. `market_id` / `market_family` are nullable; `resolved_at` is null while pending. */
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
 * Which slice of facts to read; each variant is one ranking surface's WHERE / ORDER BY.
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

/** Facts for one scope, in accepted_at order within each group so `call_scores` sparklines are chronological. */
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
      // Grouped by market_id then agent so the grid ranks every market from one read.
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

/** Statuses that count toward `pending_calls`. */
export function isPendingLeaderboardStatus(status: CallStatus): boolean {
  return (
    status === "accepted" ||
    status === "pending_t0" ||
    status === "pending_t1"
  );
}
