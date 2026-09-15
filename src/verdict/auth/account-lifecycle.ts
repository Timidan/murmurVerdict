// ─── Ending things: agent retirement and account deactivation ───────────────
// agents.retired_at: one agent takes no new calls; its history, key reads and earnings stay.
// accounts.deactivated_at: the whole account is closed. Terminal, and NOT the kill switch:
// releasing the switch must not reopen it, so checks read this column. Reopening is operator-only.

import type Database from "better-sqlite3";

import { agentsRepo } from "../repos/agents-repo.js";
import { ERROR_CODES, VerdictError } from "../schema.js";
import { engageAccountKillSwitch } from "./account-kill-switch.js";
import { listAccountAgents } from "./account-ownership.js";

// No agent_security_events here: both markers live on their rows, and the kill switch emits its own event.

// ── Agent retirement ───────────────────────────────────────────────────────

export function agentRetiredAt(
  db: Database.Database,
  agentId: string,
): string | null {
  return agentsRepo.retiredAt(db, agentId);
}

/**
 * Gate for NEW work only, inside the gateway reservation transaction.
 * Not in runtime-key auth (owners still read a retired agent's history) and not in
 * post-chain acceptance (a broadcast call must still be recorded).
 */
export function assertAgentAcceptingCalls(
  db: Database.Database,
  agentId: string,
): void {
  const retiredAt = agentRetiredAt(db, agentId);
  if (retiredAt) {
    throw new VerdictError(
      "this agent is retired and takes no new calls",
      ERROR_CODES.agent_retired,
      409,
      { retired_at: retiredAt },
    );
  }
}

export interface RetireAgentResult {
  retired: boolean;
  /** Already retired before this call. */
  already: boolean;
  retired_at: string | null;
}

export function retireAgent(
  db: Database.Database,
  input: { agent_id: string; now: () => Date },
): RetireAgentResult {
  const ts = input.now().toISOString().replace(/\.\d+Z$/, "Z");
  let result: RetireAgentResult | null = null;
  db.transaction(() => {
    const changed = agentsRepo.setRetiredAt(db, input.agent_id, ts);
    if (!changed) {
      // Idempotent: a second retire keeps the original timestamp.
      result = {
        retired: true,
        already: true,
        retired_at: agentRetiredAt(db, input.agent_id),
      };
      return;
    }
    result = { retired: true, already: false, retired_at: ts };
  }).immediate();
  if (!result) throw new Error("retire transaction produced no result");
  return result;
}

export function unretireAgent(
  db: Database.Database,
  input: { agent_id: string; now: () => Date },
): RetireAgentResult {
  let result: RetireAgentResult | null = null;
  db.transaction(() => {
    const changed = agentsRepo.setRetiredAt(db, input.agent_id, null);
    // Idempotent: unretiring a never-retired agent reports state, not an error.
    result = { retired: false, already: !changed, retired_at: null };
  }).immediate();
  if (!result) throw new Error("unretire transaction produced no result");
  return result;
}

// ── Account deactivation ───────────────────────────────────────────────────

export function accountDeactivatedAt(
  db: Database.Database,
  accountId: string,
): string | null {
  const row = db
    .prepare("SELECT deactivated_at FROM accounts WHERE account_id = ?")
    .get(accountId) as { deactivated_at: string | null } | undefined;
  return row?.deactivated_at ?? null;
}

/**
 * Every account route runs this except GET /v1/account/session, which the
 * dashboard needs to render the closed-account screen.
 */
export function assertAccountActive(
  db: Database.Database,
  accountId: string,
): void {
  const deactivatedAt = accountDeactivatedAt(db, accountId);
  if (deactivatedAt) {
    throw new VerdictError(
      "this account is closed. Contact the operator to reopen it.",
      ERROR_CODES.account_deactivated,
      403,
      { deactivated_at: deactivatedAt },
    );
  }
}

export interface DeactivateAccountResult {
  already_deactivated: boolean;
  deactivated_at: string;
  runtime_keys_revoked: number;
  api_keys_rotated: number;
  agents_retired: number;
}

/**
 * Close the account in ONE transaction, so a crash cannot leave it closed with live
 * credentials: stamp deactivated_at, engage the kill switch (revoke/rotate keys), retire agents.
 * The kill switch is a consequence, not the mechanism: assertAccountActive reads only deactivated_at.
 */
export function deactivateAccount(
  db: Database.Database,
  input: { account_id: string; actor: string; now: () => Date },
): DeactivateAccountResult {
  const ts = input.now().toISOString().replace(/\.\d+Z$/, "Z");
  let result: DeactivateAccountResult | null = null;
  db.transaction(() => {
    const existing = accountDeactivatedAt(db, input.account_id);
    if (existing) {
      result = {
        already_deactivated: true,
        deactivated_at: existing,
        runtime_keys_revoked: 0,
        api_keys_rotated: 0,
        agents_retired: 0,
      };
      return;
    }
    db.prepare(
      "UPDATE accounts SET deactivated_at = ? WHERE account_id = ?",
    ).run(ts, input.account_id);

    // Its nested transaction runs as a SAVEPOINT, so the outer rollback undoes it too.
    const killSwitch = engageAccountKillSwitch(db, {
      account_id: input.account_id,
      actor: input.actor,
      now: input.now,
    });

    let retired = 0;
    for (const link of listAccountAgents(db, input.account_id)) {
      if (agentsRepo.setRetiredAt(db, link.agent_id, ts)) retired += 1;
    }

    result = {
      already_deactivated: false,
      deactivated_at: ts,
      runtime_keys_revoked: killSwitch.runtime_keys_revoked,
      api_keys_rotated: killSwitch.api_keys_rotated,
      agents_retired: retired,
    };
  }).immediate();
  if (!result) throw new Error("deactivate transaction produced no result");
  return result;
}
