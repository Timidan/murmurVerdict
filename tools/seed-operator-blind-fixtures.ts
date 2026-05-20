#!/usr/bin/env tsx
/**
 * TEST FIXTURE ONLY: seeds the operator-blind gateway round-trip prerequisites.
 *
 * This intentionally bypasses Privy and writes real rows directly to the
 * daemon SQLite DB so the production Runtime-Key + Gateway validation path can
 * be exercised by tools/operator-blind-roundtrip.ts. It also registers the
 * deterministic test market on-chain through the real RPC.
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { loadDeployment } from "../src/integrations/deployments.js";
import { canonicalHash, canonicalize } from "../src/receipts/canonical.js";
import { agentsRepo, marketsRepo, openDb } from "../src/verdict/db.js";
import {
  bindControllerWallet,
  getAccountByPrivyUserId,
  getAccountForAgent,
  linkAgentToAccount,
  mintRuntimeKey,
} from "../src/verdict/auth/accounts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const CHAIN_ID = 84532;
const CHAIN_CAIP = `eip155:${CHAIN_ID}`;
const SLUG = "operator-blind-test";
const MARKET_ID = keccak256(toHex("murmur:operator-blind-test:market:v1")).toLowerCase() as Hex;
const MARKET_HORIZON_SECONDS = 90;
const PRIVY_FIXTURE_ID = "did:fixture:operator-blind-test";

const ABI = parseAbi([
  "function registerMarket(bytes32 marketId, uint64 horizonSeconds, bool active)",
]);

interface Argv {
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
    if (arg === "--db-path") out.dbPath = take();
    else if (arg === "-h" || arg === "--help") {
      console.log("seed-operator-blind-fixtures [--db-path PATH]");
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function requiredHexPrivateKey(name: string): Hex {
  const raw = (process.env[name] ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte private key`);
  }
  return raw as Hex;
}

function requiredAddress(name: string): string {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) throw new Error(`${name} is required`);
  return getAddress(raw as Address).toLowerCase();
}

function contractAddress(): Address {
  const envAddress =
    process.env.FHENIX_SEALED_VERDICTS_ADDRESS?.trim() ||
    process.env.FHENIX_CONTRACT_ADDRESS?.trim() ||
    null;
  const address = envAddress ?? loadDeployment(CHAIN_ID, "MurmurSealedVerdicts")?.address;
  if (!address) {
    throw new Error(
      `MurmurSealedVerdicts address missing; set FHENIX_SEALED_VERDICTS_ADDRESS, FHENIX_CONTRACT_ADDRESS, or sync deployments for chain ${CHAIN_ID}`,
    );
  }
  return getAddress(address);
}

async function registerOnchainMarket(): Promise<Hex> {
  const rpcUrl = (process.env.FHENIX_RPC_URL || process.env.BASE_RPC_URL || "").trim();
  if (!rpcUrl) throw new Error("FHENIX_RPC_URL or BASE_RPC_URL is required");
  const ownerKey = requiredHexPrivateKey("FHENIX_GATEWAY_RELAYER_PRIVATE_KEY");
  const account = privateKeyToAccount(ownerKey);
  const address = contractAddress();
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });

  console.error(
    `[seed-operator-blind] registering on-chain market ${MARKET_ID} horizon=${MARKET_HORIZON_SECONDS}s contract=${address}`,
  );
  const tx = await walletClient.writeContract({
    address,
    abi: ABI,
    functionName: "registerMarket",
    args: [MARKET_ID, BigInt(MARKET_HORIZON_SECONDS), true],
  } as never) as Hex;
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") {
    throw new Error(`registerMarket reverted: tx=${tx}`);
  }
  return tx;
}

async function main(): Promise<void> {
  const args = parseArgv(process.argv);
  const dbPath = args.dbPath ?? process.env.VERDICT_DB_PATH ?? resolve(REPO_ROOT, "data/verdict.db");
  const agentWallet = requiredAddress("AGENT_ADDRESS");
  const registerTx = await registerOnchainMarket();

  const db = openDb({ path: dbPath });
  const ts = nowIso();
  let createdAccount = false;
  let createdAgent = false;
  let linkedAgent = false;
  let boundWallet = false;

  const seeded = db.transaction(() => {
    let agent = agentsRepo.bySlug(db, SLUG);
    let accountId = agent ? getAccountForAgent(db, agent.agent_id) : null;

    if (!accountId) {
      const existingFixtureAccount = getAccountByPrivyUserId(db, PRIVY_FIXTURE_ID);
      accountId = existingFixtureAccount?.account_id ?? randomUUID();
      if (!existingFixtureAccount) {
        db.prepare(
          `INSERT INTO accounts (
             account_id, privy_user_id, email, primary_login_method,
             created_at, last_seen_at
           ) VALUES (?, ?, NULL, ?, ?, ?)`,
        ).run(accountId, PRIVY_FIXTURE_ID, "fixture", ts, ts);
        createdAccount = true;
      }
    }

    if (!agent) {
      const agentId = randomUUID();
      agentsRepo.insert(db, {
        agent_id: agentId,
        display_slug: SLUG,
        kind: "agent",
        display_name: "Operator Blind Test",
        bio: "Local release-gate fixture for the operator-blind FHE round-trip.",
        created_at: ts,
        wallet_address: agentWallet,
        chain_id: CHAIN_CAIP,
      });
      agent = agentsRepo.byId(db, agentId);
      if (!agent) throw new Error("failed to create fixture agent");
      createdAgent = true;
    }

    const owner = getAccountForAgent(db, agent.agent_id);
    if (!owner) {
      linkAgentToAccount(db, accountId!, agent.agent_id);
      linkedAgent = true;
    } else if (owner !== accountId) {
      throw new Error(`agent ${agent.agent_id} is already linked to account ${owner}`);
    }

    const existingWallet = db
      .prepare("SELECT wallet_address, chain_id FROM agent_controller_wallets WHERE agent_id = ?")
      .get(agent.agent_id) as { wallet_address: string; chain_id: string } | undefined;
    if (!existingWallet) {
      bindControllerWallet(db, {
        account_id: accountId!,
        agent_id: agent.agent_id,
        wallet_address: agentWallet,
        chain_id: CHAIN_CAIP,
        wallet_kind: "external",
        provider: "operator-blind-fixture",
        binding_message: "operator-blind fixture controller wallet binding",
        binding_signature: "0x" + "11".repeat(65),
        created_at: ts,
      });
      boundWallet = true;
    } else if (
      existingWallet.wallet_address !== agentWallet ||
      existingWallet.chain_id !== CHAIN_CAIP
    ) {
      throw new Error(
        `existing controller wallet ${existingWallet.wallet_address}/${existingWallet.chain_id} does not match ${agentWallet}/${CHAIN_CAIP}`,
      );
    }

    marketsRepo.upsertExternalMarket(db, {
      market_id: MARKET_ID,
      asset_id: "base:ETH:USD",
      market_kind: "direction_binary",
      horizon_seconds: MARKET_HORIZON_SECONDS,
      primary_oracle_id: "chainlink-base-eth-usd",
      adapter_id: "native-price",
      market_family: "financial-direction",
      scoring_kind: "brier_direction",
      config_json: JSON.stringify({
        label: "operator-blind-test",
        fixture: true,
      }),
      void_band: "0",
      status: "listed",
      created_at: ts,
    });

    const policy = {
      allowed_intents: ["sealed_call"],
      allowed_chain_ids: [CHAIN_ID],
      allowed_market_ids: [MARKET_ID],
      max_calls_per_hour: 1000,
      max_calls_per_day: 10000,
      notes: "operator-blind gateway release-gate fixture",
    };
    const runtimeKey = mintRuntimeKey(db, {
      account_id: accountId!,
      agent_id: agent.agent_id,
      label: `operator-blind ${ts}`,
      policy_json: canonicalize(policy),
      policy_hash: canonicalHash(policy),
      controller_wallet_address: agentWallet,
      controller_chain_id: CHAIN_CAIP,
      authorization_nonce: randomUUID(),
      authorization_message: `operator-blind runtime key ${randomUUID()}`,
      authorization_signature: "0x" + "12".repeat(65),
      created_at: ts,
    });

    return {
      account_id: accountId!,
      agent_id: agent.agent_id,
      runtime_key_id: runtimeKey.runtime_key_id,
      runtime_key_secret: runtimeKey.secret,
      runtime_key_prefix: runtimeKey.runtime_key_prefix,
    };
  })();

  console.log(
    JSON.stringify(
      {
        ok: true,
        db_path: dbPath,
        slug: SLUG,
        agent_address: agentWallet,
        chain_id: CHAIN_ID,
        market_id: MARKET_ID,
        market_ref: {
          protocol: "native-price",
          sourceId: MARKET_ID,
          configVersion: 1,
        },
        market_register_tx: registerTx,
        created_account: createdAccount,
        created_agent: createdAgent,
        linked_agent: linkedAgent,
        bound_wallet: boundWallet,
        ...seeded,
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
