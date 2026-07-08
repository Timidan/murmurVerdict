#!/usr/bin/env tsx
/**
 * TEST FIXTURE ONLY: seeds the operator-blind gateway round-trip prerequisites.
 *
 * This intentionally bypasses Privy and writes real rows directly to the
 * daemon SQLite DB so the production Runtime-Key + Gateway validation path can
 * be exercised by tools/operator-blind-roundtrip.ts. It also registers the
 * deterministic test market on-chain through the real RPC.
 *
 * GUARDED: refuses to run unless MURMUR_ALLOW_FIXTURE_SEED=true. The
 * develop-as-prod posture forbids fixture-backed runtime state by default;
 * this seeder is the explicit carve-out for the operator-blind release-gate
 * Playwright check (tools/operator-blind-roundtrip.ts). NEVER invoke this
 * against a production database.
 */

import "dotenv/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { resolveFhenixContractAddress } from "../src/integrations/deployments.js";
import {
  OPERATOR_BLIND_FIXTURE_CHAIN_ID,
  OPERATOR_BLIND_FIXTURE_MARKET_HORIZON_SECONDS,
  OPERATOR_BLIND_FIXTURE_MARKET_ID,
  seedOperatorBlindFixtureDb,
} from "../src/verdict/operator-blind-fixture-surface.js";
import { openDb } from "../src/verdict/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

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
  const address = resolveFhenixContractAddress(OPERATOR_BLIND_FIXTURE_CHAIN_ID);
  if (!address) {
    throw new Error(
      `MurmurSealedVerdicts address missing; set FHENIX_SEALED_VERDICTS_ADDRESS, FHENIX_CONTRACT_ADDRESS, or sync deployments for chain ${OPERATOR_BLIND_FIXTURE_CHAIN_ID}`,
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
    `[seed-operator-blind] registering on-chain market ${OPERATOR_BLIND_FIXTURE_MARKET_ID} horizon=${OPERATOR_BLIND_FIXTURE_MARKET_HORIZON_SECONDS}s contract=${address}`,
  );
  const tx = await walletClient.writeContract({
    address,
    abi: ABI,
    functionName: "registerMarket",
    args: [
      OPERATOR_BLIND_FIXTURE_MARKET_ID as Hex,
      BigInt(OPERATOR_BLIND_FIXTURE_MARKET_HORIZON_SECONDS),
      true,
    ],
  } as never) as Hex;
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") {
    throw new Error(`registerMarket reverted: tx=${tx}`);
  }
  return tx;
}

async function main(): Promise<void> {
  const args = parseArgv(process.argv);
  if (process.env.MURMUR_ALLOW_FIXTURE_SEED !== "true") {
    throw new Error(
      "seed-operator-blind-fixtures refuses to run without MURMUR_ALLOW_FIXTURE_SEED=true. " +
        "This tool writes fixture-backed runtime rows directly to the daemon DB; the " +
        "develop-as-prod posture forbids that by default. Set the env var only when " +
        "you are intentionally seeding the operator-blind round-trip release-gate harness.",
    );
  }
  const dbPath =
    args.dbPath ?? process.env.VERDICT_DB_PATH ?? resolve(REPO_ROOT, "data/verdict.db");
  const agentWallet = requiredAddress("AGENT_ADDRESS");
  const registerTx = await registerOnchainMarket();

  const db = openDb({ path: dbPath });
  const seeded = seedOperatorBlindFixtureDb({
    db,
    agentWallet,
    now: () => new Date(),
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        db_path: dbPath,
        market_register_tx: registerTx,
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
