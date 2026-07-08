import type Database from "better-sqlite3";

import type {
  DomainParams,
  FhenixAnchorTuple,
} from "./single-stream-binding.js";

export interface NanopayRouterDeps {
  readonly db: Database.Database;
  /**
   * Resolves a pipeline by id → price + recipient from the daemon's
   * env-backed Nanopay catalog. Route returns 404 when this returns null.
   */
  readonly resolvePipeline: (pipelineId: string) => PipelineInfo | null;
  /**
   * Resolves the latest sealed-Fhenix call for a pipeline → full
   * anchor tuple + reveal artifact (or null if pre-reveal). Route
   * returns 503 when this returns null.
   */
  readonly resolveLatestSealedCall: (
    pipelineId: string,
  ) => { anchor: FhenixAnchorTuple; revealArtifact: unknown | null } | null;
  /** Network — defaults to testnet for Phase 1. */
  readonly network?: "testnet" | "mainnet";
  /** EIP-712 domain for `requestSignalId` hashing. */
  readonly bindingDomain: DomainParams;
  /** Seller wallet that receives Nanopayments. */
  readonly sellerAddress: `0x${string}`;
  /** Clock supplied by Nanopay Runtime for paid-settlement persistence. */
  readonly now: () => Date;
  /**
   * Optional CAIP-2 network restrictions for the SDK middleware.
   * If omitted, the SDK accepts payments on ALL Gateway-supported
   * networks (recommended). Example: `["eip155:84532"]` for
   * Base-Sepolia-only.
   */
  readonly acceptNetworks?: string[];
  /**
   * Default per-call price in dollar string form (e.g. "$0.001"),
   * used as the `gateway.require(price)` argument. The SDK
   * converts this to USDC atomic units via its money-parser
   * registry. Phase 1: pipelines all share the same default; Phase 2
   * will switch to per-pipeline pricing.
   *
   * Note: pipeline-specific pricing requires generating one middleware
   * per pipeline OR passing dynamic price through the SDK; defer.
   */
  readonly defaultPrice?: string;
}

export interface PipelineInfo {
  /** USDC atoms (6-decimal) per call. */
  readonly priceAtoms: string;
  /** Address that receives the settled payment. */
  readonly recipient: `0x${string}`;
  /** Chain id where the recipient holds their Gateway Wallet. */
  readonly chainId: number;
  /** Optional human-readable description; do NOT include in 402 headers (privacy). */
  readonly internalDescription?: string;
}
