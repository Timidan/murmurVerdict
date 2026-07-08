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
} from "./types.js";
import type {
  AssetRow,
  OracleRow,
} from "../../verdict/repos/market-registry-repo.js";
import {
  parseOracleAdapterHexConfig,
} from "./adapter-config.js";
import {
  ChainlinkEvmReadContractClient,
  ChainlinkEvmReadError,
  readChainlinkEvmPrice,
} from "../chainlink-evm-feed.js";

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
    const cfg = parseOracleAdapterHexConfig<ChainlinkConfig>(oracle, [{
      key: "feed_address",
      bytes: 20,
      malformedMessage: "feed_address malformed",
    }]);

    const client = makePublicClient(oracle, ctx);
    const address = cfg.feed_address as `0x${string}`;

    try {
      const observation = await readChainlinkEvmPrice({
        client,
        address,
        now: ctx.now,
        decimalsCache,
        decimalsCacheKey: `${oracle.chain}:${address}`,
      });
      return {
        oracle_id: oracle.oracle_id,
        asset_id: oracle.asset_id,
        ...observation,
      };
    } catch (err) {
      if (err instanceof ChainlinkEvmReadError) {
        throw new AdapterError(
          err.message,
          oracle.oracle_id,
          err.cause_kind,
          err.context,
        );
      }
      throw new AdapterError(
        err instanceof Error ? err.message : String(err),
        oracle.oracle_id,
        "rpc_failure",
      );
    }
  },
};

function makePublicClient(
  oracle: OracleRow,
  ctx: AdapterContext,
): ChainlinkEvmReadContractClient {
  if (ctx.readContractClient) return ctx.readContractClient;
  if (!ctx.baseRpcUrl) {
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
    transport: http(ctx.baseRpcUrl, { timeout: ctx.rpcTimeoutMs ?? 8_000 }),
  }) as unknown as ChainlinkEvmReadContractClient;
}
