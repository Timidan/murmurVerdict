#!/usr/bin/env tsx
/**
 * Submits sealed calls for one agent, standing in for its own program, so a manual UI walkthrough has data.
 * Needs no wallet key: the daemon relays submitSealedFor and its reveal worker publishes reveals.
 * For an unattended grind that reveals itself, use tools/auto-bettor.ts.
 *
 * Env:
 *   MURMUR_ALLOW_FIXTURE_SEED=true   required — this mints runtime keys into the DB
 *   VERDICT_DB_PATH                  default data/verdict.db
 *   DAEMON_URL                       default http://localhost:8080
 *
 * Usage:
 *   MURMUR_ALLOW_FIXTURE_SEED=true npx tsx tools/submit-test-calls.ts <agent-slug> [count]
 */
import "dotenv/config";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mintRuntimeKey } from "../src/verdict/auth/runtime-keys.js";
import { canonicalize, canonicalHash } from "../src/receipts/canonical.js";

const DAEMON = process.env.DAEMON_URL ?? "http://localhost:8080";
const DB_PATH = process.env.VERDICT_DB_PATH ?? "data/verdict.db";
const CHAIN_ID = Number(process.env.FHENIX_CHAIN_ID ?? 84532);

interface OpenMarket {
  market_id: string;
  market_config_version: number;
  early_access_cutoff_at_ms: number;
}

async function main(): Promise<void> {
  if (process.env.MURMUR_ALLOW_FIXTURE_SEED !== "true") {
    throw new Error(
      "submit-test-calls mints runtime keys, so it refuses to run without " +
        "MURMUR_ALLOW_FIXTURE_SEED=true. Pass it on the command line rather " +
        "than storing it in .env; nothing in the daemon reads it.",
    );
  }
  const slug = process.argv[2];
  const count = Number(process.argv[3] ?? 3);
  if (!slug) throw new Error("usage: submit-test-calls.ts <agent-slug> [count]");

  const db = new Database(DB_PATH);
  const agent = db
    .prepare("SELECT agent_id, display_slug, retired_at FROM agents WHERE display_slug = ?")
    .get(slug) as { agent_id: string; display_slug: string; retired_at: string | null } | undefined;
  if (!agent) throw new Error(`no agent with slug "${slug}"`);
  if (agent.retired_at) throw new Error(`agent "${slug}" is retired`);

  // A runtime key is authorized by the agent's controller wallet, so the agent
  // must have completed wallet binding in the UI before it can submit anything.
  const wallet = db
    .prepare("SELECT account_id, wallet_address, chain_id FROM agent_controller_wallets WHERE agent_id = ?")
    .get(agent.agent_id) as
    | { account_id: string; wallet_address: string; chain_id: string }
    | undefined;
  if (!wallet) {
    throw new Error(
      `agent "${slug}" has no controller wallet bound. Connect one on the agent ` +
        `settings page first — a runtime key cannot be minted without it.`,
    );
  }

  // Only markets whose early-access window is open; a later submit is LateUnsellable.
  const now = Date.now();
  const open = db
    .prepare(
      // Only series this agent has priced; an unpriced call answers 404 NotForSale at checkout.
      `SELECT m.market_id, m.market_config_version, c.early_access_cutoff_at_ms
         FROM markets m
         JOIN market_clocks c ON c.market_id = m.market_id
         JOIN agent_provider_terms t
           ON t.venue_series_id = m.venue_series_id
          AND t.agent_id = ?
        WHERE m.status = 'listed'
          AND m.venue_series_id IS NOT NULL
          AND c.submission_open_at_ms <= ?
          AND c.early_access_cutoff_at_ms > ?
        ORDER BY c.early_access_cutoff_at_ms ASC
        LIMIT ?`,
    )
    .all(agent.agent_id, now, now + 30_000, count) as OpenMarket[];

  if (open.length === 0) {
    console.log("No PRICED market is open for early-access submission right now.");
    console.log(
      "Windows open every 5 minutes. Only markets this agent has priced are\n" +
        "selected, so the resulting call can actually be bought.",
    );
    return;
  }
  console.log(`${agent.display_slug}: submitting to ${open.length} open market(s)\n`);

  for (const market of open) {
    const mid = market.market_id.toLowerCase();
    const policy = {
      allowed_intents: ["sealed_call"],
      allowed_chain_ids: [CHAIN_ID],
      allowed_market_ids: [mid],
      max_calls_per_hour: 100,
      max_calls_per_day: 1000,
      notes: `submit-test-calls ${mid}`,
    };
    const minted = mintRuntimeKey(db, {
      account_id: wallet.account_id,
      agent_id: agent.agent_id,
      label: `submit-test-calls ${new Date().toISOString()}`,
      policy_json: canonicalize(policy),
      policy_hash: canonicalHash(policy),
      controller_wallet_address: wallet.wallet_address,
      controller_chain_id: wallet.chain_id,
      authorization_nonce: randomUUID(),
      authorization_message: `submit-test-calls runtime key ${randomUUID()}`,
      authorization_signature: "0x" + "12".repeat(65),
      createdAt: new Date(),
    });

    const binaryIndex = randomBytes(1)[0] % 2;
    const confidenceBps = 5100 + (randomBytes(2).readUInt16BE(0) % 4400);
    const res = await fetch(`${DAEMON}/v2/gateway/calls/seal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Murmur-Runtime-Key": minted.secret },
      body: JSON.stringify({
        marketRef: {
          protocol: "polymarket-gamma",
          sourceId: mid,
          configVersion: market.market_config_version,
        },
        client_order_id: `manual-test-${randomUUID()}`,
        client_nonce: ("0x" + randomBytes(32).toString("hex")) as `0x${string}`,
        privacy_mode: "murmur_sealed_fhenix",
        verdict: { binary_index: binaryIndex, confidence_bps: confidenceBps },
        public_strategy_tag: "manual-test",
      }),
    });
    const body = (await res.json()) as { attempt_id?: string; error?: string; message?: string };
    const secondsLeft = Math.round((market.early_access_cutoff_at_ms - Date.now()) / 1000);
    if (!body.attempt_id) {
      console.log(`  ${mid.slice(0, 18)}…  FAILED ${res.status}: ${body.error ?? body.message ?? "?"}`);
      continue;
    }
    console.log(
      `  ${mid.slice(0, 18)}…  ${binaryIndex === 0 ? "Up  " : "Down"} @ ${(confidenceBps / 100).toFixed(0)}%` +
        `  attempt ${body.attempt_id.slice(0, 8)}  (sellable for ${secondsLeft}s)`,
    );
  }

  console.log(
    "\nThe daemon relays each submit on-chain, then indexes the sealed call. " +
      "Watch the agent page; a call appears once its attempt confirms.",
  );
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
