import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { applyMigrations } from "./db-migrations.js";

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
  ensureWritableParentDir(path, opts.readonly ?? false);
  const db = new Database(path, { readonly: opts.readonly ?? false });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  applyMigrations(db);
  return db;
}

function ensureWritableParentDir(path: string, readonly: boolean): void {
  if (readonly || path === ":memory:") return;
  const dir = dirname(path);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
}
