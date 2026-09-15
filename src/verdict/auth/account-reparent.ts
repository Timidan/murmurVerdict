import type Database from "better-sqlite3";

// ─── Account reparenting (Privy "Login method transfer") ─────────────────────
// Privy moves a login to another user and deletes the source. Child rows FK accounts
// ON DELETE CASCADE, so they must move to the destination before the source row is deleted.
// Idempotent: a redelivery finds no account for the old DID and returns "source_absent".

export type ReparentStatus =
  | "source_absent"
  | "same_account"
  | "renamed"
  | "merged";

export interface ReparentResult {
  status: ReparentStatus;
  from_account_id: string | null;
  to_account_id: string | null;
  /** Per-table rows moved. Empty for rename / no-op; populated for a merge. */
  moved: Record<string, number>;
}

/**
 * Child tables that FK accounts(account_id) ON DELETE CASCADE; a merge moves them first.
 * agent_security_events is excluded: no FK, and its append-only triggers would abort the txn.
 */
const OWNERSHIP_CHILD_TABLES = [
  "account_agents",
  "api_keys",
  "agent_controller_wallets",
  "agent_controller_wallet_reattestations",
  "agent_runtime_keys",
  "fhenix_gateway_tx_attempts",
  "fhenix_gateway_feed_packet_tx_attempts",
] as const;

/**
 * The live accounts-referencing FK tables differ from {@link OWNERSHIP_CHILD_TABLES}.
 * Hard stop: an unlisted table would be cascade-deleted with the source account.
 */
export class AccountReparentSchemaDriftError extends Error {
  readonly code = "account_reparent_schema_drift" as const;

  constructor(message: string) {
    super(message);
    this.name = "AccountReparentSchemaDriftError";
  }
}

/** Source-owned rows remain after the move; guards the cascade on source delete. */
export class AccountReparentIncompleteMoveError extends Error {
  readonly code = "account_reparent_incomplete_move" as const;

  constructor(message: string) {
    super(message);
    this.name = "AccountReparentIncompleteMoveError";
  }
}

interface ForeignKeyListRow {
  table: string;
}

/** Assert the tables with an FK to `accounts` equal OWNERSHIP_CHILD_TABLES. Runs before any mutation. */
function assertOwnershipTablesUnchanged(db: Database.Database): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;

  const referencing = new Set<string>();
  for (const { name } of tables) {
    const fks = db
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`)
      .all() as ForeignKeyListRow[];
    if (fks.some((fk) => fk.table === "accounts")) {
      referencing.add(name);
    }
  }

  const expected = new Set<string>(OWNERSHIP_CHILD_TABLES);
  const missing = [...expected].filter((t) => !referencing.has(t)).sort();
  const unexpected = [...referencing].filter((t) => !expected.has(t)).sort();

  if (missing.length > 0 || unexpected.length > 0) {
    throw new AccountReparentSchemaDriftError(
      "account_reparent_schema_drift: accounts-referencing FK tables changed" +
        (missing.length > 0 ? `; missing=[${missing.join(", ")}]` : "") +
        (unexpected.length > 0 ? `; unexpected=[${unexpected.join(", ")}]` : ""),
    );
  }
}

interface AccountIdentityRow {
  account_id: string;
  email: string | null;
  primary_login_method: string | null;
  /** Kill switch. Reversible — but a merge must not reverse it. */
  agent_credentials_disabled_at: string | null;
  /** Account closed by its owner. Terminal. */
  deactivated_at: string | null;
}

function resolveByPrivyUserId(
  db: Database.Database,
  privyUserId: string,
): AccountIdentityRow | null {
  const row = db
    .prepare(
      `SELECT account_id, email, primary_login_method,
              agent_credentials_disabled_at, deactivated_at
         FROM accounts WHERE privy_user_id = ?`,
    )
    .get(privyUserId) as AccountIdentityRow | undefined;
  return row ?? null;
}

/** Earlier of two timestamps, ignoring nulls; carries a lockout across a merge. */
function earlierMarker(a: string | null, b: string | null): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a <= b ? a : b;
}

/**
 * Mirror a Privy login transfer in one BEGIN IMMEDIATE transaction.
 *   - "source_absent": no source account (fresh or redelivered). No-op.
 *   - "same_account": both resolve to one account. No-op.
 *   - "renamed": no destination account; the source row is re-pointed to the destination DID.
 *   - "merged": children move to the destination, blank profile fields backfill, source deleted.
 */
export function reparentAccount(
  db: Database.Database,
  args: { fromPrivyUserId: string; toPrivyUserId: string },
): ReparentResult {
  const txn = db.transaction(
    (input: { fromPrivyUserId: string; toPrivyUserId: string }): ReparentResult => {
      const { fromPrivyUserId, toPrivyUserId } = input;

      // 1. Resolve source. Absent → nothing to move (already processed / fresh).
      const source = resolveByPrivyUserId(db, fromPrivyUserId);
      if (!source) {
        const dest = resolveByPrivyUserId(db, toPrivyUserId);
        return {
          status: "source_absent",
          from_account_id: null,
          to_account_id: dest?.account_id ?? null,
          moved: {},
        };
      }

      // 2. Resolve destination. Same DID, or same underlying account → no-op.
      const dest = resolveByPrivyUserId(db, toPrivyUserId);
      if (
        fromPrivyUserId === toPrivyUserId ||
        (dest && dest.account_id === source.account_id)
      ) {
        return {
          status: "same_account",
          from_account_id: source.account_id,
          to_account_id: source.account_id,
          moved: {},
        };
      }

      // 3. Abort before any mutation if the FK table set drifted.
      assertOwnershipTablesUnchanged(db);

      // 4. Destination-absent rename fast path. Re-point the source account row
      //    to the destination DID; account_id and every child row are preserved.
      if (!dest) {
        db.prepare(
          "UPDATE accounts SET privy_user_id = @to WHERE account_id = @fromId",
        ).run({ to: toPrivyUserId, fromId: source.account_id });
        return {
          status: "renamed",
          from_account_id: source.account_id,
          to_account_id: source.account_id,
          moved: {},
        };
      }

      // 5. Destination exists → MERGE.
      // Credentials do not survive a change of hands: revoke/rotate the source's keys first.
      // Not via engageAccountKillSwitch: its marker would be merged onto the destination.
      const reparentTs = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      db.prepare(
        `UPDATE agent_runtime_keys
         SET revoked_at = ?, revoke_reason = 'account_reparent'
         WHERE account_id = ? AND revoked_at IS NULL`,
      ).run(reparentTs, source.account_id);
      db.prepare(
        `UPDATE api_keys SET rotated_at = ?
         WHERE account_id = ? AND rotated_at IS NULL`,
      ).run(reparentTs, source.account_id);

      const moved: Record<string, number> = {};
      for (const table of OWNERSHIP_CHILD_TABLES) {
        const result = db
          .prepare(
            `UPDATE ${table} SET account_id = @toId WHERE account_id = @fromId`,
          )
          .run({ toId: dest.account_id, fromId: source.account_id });
        moved[table] = result.changes;
      }

      // Profile fields backfill only where the destination is blank.
      // Lockout markers fail closed: the survivor keeps either side's, at the earlier time.
      const mergedDisabledAt = earlierMarker(
        source.agent_credentials_disabled_at,
        dest.agent_credentials_disabled_at,
      );
      const mergedDeactivatedAt = earlierMarker(
        source.deactivated_at,
        dest.deactivated_at,
      );
      db.prepare(
        `UPDATE accounts
            SET email = CASE
                  WHEN email IS NULL OR trim(email) = '' THEN @srcEmail
                  ELSE email
                END,
                primary_login_method = CASE
                  WHEN primary_login_method IS NULL OR trim(primary_login_method) = '' THEN @srcLogin
                  ELSE primary_login_method
                END,
                agent_credentials_disabled_at = @mergedDisabledAt,
                deactivated_at = @mergedDeactivatedAt
          WHERE account_id = @toId`,
      ).run({
        srcEmail: source.email,
        srcLogin: source.primary_login_method,
        mergedDisabledAt,
        mergedDeactivatedAt,
        toId: dest.account_id,
      });

      // A closed account owns no working agents: retire everything the survivor owns.
      if (mergedDeactivatedAt) {
        db.prepare(
          `UPDATE agents
              SET retired_at = @ts
            WHERE retired_at IS NULL
              AND agent_id IN (
                SELECT agent_id FROM account_agents WHERE account_id = @toId
              )`,
        ).run({ ts: mergedDeactivatedAt, toId: dest.account_id });
      }

      // Assert no source-owned rows remain before deleting the source account
      // (else the ON DELETE CASCADE would silently erase them).
      for (const table of OWNERSHIP_CHILD_TABLES) {
        const remaining = db
          .prepare(
            `SELECT COUNT(*) AS n FROM ${table} WHERE account_id = @fromId`,
          )
          .get({ fromId: source.account_id }) as { n: number };
        if (remaining.n > 0) {
          throw new AccountReparentIncompleteMoveError(
            `account_reparent_incomplete_move: ${remaining.n} row(s) still owned by source in ${table}`,
          );
        }
      }

      db.prepare("DELETE FROM accounts WHERE account_id = @fromId").run({
        fromId: source.account_id,
      });

      return {
        status: "merged",
        from_account_id: source.account_id,
        to_account_id: dest.account_id,
        moved,
      };
    },
  );

  return txn.immediate(args);
}
