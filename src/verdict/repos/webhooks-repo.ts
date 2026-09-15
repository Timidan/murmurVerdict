import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

export interface WebhookRow {
  id: string;
  agent_slug: string | null;
  url: string;
  secret: string;
  created_at: string;
  last_delivery_at: string | null;
  last_status: number | null;
  delivery_count: number;
  failure_count: number;
  disabled: number;
}

export interface WebhookInsertRow {
  id: string;
  agent_slug: string | null;
  url: string;
  secret: string;
  created_at: string;
}

export const webhooksRepo = {
  insert(
    db: Database.Database,
    row: WebhookInsertRow,
  ): void {
    prep(
      db,
      `INSERT INTO webhooks (id, agent_slug, url, secret, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.id, row.agent_slug, row.url, row.secret, row.created_at);
  },

  byId(db: Database.Database, id: string): WebhookRow | null {
    const row = prep(
      db,
      "SELECT * FROM webhooks WHERE id = ? LIMIT 1",
    ).get(id) as WebhookRow | undefined;
    return row ?? null;
  },

  /** Count active subscriptions for an agent slug (null = global), for the per-agent cap. */
  countActiveForAgentSlug(
    db: Database.Database,
    agent_slug: string | null,
  ): number {
    if (agent_slug === null) {
      const row = prep(
        db,
        `SELECT COUNT(*) AS n FROM webhooks
         WHERE disabled = 0 AND agent_slug IS NULL`,
      ).get() as { n: number };
      return row.n;
    }
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM webhooks
       WHERE disabled = 0 AND agent_slug = ?`,
    ).get(agent_slug) as { n: number };
    return row.n;
  },

  /** Return active subscriptions for a specific agent or all agents. */
  matchAgent(db: Database.Database, agent_slug: string): WebhookRow[] {
    return prep(
      db,
      `SELECT * FROM webhooks
       WHERE disabled = 0
         AND (agent_slug = ? OR agent_slug IS NULL)`,
    ).all(agent_slug) as WebhookRow[];
  },

  delete(db: Database.Database, id: string): boolean {
    const info = prep(
      db,
      "DELETE FROM webhooks WHERE id = ?",
    ).run(id);
    return info.changes > 0;
  },

  bumpDelivery(
    db: Database.Database,
    id: string,
    iso: string,
    status: number,
    failed: boolean,
  ): void {
    prep(
      db,
      `UPDATE webhooks
       SET last_delivery_at = ?,
           last_status = ?,
           delivery_count = delivery_count + 1,
           failure_count = failure_count + CASE WHEN ? THEN 1 ELSE 0 END
       WHERE id = ?`,
    ).run(iso, status, failed ? 1 : 0, id);
  },
};
