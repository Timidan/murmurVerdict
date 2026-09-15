#!/usr/bin/env tsx
/**
 * Attaches an existing agent_id (or mints one for a slug) to an account_id, bypassing Privy.
 * For recovery with out-of-band proof of ownership, or pre-seeding operator-run agents.
 * Every successful claim appends an `admin_claim` row to `agent_security_events`, the forensic trail.
 *
 * Usage:
 *   tsx tools/operations/admin-claim.ts \\
 *     --slug <display-slug> \\
 *     --account <account-uuid OR privy:<did>> \\
 *     [--display-name "Agent Name"] \\
 *     [--bio "Short bio"] \\
 *     [--db-path ./data/verdict.db]
 *
 * Reads VERDICT_DB_PATH if --db-path is omitted; defaults to `./data/verdict.db`.
 * The account must already exist (create it via /v1/account/session first).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

interface Argv {
  slug?: string;
  account?: string;
  displayName?: string;
  bio?: string;
  dbPath?: string;
}

function parseArgv(argv: string[]): Argv {
  const out: Argv = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const take = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${arg} missing value`);
      return v;
    };
    if (arg === "--slug") out.slug = take();
    else if (arg === "--account") out.account = take();
    else if (arg === "--display-name") out.displayName = take();
    else if (arg === "--bio") out.bio = take();
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
  return `admin-claim --slug <slug> --account <uuid|privy:<did>> [--display-name "..."] [--bio "..."] [--db-path PATH]`;
}

async function main(): Promise<void> {
  const args = parseArgv(process.argv);
  if (!args.slug || !args.account) {
    console.error("error: --slug and --account are required");
    console.error(usageText());
    process.exit(2);
  }

  const dbPath = args.dbPath ?? process.env.VERDICT_DB_PATH ?? resolve(REPO_ROOT, "data/verdict.db");

  // Dynamic imports so the CLI doesn't load the full daemon graph.
  const { openDb } = await import(
    "../../src/verdict/db.js"
  );
  const {
    AdminClaimError,
    adminClaimAgent,
  } = await import(
    "../../src/verdict/admin-claim-surface.js"
  );

  const db = openDb({ path: dbPath });
  let result: ReturnType<typeof adminClaimAgent>;
  try {
    result = adminClaimAgent({
      db,
      account: args.account,
      slug: args.slug,
      displayName: args.displayName,
      bio: args.bio,
      now: () => new Date(),
    });
  } catch (err) {
    if (err instanceof AdminClaimError) {
      console.error(`error: ${err.message}`);
      process.exit(err.exitCode);
    }
    throw err;
  }

  // JSON output for piping into ops tooling.
  console.log(
    JSON.stringify(
      {
        ...result,
      },
      null,
      2,
    ),
  );
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
