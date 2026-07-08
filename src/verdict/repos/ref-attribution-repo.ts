import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

export interface RefClickRow {
  ref: string;
  agent_slug: string | null;
  total: number;
  first_at: string;
  last_at: string;
  converted_count: number;
  last_conversion_at: string | null;
}

export interface RefTopSenderRow {
  ref: string;
  total: number;
  agents_touched: number;
  converted: number;
  last_at: string;
}

export const refsRepo = {
  /** Bump the (ref, agent_slug) counter. Creates the row on first hit. */
  bumpClick(
    db: Database.Database,
    ref: string,
    agent_slug: string | null,
    nowIso: string,
  ): void {
    prep(
      db,
      `INSERT INTO ref_clicks (ref, agent_slug, total, first_at, last_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(ref, agent_slug) DO UPDATE SET
         total = total + 1,
         last_at = excluded.last_at`,
    ).run(ref, agent_slug, nowIso, nowIso);
  },

  /** Top referrers for one agent, ordered by total desc. */
  discoverersForAgent(
    db: Database.Database,
    agent_slug: string,
    limit = 5,
  ): RefClickRow[] {
    return prep(
      db,
      `SELECT ref, agent_slug, total, first_at, last_at
       FROM ref_clicks
       WHERE agent_slug = ?
       ORDER BY total DESC, last_at DESC
       LIMIT ?`,
    ).all(agent_slug, limit) as RefClickRow[];
  },

  /** Full ref leaderboard: top senders across all agents. */
  topSenders(
    db: Database.Database,
    limit = 50,
  ): RefTopSenderRow[] {
    return prep(
      db,
      `SELECT ref,
              SUM(total) AS total,
              SUM(converted_count) AS converted,
              COUNT(DISTINCT agent_slug) AS agents_touched,
              MAX(last_at) AS last_at
       FROM ref_clicks
       GROUP BY ref
       ORDER BY converted DESC, total DESC, last_at DESC
       LIMIT ?`,
    ).all(limit) as RefTopSenderRow[];
  },

  /**
   * Record a successful claim conversion against a (ref, agent_slug) bucket.
   * Returns true only when the row transitions from unconverted to converted.
   */
  bumpConversion(
    db: Database.Database,
    ref: string,
    agent_slug: string,
    nowIso: string,
  ): boolean {
    const info = prep(
      db,
      `UPDATE ref_clicks
       SET converted_count = 1,
           last_conversion_at = ?
       WHERE ref = ? AND agent_slug = ? AND converted_count = 0`,
    ).run(nowIso, ref, agent_slug);
    return info.changes > 0;
  },

  deleteSender(db: Database.Database, ref: string): number {
    const info = prep(db, "DELETE FROM ref_clicks WHERE ref = ?").run(ref);
    return info.changes;
  },
};
