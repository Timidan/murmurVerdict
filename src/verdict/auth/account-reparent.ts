import type Database from "better-sqlite3";

// ─── Account reparenting (Privy "Login method transfer") ─────────────────────
//
// When Privy moves a login from a source user (DID) to a destination user and
// DELETES the source, Murmur must move its ownership from the source account to
// the destination account. Ownership is keyed by accounts.account_id, and every
// owned child row FK-references accounts(account_id) ON DELETE CASCADE — so a
// naive "delete the source account" would cascade-erase the children. We must
// therefore MOVE the children onto the destination account before deleting the
// source row.
//
// Idempotency: Privy webhooks may be redelivered. The FIRST delivery renames or
// merges the source into the destination and (for a merge) deletes the source
// account row. A SECOND delivery of the same transfer resolves the source by its
// old DID, finds it absent (already renamed/merged away), and returns
// "source_absent" as a no-op. No compensating state is required — the operation
// is naturally idempotent because it keys off the source DID that no longer maps
// to any account after the first run.

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
 * The seven child tables that FK-reference accounts(account_id) ON DELETE
 * CASCADE. Ownership rides entirely on the account_id column, so a merge MOVES
 * these rows to the destination before the source account row is deleted.
 *
 * DELIBERATELY EXCLUDED: agent_security_events. It carries an account_id column
 * but has NO foreign key to accounts, and BEFORE UPDATE / BEFORE DELETE triggers
 * RAISE(ABORT, 'agent_security_events rows are append-only'). Touching it would
 * abort the whole transaction, so the audit trail is left pointing at the source
 * account_id on purpose — a merge preserves history, it does not rewrite it.
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
 * Thrown when the live schema's set of accounts-referencing FK tables no longer
 * equals {@link OWNERSHIP_CHILD_TABLES}. This is a hard stop: a newly added
 * ownership table that we don't move here would be silently cascade-deleted when
 * the source account row is removed. Adding a table to the schema must be paired
 * with adding it to OWNERSHIP_CHILD_TABLES.
 */
export class AccountReparentSchemaDriftError extends Error {
  readonly code = "account_reparent_schema_drift" as const;

  constructor(message: string) {
    super(message);
    this.name = "AccountReparentSchemaDriftError";
  }
}

/**
 * Thrown if, after moving every child table, any source-owned row still remains.
 * This should be impossible under the one-agent-per-account invariant; it guards
 * against a partial move silently dropping data on the subsequent source delete.
 */
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

/**
 * Enumerate every table whose foreign keys reference `accounts`, then assert the
 * set equals OWNERSHIP_CHILD_TABLES exactly. Runs inside the reparent txn so a
 * drift aborts (and rolls back) before any mutation.
 */
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
  /** Account closed by its owner (migration 073). Terminal. */
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

/**
 * The earlier of two timestamps, ignoring nulls. Null when both are null.
 *
 * Used to carry a lockout across a merge: whichever side locked first is when
 * this identity stopped being usable, and that is the honest timestamp for the
 * survivor to keep.
 */
function earlierMarker(a: string | null, b: string | null): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a <= b ? a : b;
}

/**
 * Move Murmur ownership from the account behind `fromPrivyUserId` to the account
 * behind `toPrivyUserId`, mirroring a Privy "Login method transfer" that deleted
 * the source user. Runs in a single BEGIN IMMEDIATE transaction so it serializes
 * against other writers and any thrown error rolls the whole thing back.
 *
 * Statuses:
 *   - "source_absent" — no account for `fromPrivyUserId` (fresh, or an already
 *     processed/redelivered transfer). No-op.
 *   - "same_account"  — from and to resolve to the same account. No-op.
 *   - "renamed"       — destination DID has no account row yet; the source
 *     account is re-pointed to the destination DID, preserving account_id and
 *     every child row.
 *   - "merged"        — destination account exists; children are moved onto it,
 *     its blank profile fields are backfilled from the source, and the source
 *     account row is deleted.
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

      // 3. Schema-drift guard — abort before any mutation if the set of
      //    accounts-referencing FK tables no longer matches what we move.
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

      // 5. Destination exists → MERGE. Move each child table's source-owned rows
      //    onto the destination account, recording how many moved.
      // Credentials do not survive a change of hands (security review R2).
      // The source's runtime keys are revoked and its api keys rotated BEFORE
      // the ownership move, with their own reason — deliberately NOT via
      // engageAccountKillSwitch, which would stamp a disabled-marker that the
      // fail-closed merge below would then impose on a destination that never
      // chose it. Owners re-mint deliberately after a merge.
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

      // Backfill the destination's profile from the source ONLY where the
      // destination is blank — a populated destination field always wins.
      //
      // FAIL-CLOSED on the two lockout markers, which is the opposite rule.
      //
      // Profile fields merge permissively because a blank email is an absence.
      // A kill switch or a closed account is not an absence; it is a decision,
      // and a merge that dropped it would let an owner un-close an account by
      // transferring a login onto it — a route that never asked anyone whether
      // reopening was intended. So the survivor inherits EITHER side's marker,
      // stamped at whichever moment came first.
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

      // A closed account owns no working agents. The agents that just moved
      // here came from (or joined) a closed account, so retire everything the
      // survivor now owns — including the destination's own agents, which are
      // equally covered by the surviving closed state.
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
