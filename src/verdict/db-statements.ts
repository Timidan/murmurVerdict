import type Database from "better-sqlite3";

type Stmt = Database.Statement<unknown[]>;
type StmtCache = Map<string, Stmt>;

const stmtCaches = new WeakMap<Database.Database, StmtCache>();

export function prep(db: Database.Database, sql: string): Stmt {
  let cache = stmtCaches.get(db);
  if (!cache) {
    cache = new Map();
    stmtCaches.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}
