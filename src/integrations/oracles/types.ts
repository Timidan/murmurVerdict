// Oracle adapter contract.
//
// An adapter takes an oracle_id (registry row) + asset metadata and returns a
// price observation. The registry table `oracles.adapter` field selects which
// adapter implementation handles the row (currently `chainlink-evm` and
// `pyth-pull`; future: `pyth-solana`, `chainlink-svm`, `redstone`, etc).
//
// The legacy `src/integrations/oracle.ts::OracleClient` predates this and is
// hard-coded to chainlink+pyth on Base ETH/USD. Adapter migration happens
// gradually — adapters land first, the resolver migrates next.

import type { OracleRow, AssetRow } from "../../verdict/db.js";

export interface OracleObservation {
  oracle_id: string;
  asset_id: string;
  /** Decimal string, e.g. "3142.85". Normalized — no scientific notation. */
  price: string;
  /** ISO8601 UTC ('Z' suffix), no fractional seconds. */
  feed_timestamp: string;
  /** When we observed it. ISO8601 UTC. */
  observed_at: string;
  /** Round ID / publish slot, hex-encoded for stability. */
  source_id: string;
  /** now() − feed_timestamp at observation time. */
  source_age_seconds: number;
}

export type OracleErrorKind =
  | "rpc_failure"
  | "stale"
  | "missing_field"
  | "http_failure"
  | "parse_error"
  | "config_invalid";

export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly oracle_id: string,
    public readonly cause_kind: OracleErrorKind,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export interface AdapterContext {
  /** Per-instance config injected by the daemon (RPC URLs, Hermes endpoint, etc). */
  baseRpcUrl?: string;
  hermesEndpoint?: string;
  rpcTimeoutMs?: number;
  hermesTimeoutMs?: number;
  /** Test injection seam. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface OracleAdapter {
  /** Stable name, matches `oracles.adapter` column. */
  readonly name: string;
  /**
   * Read the latest observation for `oracle.oracle_id`. Throws AdapterError
   * with cause_kind set on every failure (no soft fallbacks at this layer —
   * the market policy decides when to walk to the fallback oracle).
   */
  getLatest(
    oracle: OracleRow,
    asset: AssetRow,
    ctx: AdapterContext,
  ): Promise<OracleObservation>;
}

/** Helpers shared by adapters. Kept in a value namespace so adapters can
 *  reach for them without importing each other. */
export const adapterHelpers = {
  nowIso(now: () => Date): string {
    return now().toISOString().replace(/\.\d+Z$/, "Z");
  },
  isoFromUnixSeconds(s: bigint | number): string {
    const ms = typeof s === "bigint" ? Number(s) * 1000 : s * 1000;
    return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  },
  formatFixed(value: bigint, decimals: number): string {
    const neg = value < 0n;
    const abs = neg ? -value : value;
    const s = abs.toString().padStart(decimals + 1, "0");
    const cut = s.length - decimals;
    const intPart = s.slice(0, cut);
    const fracPart = s.slice(cut).replace(/0+$/, "");
    const out = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
    return neg ? `-${out}` : out;
  },
  formatPythDecimal(value: bigint, expo: number): string {
    if (expo === 0) return value.toString();
    if (expo > 0) return `${value.toString()}${"0".repeat(expo)}`;
    return adapterHelpers.formatFixed(value, -expo);
  },
  parseConfig<T = Record<string, unknown>>(
    oracle: OracleRow,
    requiredKeys: ReadonlyArray<string>,
  ): T {
    let parsed: unknown;
    try {
      parsed = JSON.parse(oracle.config_json);
    } catch {
      throw new AdapterError(
        `oracle ${oracle.oracle_id}: config_json is not valid JSON`,
        oracle.oracle_id,
        "config_invalid",
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new AdapterError(
        `oracle ${oracle.oracle_id}: config_json must be a JSON object`,
        oracle.oracle_id,
        "config_invalid",
      );
    }
    const obj = parsed as Record<string, unknown>;
    for (const k of requiredKeys) {
      if (!(k in obj) || typeof obj[k] !== "string") {
        throw new AdapterError(
          `oracle ${oracle.oracle_id}: config missing required string '${String(k)}'`,
          oracle.oracle_id,
          "config_invalid",
          { config: obj },
        );
      }
    }
    return obj as T;
  },
};
