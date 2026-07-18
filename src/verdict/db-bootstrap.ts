import Database from "better-sqlite3";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

import {
  applyMigrations,
  LATEST_DB_MIGRATION_VERSION,
} from "./db-migrations.js";

export {
  applyTableRebuildMigration,
  VERDICT_DB_SCHEMA_VERSION,
} from "./db-migrations.js";

// ─── DB bootstrap ────────────────────────────────────────────────────────────
//
// SQLite is file-backed; default path resolved from VERDICT_DB_PATH or
// `./data/verdict.db`. WAL mode is enabled so the resolver and submissions
// API can run in parallel without holding locks.

export const DEFAULT_VERDICT_DB_PATH = "./data/verdict.db";

export interface OpenDbOptions {
  env?: NodeJS.ProcessEnv;
  path?: string;
  readonly?: boolean;
}

export class MurmurDatabaseBootstrapConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "MurmurDatabaseBootstrapConfigError";
    this.key = key;
  }
}

export function resolveVerdictDbPath(
  env: NodeJS.ProcessEnv = process.env,
  overridePath?: string,
): string {
  const raw = overridePath ?? env.VERDICT_DB_PATH;
  if (raw === undefined) return DEFAULT_VERDICT_DB_PATH;
  const trimmed = raw.trim();
  if (trimmed) return trimmed;
  throw new MurmurDatabaseBootstrapConfigError(
    "VERDICT_DB_PATH",
    "must not be empty",
  );
}

export function openDb(opts: OpenDbOptions = {}): Database.Database {
  const path = resolveVerdictDbPath(opts.env ?? process.env, opts.path);
  const readonly = opts.readonly ?? false;
  ensureWritableParentDir(path, readonly);
  ensurePrivateDatabaseFile(path, readonly);
  const db = new Database(path, { readonly });
  if (readonly) {
    try {
      db.pragma("foreign_keys = ON");
      assertCurrentSchema(db);
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  applyMigrations(db);
  return db;
}

function assertCurrentSchema(db: Database.Database): void {
  let storedVersion: unknown;
  try {
    storedVersion = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .pluck()
      .get("schema_version");
  } catch {
    throw new MurmurDatabaseBootstrapConfigError(
      "VERDICT_DB_PATH",
      `database schema metadata is unavailable; expected version ${LATEST_DB_MIGRATION_VERSION}. Open the database in writable mode to apply migrations`,
    );
  }

  const actualVersion = Number(storedVersion);
  if (
    !Number.isInteger(actualVersion) ||
    actualVersion !== LATEST_DB_MIGRATION_VERSION
  ) {
    throw new MurmurDatabaseBootstrapConfigError(
      "VERDICT_DB_PATH",
      `database schema version ${String(storedVersion)} does not match expected ${LATEST_DB_MIGRATION_VERSION}; open it once in writable mode to apply migrations`,
    );
  }
}

function ensureWritableParentDir(path: string, readonly: boolean): void {
  if (readonly || path === ":memory:") return;
  const dir = dirname(path);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function ensurePrivateDatabaseFile(path: string, readonly: boolean): void {
  if (readonly || path === ":memory:") return;

  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
