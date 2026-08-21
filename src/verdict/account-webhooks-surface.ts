// ─── The owner's own webhook subscriptions ─────────────────────────────────
//
//   GET    /v1/account/webhooks
//   DELETE /v1/account/webhooks/:id
//
// POST /v1/webhooks already exists and already authenticates the account. What
// was missing is everything after creation: the only read was GET
// /v1/webhooks/:id (you must already know the id) and the only delete required
// the HMAC secret in a header — and that secret is shown exactly once, at
// creation, by design. An owner who closed that dialog could never list or
// remove their own subscriptions again.
//
// These two routes close that gap through OWNERSHIP instead of the secret: a
// webhook belongs to the account that owns the agent its `agent_slug` names.
// The secret stays a delivery-verification credential and never becomes a
// management credential.

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
 *
 * The join is through `display_slug` because that is what the webhooks table
 * stores (the fanout matches on it), and the register surface canonicalizes
 * the caller's slug to `display_slug` before insert — so this join sees every
 * row that route can create.
 *
 * `secret` is never selected. It is shown once at creation and never again.
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
 * Delete one subscription this account owns.
 *
 * 200 { deleted: true } on success — a JSON body rather than a bare 204 so the
 * dashboard's shared DELETE client, which always parses a body, can call it
 * like every other account route.
 *
 * 404 when the id is unknown OR belongs to someone else — one response for
 * both, so holding a valid session cannot be used to probe which webhook ids
 * exist. Same uniform-miss posture the register route chose.
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
