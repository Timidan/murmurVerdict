import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { openDb } from "../db.js";
import { getAccountById, getAccountByPrivyUserId } from "./accounts.js";
import {
  AccountReparentSchemaDriftError,
  reparentAccount,
} from "./account-reparent.js";

process.stdout.write("murmur Account Reparent smoke\n");

const TS = "2026-07-18T00:00:00Z";
const CHILD_TABLES = [
  "account_agents",
  "api_keys",
  "agent_controller_wallets",
  "agent_controller_wallet_reattestations",
  "agent_runtime_keys",
] as const;

const tmp = mkdtempSync(join(tmpdir(), "murmur-account-reparent-"));
let dbSeq = 0;
const openScratch = (): Database.Database =>
  openDb({ path: join(tmp, `t-${dbSeq++}.db`) });

function seedAccount(
  db: Database.Database,
  accountId: string,
  privyUserId: string,
  profile?: { email?: string | null; login?: string | null },
): void {
  db.prepare(
    `INSERT INTO accounts
       (account_id, privy_user_id, email, primary_login_method, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    privyUserId,
    profile?.email ?? null,
    profile?.login ?? null,
    TS,
    TS,
  );
}

function seedAgent(db: Database.Database, agentId: string, slug: string): void {
  db.prepare(
    `INSERT INTO agents
       (agent_id, display_slug, kind, display_name, bio, created_at, api_key_hash)
     VALUES (?, ?, 'agent', ?, NULL, ?, NULL)`,
  ).run(agentId, slug, `Agent ${slug}`, TS);
}

/** Seed one owned row in each of the five populated child tables. */
function seedChildren(
  db: Database.Database,
  accountId: string,
  agentId: string,
  suffix: string,
): void {
  db.prepare(
    `INSERT INTO account_agents (account_id, agent_id, created_at) VALUES (?, ?, ?)`,
  ).run(accountId, agentId, TS);

  db.prepare(
    `INSERT INTO api_keys
       (api_key_id, account_id, agent_id, api_key_hash, label, created_at, rotated_at)
     VALUES (?, ?, ?, ?, 'key', ?, NULL)`,
  ).run(`apikey-${suffix}`, accountId, agentId, `hash-${suffix}`, TS);

  db.prepare(
    `INSERT INTO agent_controller_wallets
       (agent_id, account_id, wallet_address, chain_id, wallet_kind, provider,
        binding_message, binding_signature, created_at)
     VALUES (?, ?, ?, '8008135', 'embedded', NULL, 'bind-msg', 'bind-sig', ?)`,
  ).run(agentId, accountId, `0xwallet-${suffix}`, TS);

  db.prepare(
    `INSERT INTO agent_runtime_keys
       (runtime_key_id, account_id, agent_id, runtime_key_hash, runtime_key_prefix,
        label, policy_json, policy_hash, controller_wallet_address, controller_chain_id,
        authorization_nonce, authorization_message, authorization_signature, created_at)
     VALUES (?, ?, ?, ?, 'rtk_', NULL, '{}', 'policyhash', ?, '8008135',
             ?, ?, 'authsig', ?)`,
  ).run(
    `rtk-${suffix}`,
    accountId,
    agentId,
    `rtkhash-${suffix}`,
    `0xwallet-${suffix}`,
    `nonce-${suffix}`,
    `authmsg-${suffix}`,
    TS,
  );

  db.prepare(
    `INSERT INTO agent_controller_wallet_reattestations
       (attestation_id, account_id, agent_id, wallet_address, chain_id,
        attestation_nonce, attestation_message, attestation_signature, attested_at, next_due_at)
     VALUES (?, ?, ?, ?, '8008135', ?, 'att-msg', 'att-sig', ?, ?)`,
  ).run(
    `att-${suffix}`,
    accountId,
    agentId,
    `0xwallet-${suffix}`,
    `attnonce-${suffix}`,
    TS,
    TS,
  );
}

function countOwned(
  db: Database.Database,
  table: string,
  accountId: string,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`)
    .get(accountId) as { n: number };
  return row.n;
}

try {
  // ── Scenario 1: MERGE (destination account exists) + audit unchanged ──────
  {
    const db = openScratch();
    seedAccount(db, "acct-A", "did:privy:A", { email: "src@a.test", login: "email" });
    seedAccount(db, "acct-B", "did:privy:B"); // blank profile → backfilled below
    seedAgent(db, "agent-1", "agent-one");
    seedChildren(db, "acct-A", "agent-1", "merge");

    // Audit row under A — no FK to accounts, append-only triggers guard it.
    db.prepare(
      `INSERT INTO agent_security_events
         (event_id, agent_id, account_id, kind, actor, payload_json, created_at)
       VALUES ('evt-1', 'agent-1', 'acct-A', 'admin_claim', 'operator', '{}', ?)`,
    ).run(TS);

    const result = reparentAccount(db, {
      fromPrivyUserId: "did:privy:A",
      toPrivyUserId: "did:privy:B",
    });

    assert.equal(result.status, "merged");
    assert.equal(result.from_account_id, "acct-A");
    assert.equal(result.to_account_id, "acct-B");

    // moved counts: the five seeded tables each moved exactly one row.
    for (const table of CHILD_TABLES) {
      assert.equal(result.moved[table], 1, `moved.${table}`);
    }
    // The two (empty) gateway tables are reported with a 0 count.
    assert.equal(result.moved.fhenix_gateway_tx_attempts, 0);
    assert.equal(result.moved.fhenix_gateway_feed_packet_tx_attempts, 0);
    const totalMoved = Object.values(result.moved).reduce((a, b) => a + b, 0);
    assert.ok(totalMoved > 0, "expected some rows moved");

    // Every child row now belongs to B; none remain under A.
    for (const table of CHILD_TABLES) {
      assert.equal(countOwned(db, table, "acct-B"), 1, `B owns ${table}`);
      assert.equal(countOwned(db, table, "acct-A"), 0, `A drained of ${table}`);
    }

    // Source account row deleted; destination survives with backfilled profile.
    assert.equal(getAccountById(db, "acct-A"), null);
    const bRow = getAccountById(db, "acct-B");
    assert.ok(bRow);
    assert.equal(bRow.email, "src@a.test", "dest email backfilled from source");
    assert.equal(bRow.primary_login_method, "email", "dest login backfilled");

    // AUDIT UNCHANGED: the security event still references A and was not moved.
    const evt = db
      .prepare("SELECT account_id, agent_id FROM agent_security_events WHERE event_id = 'evt-1'")
      .get() as { account_id: string; agent_id: string };
    assert.equal(evt.account_id, "acct-A", "audit trail preserved (points at A)");
    assert.equal(evt.agent_id, "agent-1");

    // Idempotency: a redelivered transfer finds the source absent → no-op.
    const replay = reparentAccount(db, {
      fromPrivyUserId: "did:privy:A",
      toPrivyUserId: "did:privy:B",
    });
    assert.equal(replay.status, "source_absent");
    assert.equal(replay.from_account_id, null);
    assert.equal(replay.to_account_id, "acct-B");
    assert.deepEqual(replay.moved, {});

    db.close();
    process.stdout.write("  merge + idempotency + audit-unchanged ok\n");
  }

  // ── Scenario 2: RENAME (destination DID absent) ───────────────────────────
  {
    const db = openScratch();
    seedAccount(db, "acct-A", "did:privy:old");
    seedAgent(db, "agent-1", "agent-one");
    seedChildren(db, "acct-A", "agent-1", "rename");

    const result = reparentAccount(db, {
      fromPrivyUserId: "did:privy:old",
      toPrivyUserId: "did:privy:new",
    });

    assert.equal(result.status, "renamed");
    assert.equal(result.from_account_id, "acct-A");
    assert.equal(result.to_account_id, "acct-A"); // account_id preserved
    assert.deepEqual(result.moved, {});

    // Old DID gone, new DID resolves to the SAME account_id; children intact.
    assert.equal(getAccountByPrivyUserId(db, "did:privy:old"), null);
    const renamed = getAccountByPrivyUserId(db, "did:privy:new");
    assert.ok(renamed);
    assert.equal(renamed.account_id, "acct-A");
    for (const table of CHILD_TABLES) {
      assert.equal(countOwned(db, table, "acct-A"), 1, `children intact: ${table}`);
    }

    db.close();
    process.stdout.write("  rename ok\n");
  }

  // ── Scenario 3: SAME_ACCOUNT (from === to) ────────────────────────────────
  {
    const db = openScratch();
    seedAccount(db, "acct-A", "did:privy:same");
    seedAgent(db, "agent-1", "agent-one");
    seedChildren(db, "acct-A", "agent-1", "same");

    const result = reparentAccount(db, {
      fromPrivyUserId: "did:privy:same",
      toPrivyUserId: "did:privy:same",
    });

    assert.equal(result.status, "same_account");
    assert.equal(result.from_account_id, "acct-A");
    assert.equal(result.to_account_id, "acct-A");
    assert.deepEqual(result.moved, {});
    // Untouched.
    assert.equal(countOwned(db, "account_agents", "acct-A"), 1);

    db.close();
    process.stdout.write("  same_account ok\n");
  }

  // ── Scenario 4: SCHEMA-DRIFT GUARD throws on a new accounts-referencing FK ─
  {
    const db = openScratch();
    seedAccount(db, "acct-A", "did:privy:A");
    seedAccount(db, "acct-B", "did:privy:B");
    seedAgent(db, "agent-1", "agent-one");
    seedChildren(db, "acct-A", "agent-1", "drift");

    // Introduce a NEW table with an FK to accounts that reparent doesn't move.
    db.exec(
      `CREATE TABLE dummy_owned (
         id TEXT PRIMARY KEY,
         account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE
       )`,
    );

    assert.throws(
      () =>
        reparentAccount(db, {
          fromPrivyUserId: "did:privy:A",
          toPrivyUserId: "did:privy:B",
        }),
      (err) =>
        err instanceof AccountReparentSchemaDriftError &&
        err.code === "account_reparent_schema_drift" &&
        /dummy_owned/.test(err.message),
    );

    // Rollback: nothing moved, source account intact.
    assert.ok(getAccountById(db, "acct-A"));
    assert.equal(countOwned(db, "account_agents", "acct-A"), 1);
    assert.equal(countOwned(db, "account_agents", "acct-B"), 0);

    db.close();
    process.stdout.write("  schema-drift guard ok\n");
  }

  // ── Scenario 5: source absent from the very start → no-op ──────────────────
  {
    const db = openScratch();
    seedAccount(db, "acct-B", "did:privy:B");

    const result = reparentAccount(db, {
      fromPrivyUserId: "did:privy:ghost",
      toPrivyUserId: "did:privy:B",
    });
    assert.equal(result.status, "source_absent");
    assert.equal(result.from_account_id, null);
    assert.equal(result.to_account_id, "acct-B");
    assert.deepEqual(result.moved, {});

    db.close();
    process.stdout.write("  source_absent (fresh) ok\n");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("Account Reparent smoke ok\n");
