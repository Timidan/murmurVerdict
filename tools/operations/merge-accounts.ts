#!/usr/bin/env tsx
/**
 * merge-accounts — one-time operator tool to merge one or more SOURCE Privy
 * accounts into a TARGET Privy account, reusing the same reparent core the
 * inbound `user.transferred_account` webhook uses.
 *
 * Use case: a user proved (out of band) that several Privy DIDs are the same
 * person, and Privy's automatic "Login method transfer" was not used at
 * sign-up time. Each source is reparented onto the target: owned child rows
 * (agents, api keys, controller wallets, runtime keys, reattestations, gateway
 * tx attempts) move to the target, then the source account row is deleted. The
 * append-only `agent_security_events` audit trail is INTENTIONALLY left
 * pointing at the source account_id — a merge preserves history, it does not
 * rewrite it.
 *
 * DRY-RUN BY DEFAULT: without --apply the DB is opened READ-ONLY and nothing is
 * mutated; the tool only resolves accounts and prints the per-source row counts
 * that a merge WOULD move. Pass --apply to perform the merge inside a single
 * outer immediate transaction (all sources succeed together or none do).
 *
 * Safety:
 *   - The target account MUST already exist (a typo must never create a fresh,
 *     inaccessible account to merge into).
 *   - Source DIDs must be distinct from each other and from the target.
 *   - A source with no account row is reported as "already merged", not an
 *     error and not a fake success — this makes reruns idempotent and honest.
 *
 * Usage:
 *   tsx tools/operations/merge-accounts.ts \
 *     --target <privy-did> \
 *     --source <privy-did> [--source <privy-did> ...] \
 *     [--apply] \
 *     [--db-path ./data/verdict.db]
 *
 * Reads VERDICT_DB_PATH if --db-path is omitted; defaults to ./data/verdict.db.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// The seven child tables that FK-reference accounts(account_id) ON DELETE
// CASCADE and are therefore MOVED by a reparent. Mirrors OWNERSHIP_CHILD_TABLES
// in src/verdict/auth/account-reparent.ts; kept as a local literal so this
// read-only reporter does not import the mutating core. `agent_security_events`
// is intentionally NOT here (append-only audit trail; see header).
const OWNERSHIP_CHILD_TABLES = [
  "account_agents",
  "api_keys",
  "agent_controller_wallets",
  "agent_controller_wallet_reattestations",
  "agent_runtime_keys",
  "fhenix_gateway_tx_attempts",
  "fhenix_gateway_feed_packet_tx_attempts",
] as const;

const AUDIT_TABLE = "agent_security_events";

interface Argv {
  target?: string;
  sources: string[];
  apply: boolean;
  dbPath?: string;
}

function parseArgv(argv: string[]): Argv {
  const out: Argv = { sources: [], apply: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const take = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${arg} missing value`);
      return v;
    };
    if (arg === "--target") out.target = take();
    else if (arg === "--source") out.sources.push(take());
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--db-path") out.dbPath = take();
    else if (arg === "-h" || arg === "--help") {
      console.log(usageText());
      process.exit(0);
    } else {
      console.error(`unknown flag: ${arg}`);
      console.error(usageText());
      process.exit(2);
    }
  }
  return out;
}

function usageText(): string {
  return (
    "merge-accounts --target <privy-did> --source <privy-did> [--source ...] " +
    "[--apply] [--db-path PATH]"
  );
}

interface SourcePlan {
  did: string;
  account_id: string | null;
  counts: Record<string, number>;
  auditCount: number;
}

async function main(): Promise<void> {
  const args = parseArgv(process.argv);

  if (!args.target || args.sources.length === 0) {
    console.error("error: --target and at least one --source are required");
    console.error(usageText());
    process.exit(2);
  }
  const target = args.target;

  // Distinctness + not-target checks are hard errors (typo protection).
  const seen = new Set<string>();
  for (const src of args.sources) {
    if (src === target) {
      console.error(`error: source DID equals target DID: ${src}`);
      process.exit(2);
    }
    if (seen.has(src)) {
      console.error(`error: duplicate source DID: ${src}`);
      process.exit(2);
    }
    seen.add(src);
  }

  const dbPath =
    args.dbPath ?? process.env.VERDICT_DB_PATH ?? resolve(REPO_ROOT, "data/verdict.db");
  const absoluteDbPath = resolve(dbPath);

  // Dynamic imports so the CLI does not pull the full daemon graph at load.
  const { openDb } = await import("../../src/verdict/db.js");
  const { getAccountByPrivyUserId } = await import(
    "../../src/verdict/auth/accounts.js"
  );

  console.log(`merge-accounts (${args.apply ? "APPLY" : "DRY-RUN"})`);
  console.log(`  db: ${absoluteDbPath}`);
  console.log(`  target DID: ${target}`);

  // DRY-RUN reads open the DB read-only so a mistaken invocation cannot mutate.
  // APPLY needs a writable handle for the reparent transaction.
  const db = openDb({ path: dbPath, readonly: !args.apply });
  try {
    const targetRow = getAccountByPrivyUserId(db, target);
    if (!targetRow) {
      console.error(
        `error: target account for DID ${target} does not exist. Refusing to run — ` +
          "the target must be a real, already-created account (create it via the " +
          "normal /v1/account/session sign-in first).",
      );
      process.exit(2);
    }
    console.log(`  target account_id: ${targetRow.account_id}`);
    console.log("");

    const plans: SourcePlan[] = args.sources.map((did) => {
      const row = getAccountByPrivyUserId(db, did);
      if (!row) {
        return { did, account_id: null, counts: {}, auditCount: 0 };
      }
      const counts: Record<string, number> = {};
      for (const table of OWNERSHIP_CHILD_TABLES) {
        counts[table] = countByAccount(db, table, row.account_id);
      }
      const auditCount = countByAccount(db, AUDIT_TABLE, row.account_id);
      return { did, account_id: row.account_id, counts, auditCount };
    });

    // Report the plan for every source.
    for (const plan of plans) {
      if (plan.account_id === null) {
        console.log(`source ${plan.did}: already merged (no account for this DID)`);
        continue;
      }
      const movable = Object.values(plan.counts).reduce((a, b) => a + b, 0);
      console.log(`source ${plan.did}:`);
      console.log(`  account_id: ${plan.account_id}`);
      console.log(`  rows to move (${movable} across ${OWNERSHIP_CHILD_TABLES.length} tables):`);
      for (const table of OWNERSHIP_CHILD_TABLES) {
        console.log(`    ${table}: ${plan.counts[table]}`);
      }
      console.log(
        `  ${AUDIT_TABLE} (intentionally UNCHANGED, audit trail): ${plan.auditCount}`,
      );
    }
    console.log("");

    if (!args.apply) {
      const anyPresent = plans.some((p) => p.account_id !== null);
      if (!anyPresent) {
        console.log("nothing to do — all sources already merged. (dry-run)");
      } else {
        console.log("dry-run complete — no changes written. Re-run with --apply to merge.");
      }
      return;
    }

    // APPLY: one outer immediate transaction wrapping every per-source
    // reparent. reparentAccount opens its own transaction, which better-sqlite3
    // runs as a SAVEPOINT when already inside one — so a failure on any source
    // rolls back the entire batch.
    const { reparentAccount } = await import(
      "../../src/verdict/auth/account-reparent.js"
    );
    const applyAll = db.transaction((sources: string[]) => {
      const out: Array<{
        did: string;
        result: ReturnType<typeof reparentAccount>;
      }> = [];
      for (const did of sources) {
        out.push({
          did,
          result: reparentAccount(db, { fromPrivyUserId: did, toPrivyUserId: target }),
        });
      }
      return out;
    });

    const results = applyAll.immediate(args.sources);

    console.log("applied:");
    for (const { did, result } of results) {
      const movedTotal = Object.values(result.moved).reduce((a, b) => a + b, 0);
      const note =
        result.status === "source_absent" ? " (already merged)" : "";
      console.log(
        `  ${did} → ${result.status}${note}: from=${result.from_account_id ?? "null"} ` +
          `to=${result.to_account_id ?? "null"} moved=${movedTotal}`,
      );
    }
    console.log("");
    console.log(JSON.stringify({ target, results }, null, 2));
  } finally {
    db.close();
  }
}

function countByAccount(
  db: import("better-sqlite3").Database,
  table: string,
  accountId: string,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`)
    .get(accountId) as { n: number };
  return row.n;
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
