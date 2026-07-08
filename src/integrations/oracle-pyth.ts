import type { OracleFeed } from "../verdict/schema.js";
import {
  OracleError,
  type OracleObservation,
} from "./oracle-types.js";
import {
  PYTH_HERMES_LATEST,
  PythHermesReadError,
  readPythHermesPrice,
  type PythHermesTimers,
} from "./pyth-hermes.js";

const PYTH_ETH_USD_PRICE_ID =
  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" as const;

export const HERMES_LATEST = PYTH_HERMES_LATEST;

export interface PythEthUsdReaderConfig {
  hermesEndpoint: string;
  hermesTimeoutMs: number;
  fetchImpl: typeof fetch;
  hermesTimers?: PythHermesTimers;
  now: () => Date;
}

export class PythEthUsdReader {
  constructor(private readonly cfg: PythEthUsdReaderConfig) {}

  async read(): Promise<OracleObservation> {
    const feed: OracleFeed = "pyth:base:ETH-USD";
    try {
      const observation = await readPythHermesPrice({
        endpoint: this.cfg.hermesEndpoint,
        priceId: PYTH_ETH_USD_PRICE_ID,
        timeoutMs: this.cfg.hermesTimeoutMs,
        fetchImpl: this.cfg.fetchImpl,
        timers: this.cfg.hermesTimers,
        now: this.cfg.now,
      });
      return {
        feed,
        ...observation,
      };
    } catch (err) {
      if (err instanceof PythHermesReadError) {
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
        "http_failure",
      );
    }
  }
}
