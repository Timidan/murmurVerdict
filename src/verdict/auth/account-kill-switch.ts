// ─── Account kill switch ─────────────────────────────────────────────────────
// The account timestamp is the enforcement; bulk revoke alone is not durable (a compromised
// Privy session could re-mint). While engaged, key dispatch, both key mints and gateway
// broadcast claims reject. Release does not restore revoked or rotated credentials.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { agentSecurityEventsRepo } from "../repos/agent-security-events-repo.js";
import { ERROR_CODES, VerdictError } from "../schema.js";

/** Used by key dispatch, both key mints, the runtime-key challenge, and gateway attempt claims. */
export function assertAgentCredentialsEnabled(
  db: Database.Database,
  accountId: string,
): void {
  const disabledAt = agentCredentialsDisabledAt(db, accountId);
  if (disabledAt) {
    throw new VerdictError(
      "account kill switch engaged: agent credentials are disabled",
      ERROR_CODES.agent_credentials_disabled,
      403,
      { disabled_at: disabledAt },
    );
  }
}

export function agentCredentialsDisabledAt(
  db: Database.Database,
  accountId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT agent_credentials_disabled_at FROM accounts WHERE account_id = ?`,
    )
    .get(accountId) as { agent_credentials_disabled_at: string | null } | undefined;
  return row?.agent_credentials_disabled_at ?? null;
}

export interface EngageKillSwitchResult {
  already_engaged: boolean;
  disabled_at: string;
  runtime_keys_revoked: number;
  api_keys_rotated: number;
}

export function engageAccountKillSwitch(
  db: Database.Database,
  input: { account_id: string; actor: string; now: () => Date },
): EngageKillSwitchResult {
  const nowIso = input.now().toISOString();
  let result: EngageKillSwitchResult | null = null;
  db.transaction(() => {
    const existing = agentCredentialsDisabledAt(db, input.account_id);
    if (existing) {
      // Idempotent: keep the original timestamp; revoke and emit nothing.
      result = {
        already_engaged: true,
        disabled_at: existing,
        runtime_keys_revoked: 0,
        api_keys_rotated: 0,
      };
      return;
    }
    db.prepare(
      `UPDATE accounts SET agent_credentials_disabled_at = ? WHERE account_id = ?`,
    ).run(nowIso, input.account_id);
    const rk = db
      .prepare(
        `UPDATE agent_runtime_keys
         SET revoked_at = ?, revoke_reason = 'kill_switch'
         WHERE account_id = ? AND revoked_at IS NULL`,
      )
      .run(nowIso, input.account_id);
    const ak = db
      .prepare(
        `UPDATE api_keys SET rotated_at = ?
         WHERE account_id = ? AND rotated_at IS NULL`,
      )
      .run(nowIso, input.account_id);
    agentSecurityEventsRepo.emit(db, {
      event_id: randomUUID(),
      agent_id: null,
      account_id: input.account_id,
      kind: "account_kill_switch_engaged",
      actor: input.actor,
      payload: {
        runtime_keys_revoked: rk.changes,
        api_keys_rotated: ak.changes,
      },
      created_at: nowIso,
    });
    result = {
      already_engaged: false,
      disabled_at: nowIso,
      runtime_keys_revoked: rk.changes,
      api_keys_rotated: ak.changes,
    };
  }).immediate();
  if (!result) throw new Error("kill-switch engage transaction produced no result");
  return result;
}

export interface ReleaseKillSwitchResult {
  was_engaged: boolean;
  released_at: string | null;
}

export function releaseAccountKillSwitch(
  db: Database.Database,
  input: { account_id: string; actor: string; now: () => Date },
): ReleaseKillSwitchResult {
  const nowIso = input.now().toISOString();
  let result: ReleaseKillSwitchResult | null = null;
  db.transaction(() => {
    // A closed account can never be reopened here (deactivation engages this switch).
    // Read inline: account-lifecycle.ts imports this module.
    const deactivatedAt = (
      db
        .prepare("SELECT deactivated_at FROM accounts WHERE account_id = ?")
        .get(input.account_id) as { deactivated_at: string | null } | undefined
    )?.deactivated_at ?? null;
    if (deactivatedAt) {
      throw new VerdictError(
        "this account is closed. Releasing the kill switch cannot reopen it.",
        ERROR_CODES.account_deactivated,
        403,
        { deactivated_at: deactivatedAt },
      );
    }
    const existing = agentCredentialsDisabledAt(db, input.account_id);
    if (!existing) {
      result = { was_engaged: false, released_at: null };
      return;
    }
    db.prepare(
      `UPDATE accounts SET agent_credentials_disabled_at = NULL WHERE account_id = ?`,
    ).run(input.account_id);
    agentSecurityEventsRepo.emit(db, {
      event_id: randomUUID(),
      agent_id: null,
      account_id: input.account_id,
      kind: "account_kill_switch_released",
      actor: input.actor,
      payload: { engaged_at: existing },
      created_at: nowIso,
    });
    result = { was_engaged: true, released_at: nowIso };
  }).immediate();
  if (!result) throw new Error("kill-switch release transaction produced no result");
  return result;
}
