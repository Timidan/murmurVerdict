import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

/**
 * Which venue series an agent is registered to serve (migration 075).
 *
 * Row presence IS the registration — there is no status column. A row is
 * backfilled for every (agent, series) the agent has historically submitted
 * into, and written going forward when an agent takes on a new series.
 *
 * The table's foreign keys carry the lifecycle: CASCADE from agents (a deleted
 * agent's registrations go with it) and RESTRICT from the series. Provider
 * terms in turn FK to THIS table, so a registration is the precondition for a
 * price and unregistering cascades the price away.
 */
export interface AgentMarketRegistrationRow {
  agent_id: string;
  venue_series_id: string;
  created_at: string;
}

export interface AgentMarketRegistrationKey {
  agentId: string;
  venueSeriesId: string;
}

export const agentMarketRegistrationsRepo = {
  /**
   * Register an agent for a series. Idempotent: a repeat is a no-op, never an
   * error. A missing agent or series still fails — the foreign keys are real.
   */
  register(
    db: Database.Database,
    input: AgentMarketRegistrationKey & { now: string },
  ): void {
    prep(
      db,
      `INSERT INTO agent_market_registrations (agent_id, venue_series_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_id, venue_series_id) DO NOTHING`,
    ).run(input.agentId, input.venueSeriesId, input.now);
  },

  /**
   * Drop a registration. With foreign keys enforced (they are, at db open) this
   * cascades the agent's provider terms for that series away in the same step.
   */
  unregister(db: Database.Database, key: AgentMarketRegistrationKey): void {
    prep(
      db,
      `DELETE FROM agent_market_registrations
        WHERE agent_id = ? AND venue_series_id = ?`,
    ).run(key.agentId, key.venueSeriesId);
  },

  isRegistered(db: Database.Database, key: AgentMarketRegistrationKey): boolean {
    return Boolean(
      prep(
        db,
        `SELECT 1 FROM agent_market_registrations
          WHERE agent_id = ? AND venue_series_id = ?`,
      ).get(key.agentId, key.venueSeriesId),
    );
  },

  listForAgent(db: Database.Database, agentId: string): AgentMarketRegistrationRow[] {
    return prep(
      db,
      `SELECT * FROM agent_market_registrations
        WHERE agent_id = ? ORDER BY venue_series_id`,
    ).all(agentId) as AgentMarketRegistrationRow[];
  },
};
