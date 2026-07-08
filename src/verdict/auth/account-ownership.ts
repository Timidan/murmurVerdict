import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { PrivyClaims } from "./privy.js";

export interface AccountRow {
  account_id: string;
  privy_user_id: string;
  email: string | null;
  primary_login_method: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface AccountAgentLink {
  account_id: string;
  agent_id: string;
  created_at: string;
}

export type AccountIdAdapter = () => string;

export interface GetOrCreateAccountInput {
  resolvedAt: Date;
  newAccountId?: AccountIdAdapter;
}

export interface LinkAgentToAccountInput {
  linkedAt: Date;
}

function stripIso(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

export function getOrCreateAccount(
  db: Database.Database,
  claims: PrivyClaims,
  input: GetOrCreateAccountInput,
): { account_id: string; created: boolean } {
  const txn = db.transaction(() => {
    const existing = db
      .prepare(
        "SELECT account_id FROM accounts WHERE privy_user_id = ?",
      )
      .get(claims.privy_user_id) as { account_id: string } | undefined;

    if (existing) {
      db.prepare(
        "UPDATE accounts SET last_seen_at = ? WHERE account_id = ?",
      ).run(stripIso(input.resolvedAt), existing.account_id);
      return { account_id: existing.account_id, created: false };
    }

    const account_id = (input.newAccountId ?? randomUUID)();
    const ts = stripIso(input.resolvedAt);
    db.prepare(
      `INSERT INTO accounts (
         account_id, privy_user_id, email, primary_login_method,
         created_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      account_id,
      claims.privy_user_id,
      claims.email ?? null,
      claims.primary_login_method ?? null,
      ts,
      ts,
    );
    return { account_id, created: true };
  });
  return txn();
}

export function getAccountById(
  db: Database.Database,
  account_id: string,
): AccountRow | null {
  const row = db
    .prepare("SELECT * FROM accounts WHERE account_id = ?")
    .get(account_id) as AccountRow | undefined;
  return row ?? null;
}

export function getAccountByPrivyUserId(
  db: Database.Database,
  privy_user_id: string,
): AccountRow | null {
  const row = db
    .prepare("SELECT * FROM accounts WHERE privy_user_id = ?")
    .get(privy_user_id) as AccountRow | undefined;
  return row ?? null;
}

/**
 * Mode-explicit front door for "verified Privy claims → Murmur account",
 * shared by the three Privy auth paths (dispatcher, account route auth,
 * webhook route auth). The read-vs-create divergence between those paths is
 * deliberate; routing them through one named mode keeps the choice visible
 * instead of three hand-rolled copies that can silently drift.
 *
 *   "read"            — never creates; for paths where an account must already
 *                       exist (gateway/feed dispatch, webhook auth fall-back).
 *   "create_or_touch" — creates on first sight and updates last_seen_at; for
 *                       the account/session entry path. Always yields an id.
 */
export function resolveAccountForClaims(
  db: Database.Database,
  claims: PrivyClaims,
  opts: { mode: "create_or_touch"; resolvedAt: Date; newAccountId?: AccountIdAdapter },
): { account_id: string; created: boolean };
export function resolveAccountForClaims(
  db: Database.Database,
  claims: PrivyClaims,
  opts: { mode: "read" },
): { account_id: string | null; created: false };
export function resolveAccountForClaims(
  db: Database.Database,
  claims: PrivyClaims,
  opts:
    | { mode: "create_or_touch"; resolvedAt: Date; newAccountId?: AccountIdAdapter }
    | { mode: "read" },
): { account_id: string | null; created: boolean } {
  if (opts.mode === "create_or_touch") {
    return getOrCreateAccount(db, claims, {
      resolvedAt: opts.resolvedAt,
      newAccountId: opts.newAccountId,
    });
  }
  const account = getAccountByPrivyUserId(db, claims.privy_user_id);
  return { account_id: account?.account_id ?? null, created: false };
}

export class AgentAlreadyOwnedError extends Error {
  readonly code = "agent_already_owned_by_another_account" as const;
  readonly agent_id: string;

  constructor(agent_id: string) {
    super(
      `agent ${agent_id} is already owned by a different account`,
    );
    this.name = "AgentAlreadyOwnedError";
    this.agent_id = agent_id;
  }
}

export function linkAgentToAccount(
  db: Database.Database,
  account_id: string,
  agent_id: string,
  input: LinkAgentToAccountInput,
): void {
  const txn = db.transaction(() => {
    const existing = db
      .prepare(
        "SELECT account_id FROM account_agents WHERE agent_id = ? LIMIT 1",
      )
      .get(agent_id) as { account_id: string } | undefined;
    if (existing) {
      if (existing.account_id === account_id) {
        return;
      }
      throw new AgentAlreadyOwnedError(agent_id);
    }
    try {
      db.prepare(
        `INSERT INTO account_agents (account_id, agent_id, created_at)
         VALUES (?, ?, ?)`,
      ).run(account_id, agent_id, stripIso(input.linkedAt));
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
        /account_agents.+agent_id/i.test(err.message)
      ) {
        throw new AgentAlreadyOwnedError(agent_id);
      }
      throw err;
    }
  });
  txn();
}

export function listAccountAgents(
  db: Database.Database,
  account_id: string,
): Array<{ agent_id: string; created_at: string }> {
  return db
    .prepare(
      `SELECT agent_id, created_at FROM account_agents
       WHERE account_id = ?
       ORDER BY created_at ASC`,
    )
    .all(account_id) as Array<{ agent_id: string; created_at: string }>;
}

export function getAccountForAgent(
  db: Database.Database,
  agent_id: string,
): string | null {
  const row = db
    .prepare(
      "SELECT account_id FROM account_agents WHERE agent_id = ? LIMIT 1",
    )
    .get(agent_id) as { account_id: string } | undefined;
  return row?.account_id ?? null;
}
