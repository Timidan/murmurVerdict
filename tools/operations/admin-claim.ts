#!/usr/bin/env tsx
/**
 * admin-claim — operator path to attach an existing agent_id (or mint a
 * new one for a given slug) to an account_id, bypassing Privy.
 *
 * Use cases:
 *   - Recovery: an agent owner lost access to their Privy login but the
 *     operator has out-of-band proof of ownership.
 *   - Bootstrap: pre-seeding accounts for benchmark / internal_test
 *     agents the operator runs directly.
 *
 * Wave 5 — every successful claim appends an `admin_claim` row to
 * `agent_security_events`. The event is the canonical forensic trail;
 * stdout logging here is auxiliary.
 *
 * Usage:
 *   tsx tools/operations/admin-claim.ts \\
 *     --slug <display-slug> \\
 *     --account <account-uuid OR privy:<did>> \\
 *     [--display-name "Agent Name"] \\
 *     [--bio "Short bio"] \\
 *     [--db-path ./data/verdict.db]
 *
 * Reads VERDICT_DB_PATH if --db-path is omitted; defaults to
 * `./data/verdict.db`. Refuses to run if the account_id isn't already in
 * the accounts table (operators should create the Privy account via the
 * normal /v1/account/session route first; this tool is for the linking
 * step that comes after).
 */

import { randomUUID } from "node:crypto";
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

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function main(): Promise<void> {
  const args = parseArgv(process.argv);
  if (!args.slug || !args.account) {
    console.error("error: --slug and --account are required");
    console.error(usageText());
    process.exit(2);
  }

  const dbPath = args.dbPath ?? process.env.VERDICT_DB_PATH ?? resolve(REPO_ROOT, "data/verdict.db");

  // Dynamic imports so the CLI can run without pulling the full
  // daemon graph at module-load time.
  const { openDb, agentsRepo, agentSecurityEventsRepo } = await import(
    "../../src/verdict/db.js"
  );
  const {
    getAccountById,
    getAccountByPrivyUserId,
    linkAgentToAccount,
    AgentAlreadyOwnedError,
  } = await import("../../src/verdict/auth/accounts.js");

  const db = openDb({ path: dbPath });

  // Resolve the account_id. Two forms accepted:
  //   - bare uuid:  resolves directly against accounts.account_id
  //   - 'privy:<did>': resolves via accounts.privy_user_id
  let account_id: string;
  if (args.account.startsWith("privy:")) {
    const did = args.account.slice("privy:".length);
    const account = getAccountByPrivyUserId(db, did);
    if (!account) {
      console.error(
        `error: no account row for privy_user_id='${did}'. The owner must log in via Privy at least once first.`,
      );
      process.exit(3);
    }
    account_id = account.account_id;
  } else {
    const account = getAccountById(db, args.account);
    if (!account) {
      console.error(
        `error: no account row for account_id='${args.account}'`,
      );
      process.exit(3);
    }
    account_id = account.account_id;
  }

  // Wave 5 codex review fixes (BLOCKER + MAJOR):
  //   - Validate the constructed AgentProfile via Zod BEFORE the insert so
  //     malformed flag values exit cleanly with code 2 rather than
  //     producing a malformed row.
  //   - Wrap agent resolve/create + linkAgentToAccount + security event
  //     emit in a single SQLite transaction so a crash mid-flow can't
  //     leave a claim half-applied or unaudited.
  const { AgentProfileSchema } = await import("../../src/verdict/schema.js");
  const displayName = args.displayName ?? args.slug;
  let agent_id: string;
  let created_agent = false;
  const event_id = randomUUID();
  try {
    db.transaction(() => {
      const existing = agentsRepo.bySlug(db, args.slug!);
      if (existing) {
        agent_id = existing.agent_id;
      } else {
        agent_id = randomUUID();
        const profile = AgentProfileSchema.parse({
          agent_id,
          display_slug: args.slug,
          kind: "agent",
          display_name: displayName,
          ...(args.bio !== undefined ? { bio: args.bio } : {}),
          created_at: nowIso(),
          verified_identities: [],
        });
        agentsRepo.insert(db, profile, null);
        created_agent = true;
      }
      linkAgentToAccount(db, account_id, agent_id!);
      agentSecurityEventsRepo.emit(db, {
        event_id,
        agent_id: agent_id!,
        account_id,
        kind: "admin_claim",
        actor: "cli:admin-claim",
        payload: {
          slug: args.slug,
          created_agent,
          display_name: args.displayName ?? null,
        },
        created_at: nowIso(),
      });
    })();
  } catch (err) {
    if (err instanceof AgentAlreadyOwnedError) {
      console.error(
        `error: agent ${err.agent_id} is already linked to a different account. Use --unlink first (not implemented in Wave 5).`,
      );
      process.exit(4);
    }
    if (err instanceof Error && err.name === "ZodError") {
      console.error(`error: invalid input — ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  // JSON output for piping into ops tooling.
  console.log(
    JSON.stringify(
      {
        ok: true,
        event_id,
        agent_id,
        account_id,
        slug: args.slug,
        created_agent,
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
