import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

/**
 * Which venue series an agent serves; row presence is the registration.
 * FKs: CASCADE from agents, RESTRICT from series. Provider terms FK here, so unregistering drops the price.
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

  /** Drop a registration; cascades the agent's provider terms for that series. */
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
