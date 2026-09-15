import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { openDb } from "./db.js";
import { LATEST_DB_MIGRATION_VERSION } from "./db-migrations.js";

process.stdout.write("murmur db migration upgrade smoke\n");

/**
 * Migrations must be tested by UPGRADING an existing database, not only by
 * creating a fresh one.
 *
 * A fresh database runs every migration in sequence, so it looks correct even
 * when a migration is broken for real deployments. The failure mode this
 * guards is: widening an ALREADY-SHIPPED migration in place. A database that
 * recorded that version skips the widened block forever, ending up with the
 * version stamp of the new schema and the columns of the old one — and then
 * every insert referencing the new column fails at runtime.
 *
 * That is not hypothetical: `submission_class` was first added by extending
 * migration 064 in place, which produced exactly this state.
 */

const tmp = mkdtempSync(join(tmpdir(), "db-upgrade-"));
const path = join(tmp, "verdict.db");

// Build the latest shape, then rewind it to look like a database that stopped
// at migration 064: version 64, canonical column absent.
{
  const fresh = openDb({ path });
  fresh.exec("ALTER TABLE fhenix_sealed_calls DROP COLUMN submission_class");
  // Also drop the columns 066/067 add, so the rewind exercises every step from
  // 64 forward rather than only the one that first motivated this test.
  fresh.exec("ALTER TABLE polymarket_discovery_state DROP COLUMN broadcast_started_at");
  fresh.exec("ALTER TABLE markets DROP COLUMN operator_halted_at");
  fresh.exec("DROP TABLE entitlement_payment_bindings");
  fresh.exec("ALTER TABLE agent_runtime_keys DROP COLUMN last_heartbeat_at");
  fresh.exec("ALTER TABLE agents DROP COLUMN deleted_at");
  fresh.exec("ALTER TABLE agent_runtime_keys DROP COLUMN last_contact_at");
  fresh.exec("ALTER TABLE agent_runtime_keys DROP COLUMN runtime_mode");
  fresh.prepare("UPDATE schema_meta SET value='64' WHERE key='schema_version'").run();
  fresh.close();
}

{
  const pre = new Database(path);
  const cols = pre.prepare("PRAGMA table_info(fhenix_sealed_calls)").all() as { name: string }[];
  assert.equal(
    cols.some((c) => c.name === "submission_class"),
    false,
    "precondition: the simulated old database lacks the canonical column",
  );
  assert.equal(
    (pre.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }).value,
    "64",
  );
  pre.close();
}

// Reopening must carry it forward.
{
  const upgraded = openDb({ path });
  const version = (
    upgraded.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    }
  ).value;
  assert.equal(
    version,
    String(LATEST_DB_MIGRATION_VERSION),
    "upgrade reaches the latest schema version",
  );
  assert.ok((upgraded.prepare("PRAGMA table_info(agents)").all() as { name: string }[])
    .some((column) => column.name === "deleted_at"), "upgrade adds permanent agent deletion (078)");

  const cols = upgraded.prepare("PRAGMA table_info(fhenix_sealed_calls)").all() as {
    name: string;
  }[];
  assert.ok(
    cols.some((c) => c.name === "submission_class"),
    "an existing v64 database must gain submission_class — a version stamp without the column is the bug this test exists for",
  );
  const runtimeKeyCols = upgraded.prepare("PRAGMA table_info(agent_runtime_keys)").all() as {
    name: string;
  }[];
  assert.ok(
    runtimeKeyCols.some((c) => c.name === "last_heartbeat_at"),
    "an existing v64 database must gain runtime key heartbeat presence (077)",
  );

  assert.ok(runtimeKeyCols.some((c) => c.name === "last_contact_at"));
  assert.ok(runtimeKeyCols.some((c) => c.name === "runtime_mode"));

  const discoveryCols = upgraded
    .prepare("PRAGMA table_info(polymarket_discovery_state)")
    .all() as { name: string }[];
  assert.ok(
    discoveryCols.some((c) => c.name === "broadcast_started_at"),
    "an existing v64 database must gain broadcast_started_at (066)",
  );
  const marketCols = upgraded.prepare("PRAGMA table_info(markets)").all() as {
    name: string;
  }[];
  assert.ok(
    marketCols.some((c) => c.name === "operator_halted_at"),
    "an existing v64 database must gain markets.operator_halted_at (067)",
  );
  const bindings = upgraded
    .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?")
    .get("entitlement_payment_bindings") as { c: number };
  assert.equal(
    bindings.c,
    1,
    "an existing v64 database must gain entitlement_payment_bindings (068)",
  );

  // Migration 064's own columns/tables must survive the upgrade too.
  for (const table of ["market_series", "market_clocks"]) {
    const found = upgraded
      .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { c: number };
    assert.equal(found.c, 1, `${table} survives the upgrade`);
  }

  upgraded.close();
}

rmSync(tmp, { recursive: true, force: true });
process.stdout.write("OK db migration upgrade smoke\n");
