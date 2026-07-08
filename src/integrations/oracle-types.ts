import type {
  OracleFeed,
} from "../verdict/schema.js";
import type { PythHermesTimers } from "./pyth-hermes.js";

export interface ReadContractClient {
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) => Promise<unknown>;
}

export interface OracleObservation {
  feed: OracleFeed;
  price: string; // decimal, e.g. "3142.85"
  feed_timestamp: string; // ISO8601 UTC ('Z' suffix)
  observed_at: string; // when we read it; ISO8601 UTC
  /** Round ID for Chainlink, publish slot for Pyth. Hex-encoded for stability. */
  source_id: string;
  source_age_seconds: number; // now − feed_timestamp at observation time
}

export interface OracleClientConfig {
  baseRpcUrl?: string;
  chainlinkEthUsdAddress?: `0x${string}`;
  hermesEndpoint?: string;
  /** ms timeout per Chainlink RPC call */
  rpcTimeoutMs?: number;
  /** ms timeout per Hermes fetch */
  hermesTimeoutMs?: number;
  /** Observation clock shared by legacy readers and registry adapter context. */
  now: () => Date;
  /** Optional injection for tests */
  publicClient?: ReadContractClient;
  fetchImpl?: typeof fetch;
  hermesTimers?: PythHermesTimers;
}

export type OracleErrorKind =
  | "rpc_failure"
  | "stale"
  | "missing_field"
  | "http_failure"
  | "parse_error";

export class OracleError extends Error {
  constructor(
    message: string,
    public readonly feed: OracleFeed,
    public readonly cause_kind: OracleErrorKind,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OracleError";
  }
}
