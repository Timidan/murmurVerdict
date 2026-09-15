// ─── The owner's own webhook subscriptions ─────────────────────────────────
//
//   GET    /v1/account/webhooks
//   DELETE /v1/account/webhooks/:id
//
// Authorized by ownership: a webhook belongs to the account owning the agent its `agent_slug` names.
// The HMAC secret (shown once at creation) stays a delivery credential, never a management one.

import type Database from "better-sqlite3";

import { prep } from "./db-statements.js";
import { SCHEMA_VERSION } from "./schema.js";

export interface AccountWebhooksResponse {
  status: number;
  body: unknown;
}

export interface AccountWebhookRow {
  id: string;
  agent_slug: string;
  url: string;
  created_at: string;
  last_delivery_at: string | null;
  last_status: number | null;
  delivery_count: number;
  failure_count: number;
  disabled: boolean;
}

/**
 * Every subscription on every agent this account owns, newest first.
 * Joins on display_slug, which the register route canonicalizes to. `secret` is never selected.
 */
export function listAccountWebhooks(deps: {
  db: Database.Database;
  accountId: string;
}): AccountWebhooksResponse {
  const rows = prep(
    deps.db,
    `SELECT w.id, w.agent_slug, w.url, w.created_at, w.last_delivery_at,
            w.last_status, w.delivery_count, w.failure_count, w.disabled
       FROM webhooks w
       JOIN agents a        ON a.display_slug = w.agent_slug
       JOIN account_agents aa ON aa.agent_id = a.agent_id
      WHERE aa.account_id = @account_id
      ORDER BY w.created_at DESC, w.id DESC`,
  ).all({ account_id: deps.accountId }) as Array<
    Omit<AccountWebhookRow, "disabled"> & { disabled: number }
  >;
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      webhooks: rows.map((row) => ({ ...row, disabled: row.disabled === 1 })),
    },
  };
}

/**
 * Deletes one owned subscription. Returns a JSON body, not 204, for the dashboard's DELETE client.
 * 404 for an unknown or someone else's id, so ids can't be probed.
 */
export function deleteAccountWebhook(deps: {
  db: Database.Database;
  accountId: string;
  id: string;
}): AccountWebhooksResponse {
  const owned = prep(
    deps.db,
    `SELECT w.id
       FROM webhooks w
       JOIN agents a          ON a.display_slug = w.agent_slug
       JOIN account_agents aa ON aa.agent_id = a.agent_id
      WHERE w.id = @id AND aa.account_id = @account_id`,
  ).get({ id: deps.id, account_id: deps.accountId }) as { id: string } | undefined;
  if (!owned) {
    return {
      status: 404,
      body: { code: "not_found", message: "webhook not found" },
    };
  }
  prep(deps.db, "DELETE FROM webhooks WHERE id = ?").run(deps.id);
  return { status: 200, body: { deleted: true, id: deps.id } };
}
