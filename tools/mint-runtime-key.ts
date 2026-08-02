/**
 * tools/mint-runtime-key.ts — operator mint of a Gateway Runtime Key scoped
 * to a specific market, for an existing agent. Companion to the operator-blind
 * harness: the fixture seed mints a key scoped to the fixture market only, so
 * driving a real (e.g. polymarket-gamma) market end-to-end needs a key whose
 * policy allows that market.
 *
 * Gated behind MURMUR_ALLOW_FIXTURE_SEED=true — same develop-as-prod posture
 * as tools/seed-operator-blind-fixtures.ts: this writes runtime rows directly
 * to the daemon DB and must never run against a production database.
 *
 * Usage:
 *   MURMUR_ALLOW_FIXTURE_SEED=true tsx tools/mint-runtime-key.ts \
 *     --agent-slug operator-blind-test \
 *     --market-id 0x<bytes32> \
 *     [--db-path data/verdict.db] [--label "..."]
 *
 * Prints JSON with the one-time runtime_key_secret on stdout.
 */
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash, canonicalize } from "../src/receipts/canonical.js";
import { getAccountForAgent } from "../src/verdict/auth/accounts.js";
import { mintRuntimeKey } from "../src/verdict/auth/runtime-keys.js";
import { agentsRepo, marketsRepo, openDb } from "../src/verdict/db.js";
import { getControllerWalletForAgent } from "../src/verdict/auth/controller-wallets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

interface Argv {
  agentSlug?: string;
  marketId?: string;
  dbPath?: string;
  label?: string;
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
    if (arg === "--agent-slug") out.agentSlug = take();
    else if (arg === "--market-id") out.marketId = take();
    else if (arg === "--db-path") out.dbPath = take();
    else if (arg === "--label") out.label = take();
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "mint-runtime-key --agent-slug SLUG --market-id 0x<bytes32> [--db-path PATH] [--label TEXT]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  if (process.env.MURMUR_ALLOW_FIXTURE_SEED !== "true") {
    throw new Error(
      "mint-runtime-key refuses to run without MURMUR_ALLOW_FIXTURE_SEED=true. " +
        "It writes runtime key rows directly to the daemon DB; the develop-as-prod " +
        "posture forbids that by default.",
    );
  }
  const args = parseArgv(process.argv);
  if (!args.agentSlug) throw new Error("--agent-slug is required");
  if (!args.marketId || !/^0x[0-9a-fA-F]{64}$/.test(args.marketId)) {
    throw new Error("--market-id must be a 0x-prefixed bytes32 id");
  }
  const marketId = args.marketId.toLowerCase();
  const dbPath =
    args.dbPath ?? process.env.VERDICT_DB_PATH ?? resolve(REPO_ROOT, "data/verdict.db");
  const db = openDb({ path: dbPath });

  const agent = agentsRepo.bySlug(db, args.agentSlug);
  if (!agent) throw new Error(`no agent with slug '${args.agentSlug}'`);
  const accountId = getAccountForAgent(db, agent.agent_id);
  if (!accountId) throw new Error(`agent '${args.agentSlug}' has no owning account`);
  const wallet = getControllerWalletForAgent(db, agent.agent_id);
  if (!wallet) throw new Error(`agent '${args.agentSlug}' has no controller wallet`);
  const market = marketsRepo.get(db, marketId);
  if (!market) throw new Error(`market ${marketId} not found in daemon DB — register it first`);

  const policy = {
    allowed_intents: ["sealed_call"],
    allowed_chain_ids: [84532],
    allowed_market_ids: [marketId],
    max_calls_per_hour: 1000,
    max_calls_per_day: 10000,
    notes: args.label ?? `operator mint for market ${marketId}`,
  };
  const now = new Date();
  const minted = mintRuntimeKey(db, {
    account_id: accountId,
    agent_id: agent.agent_id,
    label: args.label ?? `operator ${now.toISOString()}`,
    policy_json: canonicalize(policy),
    policy_hash: canonicalHash(policy),
    controller_wallet_address: wallet.wallet_address,
    controller_chain_id: wallet.chain_id,
    authorization_nonce: randomUUID(),
    authorization_message: `operator runtime key ${randomUUID()}`,
    authorization_signature: "0x" + "12".repeat(65),
    createdAt: now,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        agent_id: agent.agent_id,
        account_id: accountId,
        market_id: marketId,
        runtime_key_id: minted.runtime_key_id,
        runtime_key_prefix: minted.runtime_key_prefix,
        runtime_key_secret: minted.secret,
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
