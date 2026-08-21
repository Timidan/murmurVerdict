// ─── Ending things: agent retirement and account deactivation ───────────────
//
// Two markers, migration 073, deliberately at different levels.
//
//   agents.retired_at        the owner stopped ONE agent. It takes no new
//                            calls. Its record stays on the board, its history
//                            stays readable, its keys still read, and its
//                            earnings and payouts are untouched.
//
//   accounts.deactivated_at  the owner closed the WHOLE account. Terminal.
//
// The second is NOT the kill switch, and the distinction is load-bearing. The
// kill switch is an emergency pause with a release route that clears
// `agent_credentials_disabled_at` (see account-kill-switch.ts). If closing an
// account were expressed only through that column, hitting release afterwards
// would reopen a closed account — so deactivation carries its own column and
// every enforcement point checks it separately, never via the kill switch.
//
// There is no reactivation function here on purpose. Reopening a closed
// account is an operator action taken deliberately with a person on the other
// end of it, not a button the closed account can press.

import type Database from "better-sqlite3";

import { agentsRepo } from "../repos/agents-repo.js";
import { ERROR_CODES, VerdictError } from "../schema.js";
import { engageAccountKillSwitch } from "./account-kill-switch.js";
import { listAccountAgents } from "./account-ownership.js";

// NO agent_security_events emission from this module, deliberately.
//
// That table's `kind` is a CLOSED enum with a SQL CHECK, so a new event kind
// costs a table-rebuild migration — and the rebuild would buy nothing here.
// Both markers are already durable, timestamped records on the rows they
// describe (agents.retired_at, accounts.deactivated_at), and deactivation
// engages the kill switch, whose own `account_kill_switch_engaged` event is
// already in the enum and already lands in the audit trail.

// ── Agent retirement ───────────────────────────────────────────────────────

export function agentRetiredAt(
  db: Database.Database,
  agentId: string,
): string | null {
  return agentsRepo.retiredAt(db, agentId);
}

/**
 * The gate for NEW work only.
 *
 * Called from exactly one place in the gateway: inside the reservation's
 * BEGIN IMMEDIATE, after duplicate detection and before the attempt insert.
 * It is deliberately NOT wired into generic runtime-key auth (attempt READS
 * depend on that path, and an owner must still be able to read the history of
 * an agent they retired) and deliberately NOT wired into post-chain
 * acceptance (a call already broadcast must be recorded, or retiring mid-flight
 * orphans a confirmed on-chain call).
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
      // Idempotent: a second retire keeps the ORIGINAL timestamp. Overwriting
      // it would move the moment the agent stopped taking calls, which is the
      // one fact this column exists to record.
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
    // Idempotent either way: unretiring an agent that was never retired is a
    // no-op that reports the state, not an error. The owner's intent is
    // already true.
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
 * Enforcement. Every account route except GET /v1/account/session runs this,
 * and the session route is excluded so the dashboard can still fetch the state
 * it needs in order to render the closed-account screen.
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
 * Close the account. ONE transaction, so a crash halfway cannot leave an
 * account marked closed with live credentials still on it:
 *
 *   1. stamp accounts.deactivated_at
 *   2. engage the kill switch (which revokes every runtime key and rotates
 *      every api key, and emits its own audit event)
 *   3. retire every agent the account owns
 *
 * Step 2 reuses engageAccountKillSwitch rather than re-implementing the
 * revocation: one revoke path means one place to keep correct. The kill switch
 * is a CONSEQUENCE of closing, never the mechanism — assertAccountActive reads
 * deactivated_at and nothing else, so releasing the switch later re-arms
 * minting for an account that is still closed and still refused everywhere.
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

    // engageAccountKillSwitch opens its own transaction. better-sqlite3
    // transactions nest as SAVEPOINTs, so this stays one atomic unit: the
    // outer rollback undoes the inner work too.
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
