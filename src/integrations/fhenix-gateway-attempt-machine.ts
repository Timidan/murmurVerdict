import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Address } from "viem";

import type {
  FhenixGatewayClient,
  GatewayReceipt,
  GatewayWriteContractArgs,
} from "./fhenix-gateway-contract.js";
import {
  errorMessage,
  measure,
  receiptTelemetry,
  safeBlockNumber,
  withTimeout,
  type ConfirmationState,
  type FhenixGatewayRuntimeTimers,
  type Measured,
} from "./fhenix-gateway-runtime.js";
import type {
  ReconciliationConfig,
  ReconciliationResult,
} from "./fhenix-gateway-reconciliation.js";
import {
  isBroadcastableStatus,
  type GatewayAttemptLifecycle,
  type GatewayAttemptLifecycleRow,
} from "../verdict/repos/fhenix-gateway-attempt-lifecycle.js";
import type {
  GatewayFeedPacketSubmitResult,
  GatewaySubmitResult,
} from "./fhenix-gateway-presenters.js";
import { isoFromMs, nowIso } from "../verdict/time.js";
import {
  agentCredentialsDisabledAt,
  isRuntimeKeyActive,
} from "../verdict/auth/accounts.js";

/**
 * Gateway Attempt Machine — the single implementation of the Gateway
 * Attempt status machine (queued → submitted → confirmed → accepted, with
 * failed_retryable / failed_terminal branches). CONTEXT.md defines a
 * Gateway Attempt as one concept that may produce one Sealed Call or one
 * feed packet; the machine owns the sequencing invariants once, and a
 * GatewayAttemptKind adapter supplies the per-lane facts: which lifecycle
 * store, how to reconcile, what to write on-chain, how to read the submit
 * event, what to persist on confirmation, and how to accept.
 *
 * The load-bearing invariant with exactly one home here:
 * **reconcile-before-retry** — a writeContract timeout may have landed
 * on-chain anyway, so any row that could plausibly have an unrecorded tx
 * (no tx_hash AND previously attempted or claimed) is reconciled against
 * contract state BEFORE a new broadcast can re-spend its clientNonce and
 * revert with CallAlreadyExists / PacketAlreadyExists.
 */
export interface GatewayAttemptKind<
  Row extends GatewayAttemptLifecycleRow,
  Event,
> {
  label: "sealed_call" | "feed_packet";
  lifecycle: GatewayAttemptLifecycle<Row>;
  /** Reconciliation lookup keyed by this lane's deterministic on-chain id. */
  reconcile(
    config: ReconciliationConfig,
    attempt: Row,
  ): Promise<ReconciliationResult | null>;
  /** Full writeContract args for this lane (may throw on malformed stored
   *  CoFHE input JSON — the machine records that as a retryable failure
   *  under the held claim token). */
  contractWrite(attempt: Row, contractAddress: Address): GatewayWriteContractArgs;
  /** Extract this lane's submit event from the receipt; null = not found. */
  extractSubmitEvent(attempt: Row, receipt: GatewayReceipt): Event | null;
  /** Persist the lane-specific confirmed metadata (markConfirmed payload). */
  persistConfirmed(
    db: Database.Database,
    attempt: Row,
    event: Event,
    updated_at: string,
  ): void;
  /** Accept a confirmed attempt into its produced entity (Sealed Call row
   *  or feed packet row). Wraps the lane's acceptance Module. */
  accept(db: Database.Database, attempt: Row, now: () => Date): Promise<boolean>;
  terminal: {
    runtimeKeyRevoked: string;
    maxAttemptsExceeded(maxAttempts: number): string;
    reverted: string;
  };
  /** Operator-retry conflict message for non-retryable statuses. */
  retryConflictMessage(status: string): string;
  /** Error thrown when a row vanishes between a retry broadcast and its
   *  presenter re-read — worded per lane so it stops branching in retryKind. */
  missingAfterRetryMessage(attemptId: string): string;
  /** Full `admin_fhenix_gateway_retry` audit payload, in this lane's exact
   *  historical key order (payloads are persisted as JSON text). */
  retryAuditPayload(
    attempt: Row,
    ctx: { chain_id: number; contract_address: string },
  ): Record<string, unknown>;
  /** Lane submission result presenter for routes/admin retry. */
  presentResult(
    db: Database.Database,
    attempt: Row,
    idempotent_hit: boolean,
  ): GatewaySubmitResult | GatewayFeedPacketSubmitResult;
}

export interface GatewayBroadcastConfig {
  db: Database.Database;
  client: FhenixGatewayClient;
  chainId: number;
  contractAddress: string;
  /**
   * Block height the reconciliation log scan starts from. Use the contract's
   * deployment block (manifest entry in data/deployments.json) so we never
   * scan from 0 — most public RPCs reject getLogs spans that large.
   */
  reconcileFromBlock: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  broadcastTimeoutMs: number;
  timers?: FhenixGatewayRuntimeTimers;
  newClaimToken?: () => string;
  now: () => Date;
}

/**
 * The transition a single {@link broadcastGatewayAttempt} tick performed —
 * surfaced so callers switch on the outcome instead of re-reading the row and
 * inferring the transition from status strings + attempt_count deltas:
 *  - `submitted`             — a new on-chain write landed (attempt_count++).
 *  - `reconciled`            — a prior landed-but-unrecorded tx was recovered.
 *  - `retryable_failure`     — the broadcast failed but may be retried.
 *  - `terminal_failure`      — the row exhausted retries / was revoked / etc.
 *  - `reconciliation_failure`— the pre-retry reconcile read failed (no write).
 *  - `skipped`              — nothing to do (row gone, not broadcastable, or
 *                              lost the claim race to another writer).
 */
export type GatewayBroadcastResult = {
  kind:
    | "submitted"
    | "reconciled"
    | "retryable_failure"
    | "terminal_failure"
    | "reconciliation_failure"
    | "skipped";
};

export async function broadcastGatewayAttempt<
  Row extends GatewayAttemptLifecycleRow,
  Event,
>(
  kind: GatewayAttemptKind<Row, Event>,
  config: GatewayBroadcastConfig & { attemptId: string },
): Promise<GatewayBroadcastResult> {
  const attempt = kind.lifecycle.byId(config.db, config.attemptId);
  if (!attempt || !isBroadcastableStatus(attempt.status)) {
    return { kind: "skipped" };
  }
  const runtimeKeyCheckedAt = config.now();
  if (
    attempt.runtime_key_id &&
    !isRuntimeKeyActive(config.db, {
      runtime_key_id: attempt.runtime_key_id,
      checkedAt: runtimeKeyCheckedAt,
    })
  ) {
    kind.lifecycle.markTerminalFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error: kind.terminal.runtimeKeyRevoked,
      updated_at: nowIso(runtimeKeyCheckedAt),
    });
    return { kind: "terminal_failure" };
  }
  // The kill switch revokes every key in the same transaction, so the check
  // above already fells most queued attempts — this account-level gate closes
  // the remainder (rows whose runtime_key_id went NULL, and the window
  // between an engage commit and a claim that read the key just before).
  if (agentCredentialsDisabledAt(config.db, attempt.account_id)) {
    kind.lifecycle.markTerminalFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error: "account kill switch engaged before broadcast",
      updated_at: nowIso(runtimeKeyCheckedAt),
    });
    return { kind: "terminal_failure" };
  }
  // Reconcile before retrying. A prior writeContract may have landed even
  // though its receipt was lost to a timeout — without this step the next
  // retry hits CallAlreadyExists / PacketAlreadyExists and the row strands.
  // Reconciliation triggers whenever the row could plausibly have a
  // landed-but-unrecorded tx on-chain: no tx_hash AND we've either
  // attempted at least once OR a broadcast was started but never
  // resolved (sweepStuckClaims path; also `retryAttemptNow()` resets
  // the row back to `queued` so we don't restrict by status).
  if (
    !attempt.tx_hash &&
    (attempt.attempt_count > 0 || attempt.broadcast_started_at != null)
  ) {
    try {
      const recovered = await kind.reconcile(
        {
          client: config.client,
          chainId: config.chainId,
          contractAddress: config.contractAddress,
          reconcileFromBlock: config.reconcileFromBlock,
        },
        attempt,
      );
      if (recovered) {
        kind.lifecycle.markReconciledSubmitted(config.db, {
          attempt_id: attempt.attempt_id,
          tx_hash: recovered.txHash,
          next_attempt_at: isoFromMs(
            config.now().getTime() + config.retryMaxMs,
          ),
          updated_at: nowIso(config.now()),
        });
        return { kind: "reconciled" };
      }
    } catch (err) {
      // Reconciliation failure (e.g. RPC dropped). Surface as a clear
      // retryable error WITHOUT incrementing attempt_count — the row
      // still hasn't been broadcast in this tick.
      kind.lifecycle.markReconciliationFailure(config.db, {
        attempt_id: attempt.attempt_id,
        last_error: `Reconciliation failed: ${errorMessage(err)}`,
        next_attempt_at: nextRetryAt(config, attempt.attempt_count + 1),
        updated_at: nowIso(config.now()),
      });
      return { kind: "reconciliation_failure" };
    }
  }
  if (attempt.attempt_count >= config.maxAttempts) {
    kind.lifecycle.markTerminalFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error: kind.terminal.maxAttemptsExceeded(config.maxAttempts),
      updated_at: nowIso(config.now()),
    });
    return { kind: "terminal_failure" };
  }
  const broadcastStartedAt = nowIso(config.now());
  // Claim the row atomically. If another writer already claimed it, abort.
  // Retain the token so a slow write cannot overwrite a newer claimant.
  const claimToken = (config.newClaimToken ?? randomUUID)();
  const claimed = kind.lifecycle.claimForBroadcast(config.db, {
    attempt_id: attempt.attempt_id,
    broadcast_started_at: broadcastStartedAt,
    updated_at: broadcastStartedAt,
    token: claimToken,
  });
  if (!claimed) return { kind: "skipped" };
  try {
    const write = kind.contractWrite(
      attempt,
      config.contractAddress as Address,
    );
    const { value: txHash, latencyMs } = await measure(
      () => config.now().getTime(),
      () => withTimeout(
        config.client.writeContract(write),
        config.broadcastTimeoutMs,
        write.functionName,
        config.timers,
      ),
    );
    kind.lifecycle.markSubmitted(config.db, {
      attempt_id: attempt.attempt_id,
      tx_hash: txHash.toLowerCase(),
      next_attempt_at: isoFromMs(config.now().getTime() + config.retryMaxMs),
      updated_at: nowIso(config.now()),
      broadcast_started_at: broadcastStartedAt,
      broadcast_latency_ms: latencyMs,
      claim_token: claimToken,
    });
    return { kind: "submitted" };
  } catch (err) {
    kind.lifecycle.markRetryableFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error: errorMessage(err),
      next_attempt_at: nextRetryAt(config, attempt.attempt_count + 1),
      updated_at: nowIso(config.now()),
      broadcast_started_at: broadcastStartedAt,
      broadcast_latency_ms: null,
      claim_token: claimToken,
    });
    return { kind: "retryable_failure" };
  }
}

export type GatewayConfirmationResult<T> =
  | {
      kind: "confirmed";
      attempt: T | null;
    }
  | {
      kind: "not_confirmed";
    };

export async function confirmGatewayAttempt<
  Row extends GatewayAttemptLifecycleRow,
  Event,
>(
  kind: GatewayAttemptKind<Row, Event>,
  params: {
    db: Database.Database;
    client: FhenixGatewayClient;
    confirmations: number;
    attempt: Row;
    now: () => Date;
  },
): Promise<GatewayConfirmationResult<Row>> {
  const { db, client, confirmations, attempt, now } = params;
  if (!attempt.tx_hash) return { kind: "not_confirmed" };
  const receiptObservedAt = nowIso(now());
  let measuredReceipt: Measured<GatewayReceipt>;
  try {
    measuredReceipt = await measure(
      () => now().getTime(),
      () => client.getTransactionReceipt({ hash: attempt.tx_hash as `0x${string}` }),
    );
  } catch (err) {
    kind.lifecycle.recordRpcError(db, {
      attempt_id: attempt.attempt_id,
      receipt_observed_at: receiptObservedAt,
      receipt_latency_ms: null,
      last_rpc_error: errorMessage(err),
    });
    return { kind: "not_confirmed" };
  }
  const receipt = measuredReceipt.value;
  let confirmation: ConfirmationState;
  try {
    confirmation = await confirmationState({ client, receipt, confirmations, now });
  } catch (err) {
    kind.lifecycle.recordReceiptTelemetry(db, receiptTelemetry({
      attempt_id: attempt.attempt_id,
      receipt,
      receipt_observed_at: receiptObservedAt,
      receipt_latency_ms: measuredReceipt.latencyMs,
      confirmation: null,
      last_rpc_error: errorMessage(err),
    }));
    return { kind: "not_confirmed" };
  }
  kind.lifecycle.recordReceiptTelemetry(db, receiptTelemetry({
    attempt_id: attempt.attempt_id,
    receipt,
    receipt_observed_at: receiptObservedAt,
    receipt_latency_ms: measuredReceipt.latencyMs,
    confirmation,
    last_rpc_error: null,
  }));
  if (receipt.status === "reverted") {
    kind.lifecycle.markTerminalFailure(db, {
      attempt_id: attempt.attempt_id,
      last_error: kind.terminal.reverted,
      updated_at: nowIso(now()),
    });
    return { kind: "not_confirmed" };
  }
  if (!confirmation.ready) return { kind: "not_confirmed" };
  const event = kind.extractSubmitEvent(attempt, receipt);
  if (!event) return { kind: "not_confirmed" };
  kind.persistConfirmed(db, attempt, event, nowIso(now()));
  return {
    kind: "confirmed",
    attempt: kind.lifecycle.byId(db, attempt.attempt_id),
  };
}

async function confirmationState(params: {
  client: FhenixGatewayClient;
  confirmations: number;
  now: () => Date;
  receipt: GatewayReceipt;
}): Promise<ConfirmationState> {
  const { client, confirmations, now, receipt } = params;
  if (confirmations === 0 || receipt.blockNumber === undefined) {
    return {
      ready: true,
      latestBlockNumber: safeBlockNumber(receipt.blockNumber),
      latestBlockLatencyMs: null,
      confirmationsObserved: receipt.blockNumber === undefined ? null : 1,
    };
  }
  const latest = await measure(
    () => now().getTime(),
    () => client.getBlockNumber(),
  );
  const observed = latest.value >= receipt.blockNumber
    ? latest.value - receipt.blockNumber + 1n
    : 0n;
  return {
    ready: latest.value >= receipt.blockNumber + BigInt(confirmations - 1),
    latestBlockNumber: safeBlockNumber(latest.value),
    latestBlockLatencyMs: latest.latencyMs,
    confirmationsObserved: safeBlockNumber(observed),
  };
}

function nextRetryAt(
  config: GatewayBroadcastConfig,
  nextAttemptNumber: number,
): string {
  const delay = Math.min(
    config.retryMaxMs,
    config.retryBaseMs * 2 ** Math.max(0, nextAttemptNumber - 1),
  );
  return isoFromMs(config.now().getTime() + delay);
}
