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

// The deterministic id derivations and their key shapes live in the dedicated
// contract-id module; re-exported here so existing reconciliation importers
// keep a single entry point.
export {
  computeFeedPacketId,
  computeSealedCallId,
} from "./fhenix-gateway-contract-ids.js";
export type {
  FeedPacketReconciliationKey,
  SealedCallReconciliationKey,
} from "./fhenix-gateway-contract-ids.js";

/**
 * A `getCall` / `getFeedPacket` revert (CallNotFound / PacketNotFound) is a
 * PROVEN negative: the node executed the read and the contract reported the id
 * does not exist, so it is safe to broadcast. Any OTHER failure — an RPC
 * transport drop, a timeout, a malformed response — is INDETERMINATE: the
 * prior write may in fact have landed, and treating it as "not found" would
 * broadcast a duplicate. This classifier is deliberately safe-by-default: only
 * a positively-identified contract revert returns true; everything else is
 * indeterminate and the caller rethrows so the attempt stays retryable WITHOUT
 * re-broadcasting.
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
  // Fallback for gateway-client adapters (and test fakes) that surface a
  // revert without extending viem's BaseError: they tag the emulated revert
  // class on `.name` anywhere in the cause chain.
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
  /**
   * Block height to start the log scan from. Use the contract's deployment
   * block so we never scan from 0 (which most public RPCs reject).
   */
  reconcileFromBlock: number;
}

export interface ReconciliationResult {
  txHash: string;
  logIndex: number;
  blockNumber: number;
}

/**
 * Returns the recovered submit event for a sealed call id if the contract
 * already accepted it; null otherwise.
 *
 * Failure modes:
 *  - readContract PROVEN revert (CallNotFound) → returns null. Safe to
 *    broadcast a fresh write.
 *  - readContract indeterminate failure (RPC drop / timeout) → THROWS, so the
 *    caller keeps the row retryable WITHOUT broadcasting (the prior write may
 *    have landed).
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
