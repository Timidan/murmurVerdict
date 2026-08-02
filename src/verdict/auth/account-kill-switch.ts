// ─── Account kill switch ─────────────────────────────────────────────────────
//
// One account-level timestamp is the enforcement primitive; the bulk
// revoke/rotate is bookkeeping (per codex review 2026-08-02: revoke-all alone
// is not durable because API-key mint is Privy-gated only, so a compromised
// Privy session could immediately re-mint). While engaged:
//   - runtime-key and API-key dispatch reject (dispatcher),
//   - both key mints reject (surfaces),
//   - queued gateway attempts refuse to claim a broadcast (attempt machine).
// Release is a separate deliberate ceremony and does NOT resurrect revoked
// or rotated credentials — the owner re-mints, which for runtime keys means
// a fresh controller-wallet signature.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { agentSecurityEventsRepo } from "../repos/agent-security-events-repo.js";
import { ERROR_CODES, VerdictError } from "../schema.js";

/**
 * Shared by dispatch (runtime + API key), both key-mint surfaces (and the
 * runtime-key challenge, so the wallet never signs an authorization that
 * cannot mint), and gateway attempt claiming.
 */
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
      // Idempotent re-engage: keep the original timestamp, revoke nothing
      // again, emit nothing — the audit log records ONE engagement.
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
