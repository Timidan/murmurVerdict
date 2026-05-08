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
  adapterHelpers,
} from "./types.js";
import type { AssetRow, OracleRow } from "../../verdict/db.js";

interface PythConfig {
  price_id: string;
}

interface HermesPriceEntry {
  price: string;
  expo: number;
  conf: string;
  publish_time?: number;
}
interface HermesParsedItem {
  id: string;
  price: HermesPriceEntry;
  ema_price?: HermesPriceEntry;
  metadata?: {
    slot?: number;
    publish_time?: number;
    prev_publish_time?: number;
  };
}
interface HermesResponse {
  parsed?: HermesParsedItem[];
  binary?: { encoding: string; data: string[] };
}

const HERMES_LATEST_DEFAULT =
  "https://hermes.pyth.network/v2/updates/price/latest";

export const pythPullAdapter: OracleAdapter = {
  name: "pyth-pull",

  async getLatest(
    oracle: OracleRow,
    _asset: AssetRow,
    ctx: AdapterContext,
  ): Promise<OracleObservation> {
    const cfg = adapterHelpers.parseConfig<PythConfig>(oracle, ["price_id"]);
    if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.price_id)) {
      throw new AdapterError(
        `oracle ${oracle.oracle_id}: price_id malformed (expect 0x + 64 hex)`,
        oracle.oracle_id,
        "config_invalid",
        { price_id: cfg.price_id },
      );
    }

    const endpoint =
      ctx.hermesEndpoint ??
      process.env.PYTH_HERMES_ENDPOINT ??
      HERMES_LATEST_DEFAULT;
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const now = ctx.now ?? (() => new Date());
    const url = `${endpoint}?ids[]=${cfg.price_id}&parsed=true`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ctx.hermesTimeoutMs ?? 6_000);
    let payload: HermesResponse;
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) {
        throw new AdapterError(
          `hermes HTTP ${res.status}`,
          oracle.oracle_id,
          "http_failure",
        );
      }
      payload = (await res.json()) as HermesResponse;
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      throw new AdapterError(
        "hermes fetch failed",
        oracle.oracle_id,
        "http_failure",
        { error: errorMessage(err) },
      );
    } finally {
      clearTimeout(timer);
    }

    const item = payload.parsed?.[0];
    if (!item) {
      throw new AdapterError(
        "hermes returned no parsed entries",
        oracle.oracle_id,
        "parse_error",
      );
    }
    const px = item.price;
    if (!px || typeof px.price !== "string" || typeof px.expo !== "number") {
      throw new AdapterError(
        "hermes parsed entry missing price/expo",
        oracle.oracle_id,
        "missing_field",
      );
    }
    const priceBig = BigInt(px.price);
    if (priceBig <= 0n) {
      throw new AdapterError(
        "pyth price non-positive",
        oracle.oracle_id,
        "missing_field",
      );
    }
    const price = adapterHelpers.formatPythDecimal(priceBig, px.expo);
    const publishUnix = px.publish_time ?? item.metadata?.publish_time;
    if (typeof publishUnix !== "number") {
      throw new AdapterError(
        "hermes parsed entry missing publish_time",
        oracle.oracle_id,
        "missing_field",
      );
    }
    const feed_timestamp = adapterHelpers.isoFromUnixSeconds(publishUnix);
    const observed_at = adapterHelpers.nowIso(now);
    const source_age_seconds = Math.max(
      0,
      Math.floor(now().getTime() / 1000) - publishUnix,
    );

    return {
      oracle_id: oracle.oracle_id,
      asset_id: oracle.asset_id,
      price,
      feed_timestamp,
      observed_at,
      source_id: `pyth:${publishUnix}`,
      source_age_seconds,
    };
  },
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
