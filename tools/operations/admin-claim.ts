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

  // Resolve or create the agent. If a row with the slug already exists,
  // reuse it; otherwise mint a fresh agent_id + 'agent' kind row.
  const existing = agentsRepo.bySlug(db, args.slug);
  let agent_id: string;
  let created_agent = false;
  if (existing) {
    agent_id = existing.agent_id;
  } else {
    agent_id = randomUUID();
    agentsRepo.insert(
      db,
      {
        agent_id,
        display_slug: args.slug,
        kind: "agent",
        display_name: args.displayName ?? args.slug,
        ...(args.bio !== undefined ? { bio: args.bio } : {}),
        created_at: nowIso(),
        verified_identities: [],
      },
      null,
    );
    created_agent = true;
  }

  // Link agent → account. linkAgentToAccount throws AgentAlreadyOwnedError
  // when the agent is already linked to a DIFFERENT account; we surface
  // the typed error and exit 4 so an automation can branch on it.
  try {
    linkAgentToAccount(db, account_id, agent_id);
  } catch (err) {
    if (err instanceof AgentAlreadyOwnedError) {
      console.error(
        `error: agent ${agent_id} is already linked to a different account. Use --unlink first (not implemented in Wave 5).`,
      );
      process.exit(4);
    }
    throw err;
  }

  const event_id = randomUUID();
  agentSecurityEventsRepo.emit(db, {
    event_id,
    agent_id,
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
