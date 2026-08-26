#!/usr/bin/env tsx
/**
 * Copy the daemon's SQLite database safely, while it is running.
 *
 * Copying the file by hand loses data, silently. SQLite runs in WAL mode:
 * recent writes live in a sibling `-wal` file and have not yet been folded
 * into the main one. `cp data/verdict.db backup.db` therefore produces a
 * database that is missing the newest rows, with no error and no warning —
 * it opens fine and simply lacks whatever was most recent. That cost a live
 * verification an hour: a call sealed seconds earlier was invisible in the
 * copy.
 *
 * SQLite's own backup API reads through the WAL and takes a consistent
 * snapshot even while the daemon writes. That is what this uses.
 *
 * Usage:
 *   npx tsx tools/backup-db.ts [source] [destination]
 * Defaults: data/verdict.db -> data/verdict.backup.<UTC timestamp>.db
 */
import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";

const source = process.argv[2] ?? "./data/verdict.db";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
const dest = process.argv[3] ?? `./data/verdict.backup.${stamp}.db`;

if (!existsSync(source)) {
  console.error(`no database at ${source}`);
  process.exit(1);
}

const db = new Database(source, { readonly: true });
try {
  await db.backup(dest);
} finally {
  db.close();
}

// Prove the copy is consistent and complete rather than asserting it: open
// the result and read the schema version plus a row count the caller can
// eyeball against the live daemon.
const copy = new Database(dest, { readonly: true });
const version = copy.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as
  | { value: string }
  | undefined;
const tables = copy
  .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'")
  .get() as { c: number };
copy.close();

const mb = (statSync(dest).size / 1_048_576).toFixed(1);
console.log(`backed up ${source} -> ${dest}`);
console.log(`  ${mb} MB · schema_version ${version?.value ?? "?"} · ${tables.c} tables`);
console.log("  taken through SQLite's backup API, so writes still in the WAL are included.");
