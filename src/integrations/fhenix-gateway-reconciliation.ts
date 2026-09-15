/**
 * Broadcast-timeout reconciliation. A timed-out write may still have landed; a retry
 * would then revert CallAlreadyExists / PacketAlreadyExists and strand the row.
 *
 *   1. Compute the deterministic id off-chain (same formula as the contract).
 *   2. getCall / getFeedPacket: a proven revert means no on-chain state; return null.
 *   3. Otherwise getLogs by the indexed id to recover tx_hash, log_index, block_number.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";

import {
  FEED_PACKET_SUBMITTED_EVENT,
  SEALED_CALL_SUBMITTED_EVENT,
} from "./fhenix-event-primitives.js";
import {
  MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
  type FhenixGatewayClient,
} from "./fhenix-gateway-contract.js";
import {
  computeFeedPacketId,
  computeSealedCallId,
  type FeedPacketReconciliationKey,
  type SealedCallReconciliationKey,
} from "./fhenix-gateway-contract-ids.js";

// Re-exported so reconciliation importers keep one entry point.
export {
  computeFeedPacketId,
  computeSealedCallId,
} from "./fhenix-gateway-contract-ids.js";
export type {
  FeedPacketReconciliationKey,
  SealedCallReconciliationKey,
} from "./fhenix-gateway-contract-ids.js";

/**
 * Only a proven contract revert (CallNotFound / PacketNotFound) is a safe negative. Any
 * other failure is indeterminate (the write may have landed): callers rethrow and stay
 * retryable WITHOUT re-broadcasting.
 */
const REVERT_ERROR_NAMES = new Set([
  "ContractFunctionRevertedError",
  "ContractFunctionZeroDataError",
]);

export function isProvenContractRevert(err: unknown): boolean {
  if (err instanceof BaseError) {
    const revert = err.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ContractFunctionZeroDataError,
    );
    if (revert) return true;
  }
  // Fallback for adapters and fakes that tag the revert class on `.name` in the cause chain.
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    const name = (cur as { name?: unknown }).name;
    if (typeof name === "string" && REVERT_ERROR_NAMES.has(name)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export interface ReconciliationConfig {
  client: FhenixGatewayClient;
  chainId: number;
  contractAddress: string;
  /** Log scan start: the contract's deployment block, never 0 (most RPCs reject it). */
  reconcileFromBlock: number;
}

export interface ReconciliationResult {
  txHash: string;
  logIndex: number;
  blockNumber: number;
}

/**
 * Recovered submit event if the contract already accepted the call id, else null.
 *  - proven revert (CallNotFound) → null; safe to broadcast.
 *  - indeterminate read failure → throws; stay retryable without broadcasting.
 *  - id exists but getLogs fails or finds nothing → throws.
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
  } catch (err) {
    if (isProvenContractRevert(err)) return null; // CallNotFound — safe to broadcast.
    throw err; // Indeterminate RPC failure — do NOT broadcast; stay retryable.
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
  } catch (err) {
    if (isProvenContractRevert(err)) return null; // PacketNotFound — safe to broadcast.
    throw err; // Indeterminate RPC failure — do NOT broadcast; stay retryable.
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
