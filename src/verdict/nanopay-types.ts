import type Database from "better-sqlite3";

import type {
  DomainParams,
  FhenixAnchorTuple,
} from "./single-stream-binding.js";

export interface NanopayRouterDeps {
  readonly db: Database.Database;
  /** Pipeline id → price + recipient from the env catalog; null is a 404. */
  readonly resolvePipeline: (pipelineId: string) => PipelineInfo | null;
  /** Latest sealed call for a pipeline (reveal artifact null pre-reveal); null is a 503. */
  readonly resolveLatestSealedCall: (
    pipelineId: string,
  ) => { anchor: FhenixAnchorTuple; revealArtifact: unknown | null } | null;
  /** Defaults to testnet. */
  readonly network?: "testnet" | "mainnet";
  /** EIP-712 domain for `requestSignalId` hashing. */
  readonly bindingDomain: DomainParams;
  /** Seller wallet that receives Nanopayments. */
  readonly sellerAddress: `0x${string}`;
  /** Clock supplied by Nanopay Runtime for paid-settlement persistence. */
  readonly now: () => Date;
  /** Optional CAIP-2 allowlist, e.g. `["eip155:421614"]`; omitted accepts every Gateway network. */
  readonly acceptNetworks?: string[];
  /**
   * Per-call dollar price (e.g. "$0.001") for `gateway.require(price)`, shared by all pipelines.
   * Per-pipeline pricing would need one middleware per pipeline or dynamic SDK pricing.
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
