/**
 * Fhenix Gateway broadcast-timeout reconciliation.
 *
 * Closes the race documented at src/integrations/fhenix-gateway-runtime.ts:45:
 * a writeContract timeout marks the attempt failed_retryable, but the RPC
 * was never cancelled — the submitSealedFor() / submitFeedPacketFor() may
 * still have landed. On retry the contract reverts CallAlreadyExists /
 * PacketAlreadyExists (see contracts/src/MurmurSealedVerdicts.sol:235 / :378)
 * and the local row is stranded with no submit_tx_hash.
 *
 * Strategy:
 *   1. Compute the deterministic id off-chain (same formula as the contract:
 *      keccak256(abi.encodePacked(chainId, contract, agent, [feedId,] marketId, clientNonce)))
 *   2. readContract.getCall / getFeedPacket — if it reverts (CallNotFound /
 *      PacketNotFound), no on-chain state, return null and let the broadcast
 *      proceed normally.
 *   3. If the contract has the id, getLogs filtered by the indexed id topic
 *      on SealedCallSubmitted / FeedPacketSubmitted to recover the actual
 *      tx_hash + log_index + block_number from the prior successful write.
 *   4. Return the recovered submit event; caller persists via
 *      fhenixGatewayTxRepo.markReconciledSubmitted().
 */

import { encodePacked, getAbiItem, keccak256, type AbiEvent, type Address, type Hex } from "viem";

import {
  MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
  type FhenixGatewayClient,
} from "./fhenix-gateway-contract.js";

const SEALED_CALL_SUBMITTED_EVENT = getAbiItem({
  abi: MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
  name: "SealedCallSubmitted",
}) as AbiEvent;
const FEED_PACKET_SUBMITTED_EVENT = getAbiItem({
  abi: MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
  name: "FeedPacketSubmitted",
}) as AbiEvent;

export interface ReconciliationConfig {
  client: FhenixGatewayClient;
  chainId: number;
  contractAddress: string;
  /**
   * Block height to start the log scan from. Use the contract's deployment
   * block so we never scan from 0 (which most public RPCs reject).
   */
  reconcileFromBlock: number;
}

export interface SealedCallReconciliationKey {
  agentWalletAddress: string;
  marketIdHash: string;
  clientNonce: string;
}

export interface FeedPacketReconciliationKey {
  agentWalletAddress: string;
  feedIdHash: string;
  marketIdHash: string;
  clientNonce: string;
}

export interface ReconciliationResult {
  txHash: string;
  logIndex: number;
  blockNumber: number;
}

export function computeSealedCallId(
  chainId: number,
  contractAddress: string,
  key: SealedCallReconciliationKey,
): Hex {
  return keccak256(
    encodePacked(
      ["uint256", "address", "address", "bytes32", "bytes32"],
      [
        BigInt(chainId),
        contractAddress as Address,
        key.agentWalletAddress as Address,
        key.marketIdHash as Hex,
        key.clientNonce as Hex,
      ],
    ),
  );
}

export function computeFeedPacketId(
  chainId: number,
  contractAddress: string,
  key: FeedPacketReconciliationKey,
): Hex {
  return keccak256(
    encodePacked(
      ["uint256", "address", "address", "bytes32", "bytes32", "bytes32"],
      [
        BigInt(chainId),
        contractAddress as Address,
        key.agentWalletAddress as Address,
        key.feedIdHash as Hex,
        key.marketIdHash as Hex,
        key.clientNonce as Hex,
      ],
    ),
  );
}

/**
 * Returns the recovered submit event for a sealed call id if the contract
 * already accepted it; null otherwise.
 *
 * Failure modes:
 *  - readContract revert (CallNotFound) → returns null. Safe to retry.
 *  - readContract succeeds but getLogs fails / returns no rows → THROWS.
 *    The caller should keep the row retryable with a clear last_rpc_error
 *    rather than marking submitted without a tx_hash.
 */
export async function reconcileSealedCallSubmit(
  config: ReconciliationConfig,
  key: SealedCallReconciliationKey,
): Promise<ReconciliationResult | null> {
  if (!config.client.readContract || !config.client.getLogs) return null;
  const callId = computeSealedCallId(
    config.chainId,
    config.contractAddress,
    key,
  );
  try {
    await config.client.readContract({
      address: config.contractAddress as Address,
      abi: MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
      functionName: "getCall",
      args: [callId],
    });
  } catch {
    // CallNotFound (or any other revert) — contract has no record. Caller
    // should proceed with a normal write.
    return null;
  }
  return findSubmitEvent(config, SEALED_CALL_SUBMITTED_EVENT, { callId });
}

export async function reconcileFeedPacketSubmit(
  config: ReconciliationConfig,
  key: FeedPacketReconciliationKey,
): Promise<ReconciliationResult | null> {
  if (!config.client.readContract || !config.client.getLogs) return null;
  const packetId = computeFeedPacketId(
    config.chainId,
    config.contractAddress,
    key,
  );
  try {
    await config.client.readContract({
      address: config.contractAddress as Address,
      abi: MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
      functionName: "getFeedPacket",
      args: [packetId],
    });
  } catch {
    return null;
  }
  return findSubmitEvent(config, FEED_PACKET_SUBMITTED_EVENT, { packetId });
}

async function findSubmitEvent(
  config: ReconciliationConfig,
  event: AbiEvent,
  filterArg: { callId?: Hex; packetId?: Hex },
): Promise<ReconciliationResult> {
  const logs = await config.client.getLogs!({
    address: config.contractAddress as Address,
    event,
    args: filterArg,
    fromBlock: BigInt(Math.max(0, config.reconcileFromBlock)),
    toBlock: "latest",
  });
  if (logs.length === 0) {
    throw new Error(
      `Fhenix reconciliation: contract has ${event.name === "SealedCallSubmitted" ? "callId" : "packetId"} but getLogs returned no matching event from block ${config.reconcileFromBlock}`,
    );
  }
  const log = logs[0];
  if (!log.transactionHash || log.blockNumber === undefined) {
    throw new Error(
      `Fhenix reconciliation: recovered ${event.name} log is missing transactionHash or blockNumber`,
    );
  }
  return {
    txHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    blockNumber: Number(log.blockNumber),
  };
}
