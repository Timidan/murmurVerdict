import { parseAbi, type AbiEvent, type Address, type Hex } from "viem";

import {
  FEED_PACKET_SUBMITTED_EVENT,
  SEALED_CALL_SUBMITTED_EVENT,
} from "./fhenix-event-primitives.js";

// CoFHE 0.7: each input is a bytes32 handle; both share ONE `inputProof` signed over
// keccak256(binaryIndexInput || confidenceInput). Swapping the handles invalidates it.
const MURMUR_SEALED_VERDICTS_GATEWAY_FUNCTIONS_ABI = parseAbi([
  "function submitSealedFor(address agent,bytes32 marketId,bytes32 binaryIndexInput,bytes32 confidenceInput,bytes inputProof,bytes32 clientNonce) returns (bytes32)",
  "function submitFeedPacketFor(address agent,bytes32 feedId,bytes32 marketId,bytes32 actionInput,bytes32 signalInput,bytes inputProof,bytes32 clientNonce) returns (bytes32)",
  // Reconciliation views; revert CallNotFound / PacketNotFound if the id was never written.
  "function getCall(bytes32 callId) view returns (address agent, bytes32 marketId, uint64 acceptedAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint8 revealedBinaryIndex, uint16 revealedConfidenceBps, uint8 state)",
  "function getFeedPacket(bytes32 packetId) view returns (address agent, bytes32 feedId, bytes32 marketId, uint64 acceptedAt, uint64 revealAfter, bytes32 actionCtHash, bytes32 signalCtHash, uint8 revealedAction, uint16 revealedSignalBps, uint8 state)",
]);

// Functions plus the two submit events, used to recover a lost receipt via getLogs.
export const MURMUR_SEALED_VERDICTS_GATEWAY_ABI = [
  ...MURMUR_SEALED_VERDICTS_GATEWAY_FUNCTIONS_ABI,
  SEALED_CALL_SUBMITTED_EVENT,
  FEED_PACKET_SUBMITTED_EVENT,
] as const;

export interface GatewayWriteOptions {
  /**
   * Runs INSIDE the serialized broadcast slot, just before signing, to re-check state
   * that went stale in the queue. Throwing aborts before any transaction is sent.
   */
  preBroadcast?: () => void;
}

export interface FhenixGatewayClient {
  getChainId: () => Promise<number>;
  getBlockNumber: () => Promise<bigint>;
  writeContract: (
    args: GatewayWriteContractArgs,
    opts?: GatewayWriteOptions,
  ) => Promise<Hex>;
  getTransactionReceipt: (args: { hash: Hex }) => Promise<GatewayReceipt>;
  /** Reconciliation read; return null on CallNotFound / PacketNotFound rather than throw. */
  readContract?: (args: GatewayReadContractArgs) => Promise<unknown>;
  /** Reconciliation read: recover txHash, logIndex, blockNumber by indexed id when a write result was lost. */
  getLogs?: (args: GatewayGetLogsArgs) => Promise<readonly GatewayLog[]>;
}

export type GatewayWriteContractArgs =
  | {
      address: Address;
      abi: typeof MURMUR_SEALED_VERDICTS_GATEWAY_ABI;
      functionName: "submitSealedFor";
      // agent, marketId, binaryIndex handle, confidence handle, shared
      // inputProof, clientNonce.
      args: readonly [Address, Hex, Hex, Hex, Hex, Hex];
    }
  | {
      address: Address;
      abi: typeof MURMUR_SEALED_VERDICTS_GATEWAY_ABI;
      functionName: "submitFeedPacketFor";
      // No reveal-time argument: the contract reads it from the market.
      // agent, feedId, marketId, action handle, signal handle, shared
      // inputProof, clientNonce.
      args: readonly [Address, Hex, Hex, Hex, Hex, Hex, Hex];
    };

export type GatewayReadContractArgs = {
  address: Address;
  abi: typeof MURMUR_SEALED_VERDICTS_GATEWAY_ABI;
  functionName: "getCall" | "getFeedPacket";
  args: readonly [Hex];
};

export type GatewayGetLogsArgs = {
  address: Address;
  event: AbiEvent;
  args: { callId?: Hex; packetId?: Hex };
  fromBlock: bigint;
  toBlock: bigint | "latest";
};

export type GatewayReceipt = {
  status?: "success" | "reverted";
  blockNumber?: bigint;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  logs: readonly GatewayLog[];
};

export type GatewayLog = {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number;
  blockNumber?: bigint;
  transactionHash?: Hex;
};

/**
 * One sealed (euint8, euint16) pair as contract args: two handles plus ONE batch proof.
 * `firstHandle` is the euint8; the order is covered by the digest.
 */
export type ContractSealedInputPair = {
  firstHandle: Hex;
  secondHandle: Hex;
  inputProof: Hex;
};
