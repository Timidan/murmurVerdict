// Chainlink AggregatorV3Interface adapter (EVM chains).
//
// Reads `latestRoundData()` + `decimals()` via viem. The feed address comes
// from `oracles.config_json.feed_address`; the chain comes from
// `oracles.chain` ("base", "ethereum", "arbitrum", ...).
//
// Migration path: today the resolver still uses `OracleClient` in
// integrations/oracle.ts which is hard-coded to Base ETH/USD. New code
// (per-market resolution) calls into this adapter via the registry.

import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import {
  AdapterContext,
  AdapterError,
  OracleAdapter,
  OracleObservation,
  adapterHelpers,
} from "./types.js";
import type { AssetRow, OracleRow } from "../../verdict/db.js";

interface ReadContractClient {
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) => Promise<unknown>;
}

const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface ChainlinkConfig {
  feed_address: string;
}

const decimalsCache = new Map<string, number>();

export const chainlinkEvmAdapter: OracleAdapter = {
  name: "chainlink-evm",

  async getLatest(
    oracle: OracleRow,
    _asset: AssetRow,
    ctx: AdapterContext,
  ): Promise<OracleObservation> {
    const cfg = adapterHelpers.parseConfig<ChainlinkConfig>(oracle, [
      "feed_address",
    ]);
    if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.feed_address)) {
      throw new AdapterError(
        `oracle ${oracle.oracle_id}: feed_address malformed`,
        oracle.oracle_id,
        "config_invalid",
        { feed_address: cfg.feed_address },
      );
    }

    const client = makePublicClient(oracle, ctx);
    const now = ctx.now ?? (() => new Date());
    const address = cfg.feed_address as `0x${string}`;

    let roundId: bigint;
    let answer: bigint;
    let updatedAt: bigint;
    try {
      const result = (await client.readContract({
        address,
        abi: AGGREGATOR_V3_ABI,
        functionName: "latestRoundData",
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      [roundId, answer, , updatedAt] = result;
    } catch (err) {
      throw new AdapterError(
        `chainlink RPC read failed`,
        oracle.oracle_id,
        "rpc_failure",
        { error: errorMessage(err) },
      );
    }

    if (answer <= 0n) {
      throw new AdapterError(
        "chainlink answer non-positive",
        oracle.oracle_id,
        "missing_field",
        { answer: answer.toString() },
      );
    }
    if (updatedAt === 0n) {
      throw new AdapterError(
        "chainlink updatedAt is zero",
        oracle.oracle_id,
        "missing_field",
      );
    }

    const decimals = await getDecimals(client, oracle, address);
    const price = adapterHelpers.formatFixed(answer, decimals);
    const feed_timestamp = adapterHelpers.isoFromUnixSeconds(updatedAt);
    const observed_at = adapterHelpers.nowIso(now);
    const source_age_seconds = Math.max(
      0,
      Math.floor(now().getTime() / 1000) - Number(updatedAt),
    );

    return {
      oracle_id: oracle.oracle_id,
      asset_id: oracle.asset_id,
      price,
      feed_timestamp,
      observed_at,
      source_id: `0x${roundId.toString(16)}`,
      source_age_seconds,
    };
  },
};

function makePublicClient(
  oracle: OracleRow,
  ctx: AdapterContext,
): ReadContractClient {
  const rpcUrl = ctx.baseRpcUrl ?? process.env.BASE_MAINNET_RPC_URL;
  if (!rpcUrl) {
    throw new AdapterError(
      `chainlink-evm: BASE_MAINNET_RPC_URL not set (or AdapterContext.baseRpcUrl)`,
      oracle.oracle_id,
      "config_invalid",
    );
  }
  // v0.2.5 only ships Base oracles. When new chains arrive (arbitrum, op),
  // wire viem chain selection from `oracle.chain`.
  if (oracle.chain !== "base") {
    throw new AdapterError(
      `chainlink-evm: chain '${oracle.chain}' not yet supported`,
      oracle.oracle_id,
      "config_invalid",
    );
  }
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl, { timeout: ctx.rpcTimeoutMs ?? 8_000 }),
  }) as unknown as ReadContractClient;
}

async function getDecimals(
  client: ReadContractClient,
  oracle: OracleRow,
  address: `0x${string}`,
): Promise<number> {
  const cacheKey = `${oracle.chain}:${address}`;
  const cached = decimalsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const d = (await client.readContract({
      address,
      abi: AGGREGATOR_V3_ABI,
      functionName: "decimals",
    })) as number;
    const n = Number(d);
    decimalsCache.set(cacheKey, n);
    return n;
  } catch (err) {
    throw new AdapterError(
      "chainlink decimals() read failed",
      oracle.oracle_id,
      "rpc_failure",
      { error: errorMessage(err) },
    );
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
