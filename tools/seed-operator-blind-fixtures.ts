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
import { deriveAddressFromKey } from "../src/integrations/derived-addresses.js";
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
  "function registerMarket(bytes32 marketId, (uint64 armCloseAt, uint64 submissionOpenAt, uint64 earlyAccessCutoffAt, uint64 submissionCloseAt, uint64 resolutionAt, uint64 publicRevealAt, bool active) schedule)",
  "function markets(bytes32 marketId) view returns (uint64 armCloseAt, uint64 submissionOpenAt, uint64 earlyAccessCutoffAt, uint64 submissionCloseAt, uint64 resolutionAt, uint64 publicRevealAt, bool active)",
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
      `MurmurSealedVerdicts address missing; set FHENIX_SEALED_VERDICTS_ADDRESS or sync deployments for chain ${OPERATOR_BLIND_FIXTURE_CHAIN_ID}`,
    );
  }
  return getAddress(address);
}

interface OnchainRegistration {
  tx: Hex | null;
  /** The market's RESOLUTION instant, in ms. */
  endDateMs: number;
  /** Gap from resolution to public reveal, in seconds. */
  embargoSec: number;
}

/**
 * Returns the schedule the market is registered with — whether this call
 * registered it or found it already on-chain. The DB fixture must carry the
 * SAME instants, or the acceptance guard refuses every seeded call.
 */
async function registerOnchainMarket(): Promise<OnchainRegistration> {
  const rpcUrl = (process.env.FHENIX_RPC_URL || process.env.BASE_RPC_URL || "").trim();
  if (!rpcUrl) throw new Error("FHENIX_RPC_URL or BASE_RPC_URL is required");
  const ownerKey = requiredHexPrivateKey("FHENIX_GATEWAY_RELAYER_PRIVATE_KEY");
  const account = privateKeyToAccount(ownerKey);
  const address = contractAddress();
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });

  // The chain id MUST equal the DB fixture id — the roundtrip submits against
  // the fixture market, so a per-run chain id would point at a market that was
  // never registered. Registration is one-shot, so make the seeder idempotent
  // instead: skip when this market is already registered.
  const onchainMarketId = OPERATOR_BLIND_FIXTURE_MARKET_ID as Hex;
  const existing = (await publicClient.readContract({
    address,
    abi: ABI,
    functionName: "markets",
    args: [onchainMarketId],
  })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean];
  if (existing[5] !== 0n) {
    console.error(
      `[seed-operator-blind] market ${onchainMarketId} already registered ` +
        `(publicRevealAt=${existing[5]}) — schedules are immutable, skipping`,
    );
    // Report the EXISTING schedule, not a fresh one: the DB fixture has to
    // agree with what is actually on chain.
    return {
      tx: null,
      endDateMs: Number(existing[4]) * 1000,
      embargoSec: Number(existing[5] - existing[4]),
    };
  }

  const schedule = (() => {
        // Compressed but strictly ordered; armCloseAt must be in the future.
        const base = BigInt(Math.floor(Date.now() / 1000));
        const h = BigInt(OPERATOR_BLIND_FIXTURE_MARKET_HORIZON_SECONDS);
        // REGISTRATION_LEAD covers the whole write — gas estimation, the RPC
        // round trip, and block inclusion. A 10s lead was NOT enough: the
        // transaction mined well after the schedule was built, so the contract
        // saw `armCloseAt <= block.timestamp` and reverted
        // RevealAfterMustBeFuture on every seed. That is the contract behaving
        // correctly — registration must complete before arming opens.
        //
        // Later instants are offset from armCloseAt, not from `base`, so
        // widening the lead cannot silently compress a downstream window.
        const REGISTRATION_LEAD = 90n;
        const armCloseAt = base + REGISTRATION_LEAD;
        return {
          armCloseAt,
          // The submission window has to survive the WHOLE round-trip
          // preamble: CoFHE SDK init, key fetch and input encryption, which
          // together run to minutes on a cold cache. A 170s window meant the
          // gate raced its own setup and reverted SubmissionWindowClosed.
          // 10 minutes is generous on purpose — this is a hand-run release
          // gate, not a tight loop, and a false failure here costs far more
          // than the wait.
          submissionOpenAt: armCloseAt + 10n,
          earlyAccessCutoffAt: armCloseAt + 570n,
          submissionCloseAt: armCloseAt + 600n,
          resolutionAt: armCloseAt + 600n + h,
          publicRevealAt: armCloseAt + 660n + h,
          active: true,
        };
      })();

  console.error(
    `[seed-operator-blind] registering on-chain market ${onchainMarketId} horizon=${OPERATOR_BLIND_FIXTURE_MARKET_HORIZON_SECONDS}s contract=${address}`,
  );
  const tx = await walletClient.writeContract({
    address,
    abi: ABI,
    functionName: "registerMarket",
    args: [
      onchainMarketId,
      schedule,
    ],
  } as never) as Hex;
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") {
    throw new Error(`registerMarket reverted: tx=${tx}`);
  }
  return {
    tx,
    endDateMs: Number(schedule.resolutionAt) * 1000,
    embargoSec: Number(schedule.publicRevealAt - schedule.resolutionAt),
  };
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
  // Derived from the relayer key that this seeder already uses to register the
  // market on-chain; AGENT_ADDRESS remains an optional explicit cross-check.
  const agentWallet = deriveAddressFromKey({
    privateKey: requiredHexPrivateKey("FHENIX_GATEWAY_RELAYER_PRIVATE_KEY"),
    configured: process.env.AGENT_ADDRESS,
    configuredName: "AGENT_ADDRESS",
    keyName: "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
  });
  const registration = await registerOnchainMarket();
  const registerTx = registration.tx;

  const db = openDb({ path: dbPath });
  const seeded = seedOperatorBlindFixtureDb({
    db,
    agentWallet,
    // The DB fixture must agree with the on-chain schedule exactly — the
    // acceptance guard compares the two and refuses the call otherwise.
    revealSchedule: {
      endDateMs: registration.endDateMs,
      embargoSec: registration.embargoSec,
    },
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
