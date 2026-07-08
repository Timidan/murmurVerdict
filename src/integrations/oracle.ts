import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import {
  OracleFeed,
} from "../verdict/schema.js";
import {
  ChainlinkEthUsdReader,
  CHAINLINK_BASE_ETH_USD_DEFAULT,
} from "./oracle-chainlink.js";
import {
  HERMES_LATEST,
  PythEthUsdReader,
} from "./oracle-pyth.js";
import {
  OracleError,
  type OracleClientConfig,
  type OracleObservation,
  type ReadContractClient,
} from "./oracle-types.js";
import type { AdapterContext } from "./oracles/types.js";

export { OracleError } from "./oracle-types.js";
export type {
  OracleClientConfig,
  OracleObservation,
  OracleErrorKind,
  ReadContractClient,
} from "./oracle-types.js";

// ─── OracleClient ────────────────────────────────────────────────────────────

export class OracleClient {
  private readonly chainlink: ChainlinkEthUsdReader;
  private readonly pyth: PythEthUsdReader;
  private readonly now: () => Date;
  private readonly adapterCtx: AdapterContext;

  constructor(cfg: OracleClientConfig) {
    this.now = cfg.now;
    const rpcTimeoutMs = cfg.rpcTimeoutMs ?? 8_000;
    const hermesTimeoutMs = cfg.hermesTimeoutMs ?? 6_000;
    const chainlinkAddress = (cfg.chainlinkEthUsdAddress ??
      CHAINLINK_BASE_ETH_USD_DEFAULT) as `0x${string}`;
    const hermesEndpoint = cfg.hermesEndpoint ?? HERMES_LATEST;
    const publicClient = cfg.publicClient ?? createLegacyPublicClient(
      cfg.baseRpcUrl,
      rpcTimeoutMs,
    );
    this.adapterCtx = {
      baseRpcUrl: cfg.baseRpcUrl,
      hermesEndpoint,
      rpcTimeoutMs,
      hermesTimeoutMs,
      hermesTimers: cfg.hermesTimers,
      fetchImpl: cfg.fetchImpl,
      now: this.now,
    };

    this.chainlink = new ChainlinkEthUsdReader({
      publicClient,
      chainlinkAddress,
      now: this.now,
    });
    this.pyth = new PythEthUsdReader({
      hermesEndpoint,
      hermesTimeoutMs,
      fetchImpl: cfg.fetchImpl ?? fetch,
      hermesTimers: cfg.hermesTimers,
      now: this.now,
    });
  }

  adapterContext(): AdapterContext {
    return this.adapterCtx;
  }

  async getLatestPrice(feed: OracleFeed): Promise<OracleObservation> {
    if (feed === "chainlink:base:ETH-USD") return this.chainlink.read();
    if (feed === "pyth:base:ETH-USD") return this.pyth.read();
    throw new OracleError(`unsupported feed: ${feed}`, feed, "missing_field");
  }
}

function createLegacyPublicClient(
  baseRpcUrl: string | undefined,
  rpcTimeoutMs: number,
): ReadContractClient {
  if (!baseRpcUrl) {
    throw new Error(
      "BASE_MAINNET_RPC_URL is required (or pass baseRpcUrl/publicClient)",
    );
  }
  return createPublicClient({
    chain: base,
    transport: http(baseRpcUrl, { timeout: rpcTimeoutMs }),
  }) as unknown as ReadContractClient;
}
