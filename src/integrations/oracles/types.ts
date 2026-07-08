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

import type {
  AssetRow,
  OracleRow,
} from "../../verdict/repos/market-registry-repo.js";
import type { PythHermesTimers } from "../pyth-hermes.js";

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
  hermesTimers?: PythHermesTimers;
  /** Test injection seam. */
  fetchImpl?: typeof fetch;
  readContractClient?: {
    readContract: (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }) => Promise<unknown>;
  };
  now: () => Date;
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
