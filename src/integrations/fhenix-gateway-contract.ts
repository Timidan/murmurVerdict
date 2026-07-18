import { parseAbi, type AbiEvent, type Address, type Hex } from "viem";

import {
  FEED_PACKET_SUBMITTED_EVENT,
  SEALED_CALL_SUBMITTED_EVENT,
} from "./fhenix-event-primitives.js";

const MURMUR_SEALED_VERDICTS_GATEWAY_FUNCTIONS_ABI = parseAbi([
  "function submitSealedFor(address agent,bytes32 marketId,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) binaryIndexInput,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) confidenceInput,bytes32 clientNonce) returns (bytes32)",
  "function submitFeedPacketFor(address agent,bytes32 feedId,bytes32 marketId,uint64 revealAfter,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) actionInput,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) signalInput,bytes32 clientNonce) returns (bytes32)",
  // View accessors used by the reconciliation path
  // (src/integrations/fhenix-gateway-reconciliation.ts). They revert with
  // CallNotFound / PacketNotFound if the id has never been written, which
  // the reconciler treats as "no on-chain state → safe to retry".
  "function getCall(bytes32 callId) view returns (address agent, bytes32 marketId, uint64 acceptedAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint8 revealedBinaryIndex, uint16 revealedConfidenceBps, uint8 state)",
  "function getFeedPacket(bytes32 packetId) view returns (address agent, bytes32 feedId, bytes32 marketId, uint64 acceptedAt, uint64 revealAfter, bytes32 actionCtHash, bytes32 signalCtHash, uint8 revealedAction, uint16 revealedSignalBps, uint8 state)",
]);

// The Murmur Gateway ABI is the function surface plus the two submit events,
// which are recovered via getLogs filtered on the indexed id when the
// writeContract receipt was lost (timeout race). The event items are imported
// from fhenix-event-primitives.ts (the single declaration shared with the
// verifier primitive and the smokes) rather than re-stated here, so there is no
// signature to keep "in lockstep".
export const MURMUR_SEALED_VERDICTS_GATEWAY_ABI = [
  ...MURMUR_SEALED_VERDICTS_GATEWAY_FUNCTIONS_ABI,
  SEALED_CALL_SUBMITTED_EVENT,
  FEED_PACKET_SUBMITTED_EVENT,
] as const;

export interface FhenixGatewayClient {
  getChainId: () => Promise<number>;
  getBlockNumber: () => Promise<bigint>;
  writeContract: (args: GatewayWriteContractArgs) => Promise<Hex>;
  getTransactionReceipt: (args: { hash: Hex }) => Promise<GatewayReceipt>;
  /**
   * Reconciliation read path: confirm the contract already accepted a
   * deterministic id. Implementations should NOT throw on revert — wrap
   * CallNotFound / PacketNotFound to return null so callers can branch on
   * "exists vs not" cleanly.
   */
  readContract?: (args: GatewayReadContractArgs) => Promise<unknown>;
  /**
   * Reconciliation read path: filter SealedCallSubmitted / FeedPacketSubmitted
   * by the indexed id topic to recover txHash + logIndex + blockNumber when
   * the prior writeContract result was lost.
   */
  getLogs?: (args: GatewayGetLogsArgs) => Promise<readonly GatewayLog[]>;
}

export type GatewayWriteContractArgs =
  | {
      address: Address;
      abi: typeof MURMUR_SEALED_VERDICTS_GATEWAY_ABI;
      functionName: "submitSealedFor";
      args: readonly [
        Address,
        Hex,
        ContractCofheInput,
        ContractCofheInput,
        Hex,
      ];
    }
  | {
      address: Address;
      abi: typeof MURMUR_SEALED_VERDICTS_GATEWAY_ABI;
      functionName: "submitFeedPacketFor";
      args: readonly [
        Address,
        Hex,
        Hex,
        bigint,
        ContractCofheInput,
        ContractCofheInput,
        Hex,
      ];
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

export type ContractCofheInput = {
  ctHash: bigint;
  securityZone: number;
  utype: number;
  signature: Hex;
};
