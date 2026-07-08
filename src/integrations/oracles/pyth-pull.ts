// Pyth Network pull adapter (Hermes HTTP API).
//
// Pyth feeds are global — the same `price_id` (32-byte hex) is valid on every
// chain Pyth supports. We fetch from Hermes (https://hermes.pyth.network)
// rather than the on-chain contract, so adding a new asset is just a new
// price_id in `oracles.config_json`.
//
// Sub-second freshness makes Pyth the right primary for short-horizon
// markets (5m / 15m). Chainlink's heartbeat-based feeds are appropriate
// for ≥1h horizons.

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
  PYTH_HERMES_LATEST,
  PythHermesReadError,
  readPythHermesPrice,
} from "../pyth-hermes.js";

interface PythConfig {
  price_id: string;
}

export const pythPullAdapter: OracleAdapter = {
  name: "pyth-pull",

  async getLatest(
    oracle: OracleRow,
    _asset: AssetRow,
    ctx: AdapterContext,
  ): Promise<OracleObservation> {
    const cfg = parseOracleAdapterHexConfig<PythConfig>(oracle, [{
      key: "price_id",
      bytes: 32,
    }]);

    const endpoint =
      ctx.hermesEndpoint ??
      PYTH_HERMES_LATEST;
    const fetchImpl = ctx.fetchImpl ?? fetch;
    try {
      const observation = await readPythHermesPrice({
        endpoint,
        priceId: cfg.price_id,
        timeoutMs: ctx.hermesTimeoutMs ?? 6_000,
        fetchImpl,
        timers: ctx.hermesTimers,
        now: ctx.now,
      });
      return {
        oracle_id: oracle.oracle_id,
        asset_id: oracle.asset_id,
        ...observation,
      };
    } catch (err) {
      if (err instanceof PythHermesReadError) {
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
        "http_failure",
      );
    }
  },
};
