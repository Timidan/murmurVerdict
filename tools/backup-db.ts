#!/usr/bin/env tsx
/**
 * Copies the daemon's SQLite database safely while it runs. A plain `cp` silently misses writes still
 * in the `-wal` file; SQLite's backup API reads through the WAL for a consistent snapshot.
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

// Open the copy and print schema version and table count to check against the live daemon.
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
