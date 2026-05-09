#!/usr/bin/env tsx
// Standalone CLI to independently verify a Murmur receipt chain.
//
// Usage:
//   npx tsx tools/verify-receipt.ts <call_id> [--db ./data/verdict.db]
//
// The command opens the SQLite DB read-only and runs the same recomputation
// the /v1/calls/:id/verify endpoint runs. Output is a single JSON object that
// returns exit code 0 on PASS, 1 on FAIL, 2 on infrastructure/data errors.

import { openDb } from "../../src/verdict/db.js";
import { verifyReceiptChain, VerifyError } from "../../src/verdict/verify.js";

function arg(name: string, def?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return def;
}

function main(): void {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const call_id = positional[0];
  if (!call_id) {
    console.error("usage: verify-receipt <call_id> [--db <path>]");
    process.exit(2);
  }
  const path = arg("--db", process.env.VERDICT_DB_PATH ?? "./data/verdict.db")!;

  let db;
  try {
    db = openDb({ path, readonly: true });
  } catch (err) {
    console.error(JSON.stringify({
      passes: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(2);
  }

  try {
    const result = verifyReceiptChain(db, call_id);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passes ? 0 : 1);
  } catch (err) {
    if (err instanceof VerifyError) {
      console.error(JSON.stringify({ passes: false, code: err.code, error: err.message }));
      process.exit(2);
    }
    throw err;
  } finally {
    db.close();
  }
}

main();
