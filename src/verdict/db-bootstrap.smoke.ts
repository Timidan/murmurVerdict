import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_VERDICT_DB_PATH,
  MurmurDatabaseBootstrapConfigError,
  openDb,
  resolveVerdictDbPath,
} from "./db-bootstrap.js";
import { LATEST_DB_MIGRATION_VERSION } from "./db-migrations.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-db-bootstrap-smoke-"));
const dbPath = join(tmp, "nested", "data", "verdict.db");
const envDbPath = join(tmp, "env", "verdict.db");
const ambientDbPath = join(tmp, "ambient", "verdict.db");
const readonlyDbPath = join(tmp, "readonly", "verdict.db");
const staleReadonlyDbPath = join(tmp, "readonly-stale", "verdict.db");
const secureDbPath = join(tmp, "secure-created", "nested", "verdict.db");
const priorVerdictDbPath = process.env.VERDICT_DB_PATH;

try {
  process.env.VERDICT_DB_PATH = ambientDbPath;
  assert.equal(resolveVerdictDbPath({}), DEFAULT_VERDICT_DB_PATH);
  assert.equal(
    resolveVerdictDbPath({ VERDICT_DB_PATH: " ./custom/verdict.db " }),
    "./custom/verdict.db",
  );
  assert.equal(resolveVerdictDbPath({ VERDICT_DB_PATH: "/ambient.db" }, ":memory:"), ":memory:");
  assert.throws(
    () => resolveVerdictDbPath({ VERDICT_DB_PATH: "   " }),
    (err) =>
      err instanceof MurmurDatabaseBootstrapConfigError &&
      err.key === "VERDICT_DB_PATH",
  );

  assert.equal(existsSync(dirname(dbPath)), false);
  const db = openDb({ path: dbPath });
  try {
    assert.equal(existsSync(dirname(dbPath)), true);
    const schemaVersion = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .pluck()
      .get("schema_version") as string | undefined;
    assert(Number(schemaVersion) > 0);
  } finally {
    db.close();
  }

  assert.equal(existsSync(dirname(envDbPath)), false);
  assert.equal(existsSync(dirname(ambientDbPath)), false);
  const envDb = openDb({ env: { VERDICT_DB_PATH: envDbPath } });
  try {
    assert.equal(existsSync(dirname(envDbPath)), true);
    assert.equal(
      existsSync(dirname(ambientDbPath)),
      false,
      "openDb should use the supplied env Adapter instead of ambient process.env",
    );
  } finally {
    envDb.close();
  }

  const readonlySeed = openDb({ path: readonlyDbPath });
  readonlySeed.pragma("journal_mode = DELETE");
  readonlySeed.close();
  const readonlyBytesBefore = readFileSync(readonlyDbPath);

  const readonlyDb = openDb({ path: readonlyDbPath, readonly: true });
  try {
    assert.equal(
      readonlyDb.pragma("journal_mode", { simple: true }),
      "delete",
      "readonly openDb should preserve the database journal mode",
    );
    assert.equal(
      readonlyDb
        .prepare("SELECT value FROM schema_meta WHERE key = ?")
        .pluck()
        .get("schema_version"),
      String(LATEST_DB_MIGRATION_VERSION),
    );
  } finally {
    readonlyDb.close();
  }
  assert.deepEqual(
    readFileSync(readonlyDbPath),
    readonlyBytesBefore,
    "readonly openDb should not modify the database file",
  );
  assert.equal(existsSync(`${readonlyDbPath}-wal`), false);
  assert.equal(existsSync(`${readonlyDbPath}-shm`), false);

  const staleReadonlySeed = openDb({ path: staleReadonlyDbPath });
  staleReadonlySeed
    .prepare("UPDATE schema_meta SET value = ? WHERE key = ?")
    .run("53", "schema_version");
  staleReadonlySeed.pragma("journal_mode = DELETE");
  staleReadonlySeed.close();
  const staleReadonlyBytesBefore = readFileSync(staleReadonlyDbPath);

  assert.throws(
    () => openDb({ path: staleReadonlyDbPath, readonly: true }),
    (err) =>
      err instanceof MurmurDatabaseBootstrapConfigError &&
      err.key === "VERDICT_DB_PATH" &&
      new RegExp(
        `schema version 53.*expected ${LATEST_DB_MIGRATION_VERSION}.*writable mode`,
        "i",
      ).test(err.message),
    "readonly openDb should reject a database that still needs migrations",
  );
  assert.deepEqual(readFileSync(staleReadonlyDbPath), staleReadonlyBytesBefore);
  assert.equal(existsSync(`${staleReadonlyDbPath}-wal`), false);
  assert.equal(existsSync(`${staleReadonlyDbPath}-shm`), false);

  const priorUmask = process.umask(0o022);
  try {
    const secureDb = openDb({ path: secureDbPath });
    secureDb.close();
  } finally {
    process.umask(priorUmask);
  }
  assert.equal(
    statSync(dirname(secureDbPath)).mode & 0o777,
    0o700,
    "openDb should create private database directories under a permissive umask",
  );
  assert.equal(
    statSync(secureDbPath).mode & 0o777,
    0o600,
    "openDb should create a private database file under a permissive umask",
  );

  console.log("db-bootstrap smoke ok");
} finally {
  if (priorVerdictDbPath === undefined) delete process.env.VERDICT_DB_PATH;
  else process.env.VERDICT_DB_PATH = priorVerdictDbPath;
  rmSync(tmp, { recursive: true, force: true });
}
