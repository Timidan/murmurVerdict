import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ControllerWalletKind } from "../controller-wallet.js";
import type { ControllerWalletRow } from "./controller-wallets.js";
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

/**
 * Null-preserving profile backfill for a freshly created account. COALESCE
 * keeps any already-populated column intact, so a real stored value is never
 * clobbered by a null from a partial Privy lookup. Callers gate this on
 * account CREATION — it is not part of the hot read path.
 */
export function backfillAccountProfile(
  db: Database.Database,
  account_id: string,
  profile: { email?: string; primary_login_method?: string },
): void {
  db.prepare(
    `UPDATE accounts SET email = COALESCE(email, ?), primary_login_method = COALESCE(primary_login_method, ?) WHERE account_id = ?`,
  ).run(profile.email ?? null, profile.primary_login_method ?? null, account_id);
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

/**
 * Owned-agent setup projection for the Account Agent Surface listing. One
 * LEFT JOIN across the account_agents bridge, the agents profile row, and the
 * agent_controller_wallets row replaces the Surface's former per-agent
 * fan-out (agents-repo byId + controller-wallet read + raw payout SQL). The
 * controller-wallet columns are hydrated back into a ControllerWalletRow so
 * the Surface can keep calling publicControllerWalletRow for response shaping.
 */
export interface AccountAgentSetupRow {
  agent_id: string;
  linked_at: string;
  display_slug: string | null;
  display_name: string | null;
  kind: string | null;
  wallet_address: string | null;
  chain_id: string | null;
  destination_address: string | null;
  destination_address_updated_at: string | null;
  controller_wallet: ControllerWalletRow | null;
}

interface RawAccountAgentSetupRow {
  agent_id: string;
  linked_at: string;
  display_slug: string | null;
  display_name: string | null;
  kind: string | null;
  wallet_address: string | null;
  chain_id: string | null;
  destination_address: string | null;
  destination_address_updated_at: string | null;
  cw_agent_id: string | null;
  cw_account_id: string | null;
  cw_wallet_address: string | null;
  cw_chain_id: string | null;
  cw_wallet_kind: string | null;
  cw_provider: string | null;
  cw_binding_message: string | null;
  cw_binding_signature: string | null;
  cw_created_at: string | null;
  cw_last_attested_at: string | null;
  cw_reattestation_due_at: string | null;
  cw_last_reattestation_nonce: string | null;
  cw_last_reattestation_message: string | null;
  cw_last_reattestation_signature: string | null;
}

export function listAccountAgentsWithSetup(
  db: Database.Database,
  account_id: string,
): AccountAgentSetupRow[] {
  const rows = db
    .prepare(
      `SELECT
         aa.agent_id                        AS agent_id,
         aa.created_at                      AS linked_at,
         a.display_slug                     AS display_slug,
         a.display_name                     AS display_name,
         a.kind                             AS kind,
         a.wallet_address                   AS wallet_address,
         a.chain_id                         AS chain_id,
         a.destination_address              AS destination_address,
         a.destination_address_updated_at   AS destination_address_updated_at,
         cw.agent_id                        AS cw_agent_id,
         cw.account_id                      AS cw_account_id,
         cw.wallet_address                  AS cw_wallet_address,
         cw.chain_id                        AS cw_chain_id,
         cw.wallet_kind                     AS cw_wallet_kind,
         cw.provider                        AS cw_provider,
         cw.binding_message                 AS cw_binding_message,
         cw.binding_signature               AS cw_binding_signature,
         cw.created_at                      AS cw_created_at,
         cw.last_attested_at                AS cw_last_attested_at,
         cw.reattestation_due_at            AS cw_reattestation_due_at,
         cw.last_reattestation_nonce        AS cw_last_reattestation_nonce,
         cw.last_reattestation_message      AS cw_last_reattestation_message,
         cw.last_reattestation_signature    AS cw_last_reattestation_signature
       FROM account_agents aa
       LEFT JOIN agents a ON a.agent_id = aa.agent_id
       LEFT JOIN agent_controller_wallets cw ON cw.agent_id = aa.agent_id
       WHERE aa.account_id = ?
       ORDER BY aa.created_at ASC`,
    )
    .all(account_id) as RawAccountAgentSetupRow[];

  return rows.map((row) => ({
    agent_id: row.agent_id,
    linked_at: row.linked_at,
    display_slug: row.display_slug,
    display_name: row.display_name,
    kind: row.kind,
    wallet_address: row.wallet_address,
    chain_id: row.chain_id,
    destination_address: row.destination_address,
    destination_address_updated_at: row.destination_address_updated_at,
    controller_wallet:
      row.cw_agent_id === null
        ? null
        : {
            agent_id: row.cw_agent_id,
            account_id: row.cw_account_id as string,
            wallet_address: row.cw_wallet_address as string,
            chain_id: row.cw_chain_id as string,
            wallet_kind: row.cw_wallet_kind as ControllerWalletKind,
            provider: row.cw_provider,
            binding_message: row.cw_binding_message as string,
            binding_signature: row.cw_binding_signature as string,
            created_at: row.cw_created_at as string,
            last_attested_at: row.cw_last_attested_at,
            reattestation_due_at: row.cw_reattestation_due_at,
            last_reattestation_nonce: row.cw_last_reattestation_nonce,
            last_reattestation_message: row.cw_last_reattestation_message,
            last_reattestation_signature: row.cw_last_reattestation_signature,
          },
  }));
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
