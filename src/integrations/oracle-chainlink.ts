import type { OracleFeed } from "../verdict/schema.js";
import {
  OracleError,
  type OracleObservation,
  type ReadContractClient,
} from "./oracle-types.js";
import {
  CHAINLINK_BASE_ETH_USD_FEED,
  ChainlinkEvmReadError,
  readChainlinkEvmPrice,
} from "./chainlink-evm-feed.js";

export const CHAINLINK_BASE_ETH_USD_DEFAULT =
  CHAINLINK_BASE_ETH_USD_FEED;

export interface ChainlinkEthUsdReaderConfig {
  publicClient: ReadContractClient;
  chainlinkAddress: `0x${string}`;
  now: () => Date;
}

export class ChainlinkEthUsdReader {
  private readonly decimalsCache = new Map<string, number>();

  constructor(private readonly cfg: ChainlinkEthUsdReaderConfig) {}

  async read(): Promise<OracleObservation> {
    const feed: OracleFeed = "chainlink:base:ETH-USD";
    try {
      const observation = await readChainlinkEvmPrice({
        client: this.cfg.publicClient,
        address: this.cfg.chainlinkAddress,
        now: this.cfg.now,
        decimalsCache: this.decimalsCache,
        decimalsCacheKey: this.cfg.chainlinkAddress,
      });
      return {
        feed,
        ...observation,
      };
    } catch (err) {
      if (err instanceof ChainlinkEvmReadError) {
        throw new OracleError(
          err.message,
          feed,
          err.cause_kind,
          err.context,
        );
      }
      throw new OracleError(
        err instanceof Error ? err.message : String(err),
        feed,
        "rpc_failure",
      );
    }
  }
}
