import type Database from "better-sqlite3";
import { marketsRepo } from "../verdict/repos/market-registry-repo.js";
import { randomUUID } from "node:crypto";
import type { Address } from "viem";

import type {
  FhenixGatewayClient,
  GatewayReceipt,
  GatewayWriteContractArgs,
} from "./fhenix-gateway-contract.js";
import {
  errorMessage,
  redactedErrorText,
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
 * Gateway Attempt Machine: the one implementation of queued → submitted → confirmed → accepted
 * (plus failed_retryable / failed_terminal). A GatewayAttemptKind supplies the per-lane facts.
 *
 * Invariant, reconcile-before-retry: a timed-out writeContract may have landed, so a row with no
 * tx_hash that was attempted or claimed is reconciled BEFORE a new broadcast re-spends its
 * clientNonce and reverts with CallAlreadyExists / PacketAlreadyExists.
 */
export interface GatewayAttemptKind<
  Row extends GatewayAttemptLifecycleRow,
  Event,
> {
  label: "sealed_call" | "feed_packet";
  lifecycle: GatewayAttemptLifecycle<Row>;
  /** Market this attempt writes against, for the in-slot operator-halt check. */
  marketId?(attempt: Row): string | null;
  /**
   * Deployment the attempt was RESERVED against; compared with the daemon's so a
   * redeploy or chain switch cannot relay old intents onto it.
   */
  deploymentOf?(attempt: Row): { chainId: number; contractAddress: string } | null;
  /**
   * Re-check policy that could have narrowed after this attempt was reserved.
   * Return a message to fail the attempt terminally, or null to proceed.
   */
  revalidate?(db: Database.Database, attempt: Row): string | null;
  /** Reconciliation lookup keyed by this lane's deterministic on-chain id. */
  reconcile(
    config: ReconciliationConfig,
    attempt: Row,
  ): Promise<ReconciliationResult | null>;
  /** May throw on malformed stored CoFHE input; recorded as retryable under the held claim. */
  contractWrite(attempt: Row, contractAddress: Address): GatewayWriteContractArgs;
  /** Extract this lane's submit event from the receipt; null = not found. */
  extractSubmitEvent(attempt: Row, receipt: GatewayReceipt): Event | null;
  persistConfirmed(
    db: Database.Database,
    attempt: Row,
    event: Event,
    updated_at: string,
  ): void;
  /** Accept a confirmed attempt into its Sealed Call or feed packet row. */
  accept(db: Database.Database, attempt: Row, now: () => Date): Promise<boolean>;
  terminal: {
    runtimeKeyRevoked: string;
    maxAttemptsExceeded(maxAttempts: number): string;
    reverted: string;
  };
  /** Operator-retry conflict message for non-retryable statuses. */
  retryConflictMessage(status: string): string;
  /** Error when a row vanishes between a retry broadcast and its presenter re-read. */
  missingAfterRetryMessage(attemptId: string): string;
  /** `admin_fhenix_gateway_retry` audit payload; key order is persisted as JSON, keep it stable. */
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
  /** Reconciliation scan start: the contract's deployment block, never 0 (RPCs reject huge getLogs spans). */
  reconcileFromBlock: number;
  /**
   * Scan start for writes on a PREVIOUS deployment on the same chain (FHENIX_RECONCILE_OLD_FROM_BLOCK).
   * Absent: no recovery is attempted, and the terminal error says so.
   */
  reconcileOldFromBlock?: number | null;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  broadcastTimeoutMs: number;
  timers?: FhenixGatewayRuntimeTimers;
  newClaimToken?: () => string;
  now: () => Date;
}

/**
 * The transition a single {@link broadcastGatewayAttempt} tick performed:
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
  // A broadcastable row that already has a tx_hash has a landed transaction (an
  // earlier worker's late write); promote it to `submitted` instead of writing again.
  // Must run BEFORE the auth and halt checks: a later revocation doesn't un-send
  // the tx, and terminalizing would strand it outside confirmation.
  if (attempt.tx_hash) {
    const promoted = kind.lifecycle.adoptJournalledTxHash(config.db, {
      attempt_id: attempt.attempt_id,
      claim_token: null,
      next_attempt_at: isoFromMs(config.now().getTime() + config.retryMaxMs),
      updated_at: nowIso(config.now()),
    });
    return { kind: promoted ? "reconciled" : "skipped" };
  }

  const runtimeKeyCheckedAt = config.now();
  if (
    attempt.runtime_key_id &&
    !isRuntimeKeyActive(config.db, {
      runtime_key_id: attempt.runtime_key_id,
      checkedAt: runtimeKeyCheckedAt,
    })
  ) {
    const terminalized = kind.lifecycle.markTerminalFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error: kind.terminal.runtimeKeyRevoked,
      updated_at: nowIso(runtimeKeyCheckedAt),
    });
    // A claimed row belongs to its owner or the stuck-claim sweep; not terminal_failure.
    return { kind: terminalized ? "terminal_failure" : "skipped" };
  }
  // Account-level gate for what the key check misses: NULL runtime_key_id and the engage/claim race.
  if (agentCredentialsDisabledAt(config.db, attempt.account_id)) {
    const terminalized = kind.lifecycle.markTerminalFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error: "account kill switch engaged before broadcast",
      updated_at: nowIso(runtimeKeyCheckedAt),
    });
    // A claimed row belongs to its owner or the stuck-claim sweep; not terminal_failure.
    return { kind: terminalized ? "terminal_failure" : "skipped" };
  }
  // Fail closed on a deployment change: the row's reserved (chain_id, contract_address)
  // must match the daemon's, or every step below hits the wrong contract.
  // Terminal, not retryable. Chain is compared too: the same address can exist elsewhere.
  const rowDeployment = kind.deploymentOf?.(attempt);
  if (
    rowDeployment &&
    (rowDeployment.chainId !== config.chainId ||
      rowDeployment.contractAddress.toLowerCase() !==
        config.contractAddress.toLowerCase())
  ) {
    // Reconcile first if a write may have landed on the OLD deployment; no later tick reads it again.
    const sameChain = rowDeployment.chainId === config.chainId;
    const canSearchOldLogs = config.reconcileOldFromBlock != null;
    let lookupFailed = false;
    if (
      sameChain &&
      canSearchOldLogs &&
      !attempt.tx_hash &&
      (attempt.attempt_count > 0 || attempt.broadcast_started_at != null)
    ) {
      try {
        const recovered = await kind.reconcile(
          {
            client: config.client,
            chainId: rowDeployment.chainId,
            contractAddress: rowDeployment.contractAddress,
            // Not reconcileFromBlock (the new contract's, later than any old write)
            // and not genesis (RPCs reject full-range getLogs).
            reconcileFromBlock: config.reconcileOldFromBlock ?? 0,
          },
          attempt,
        );
        if (recovered) {
          // The write landed on the old deployment; persist it and stop.
          const handedOff = kind.lifecycle.markReconciledSubmitted(config.db, {
            attempt_id: attempt.attempt_id,
            tx_hash: recovered.txHash,
            next_attempt_at: isoFromMs(
              config.now().getTime() + config.retryMaxMs,
            ),
            updated_at: nowIso(config.now()),
          });
          if (!handedOff) {
            // Another worker claimed the row during the RPC read. Journal the hash so its
            // preBroadcast hands the row to confirmation instead of sending a duplicate.
            kind.lifecycle.journalLateTxHash(config.db, {
            attempt_id: attempt.attempt_id,
            tx_hash: recovered.txHash,
            updated_at: nowIso(config.now()),
            });
            return { kind: "skipped" };
          }
          return { kind: "reconciled" };
        }
      } catch {
        // A failed read must not mask the mismatch, nor be reported as "nothing landed".
        lookupFailed = true;
      }
    }
    // Cross-chain rows are not recovered: `config.client` is bound to one RPC, so a read would query the wrong chain.
    const recoveryNote = !sameChain
      ? "it was NOT searched for: this daemon's RPC serves chain " +
        `${config.chainId}, so a write on chain ${rowDeployment.chainId} ` +
        "cannot be looked up from here — point a daemon at the old chain to " +
        "recover it"
      : !canSearchOldLogs
        ? "it was NOT searched for: set FHENIX_RECONCILE_OLD_FROM_BLOCK to " +
          "the old deployment's block so the log scan has a bounded range"
        : lookupFailed
          ? "the recovery log lookup FAILED (likely an RPC range limit), so " +
            "whether a transaction landed is UNKNOWN — re-run with a narrower " +
            "FHENIX_RECONCILE_OLD_FROM_BLOCK or an archive RPC before assuming " +
            "it did not"
          : "no landed transaction was found for it";
    const terminalized = kind.lifecycle.markTerminalFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error:
        `deployment changed: reserved against ${rowDeployment.contractAddress} ` +
        `on chain ${rowDeployment.chainId}, daemon now runs ` +
        `${config.contractAddress} on chain ${config.chainId}. Refusing to ` +
        `relay an intent formed against a different deployment; ${recoveryNote}.`,
      updated_at: nowIso(runtimeKeyCheckedAt),
    });
    // A claimed row belongs to its owner or the stuck-claim sweep; not terminal_failure.
    return { kind: terminalized ? "terminal_failure" : "skipped" };
  }
  // Re-validate lane policy that may have narrowed since reservation. Terminal.
  const policyError = kind.revalidate?.(config.db, attempt);
  if (policyError) {
    const terminalized = kind.lifecycle.markTerminalFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error: policyError,
      updated_at: nowIso(runtimeKeyCheckedAt),
    });
    // A claimed row belongs to its owner or the stuck-claim sweep; not terminal_failure.
    return { kind: terminalized ? "terminal_failure" : "skipped" };
  }
  // Reconcile before retrying: no tx_hash AND (attempted OR a broadcast started but never
  // resolved). Not gated on status, since `retryAttemptNow()` resets rows to `queued`.
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
        const handedOff = kind.lifecycle.markReconciledSubmitted(config.db, {
          attempt_id: attempt.attempt_id,
          tx_hash: recovered.txHash,
          next_attempt_at: isoFromMs(
            config.now().getTime() + config.retryMaxMs,
          ),
          updated_at: nowIso(config.now()),
        });
        if (!handedOff) {
          // Another worker claimed the row during the RPC read. Journal the hash so its
          // preBroadcast hands the row to confirmation instead of sending a duplicate.
          kind.lifecycle.journalLateTxHash(config.db, {
          attempt_id: attempt.attempt_id,
          tx_hash: recovered.txHash,
          updated_at: nowIso(config.now()),
          });
          return { kind: "skipped" };
        }
        return { kind: "reconciled" };
      }
    } catch (err) {
      // Retryable, WITHOUT incrementing attempt_count: nothing was broadcast this tick.
      kind.lifecycle.markReconciliationFailure(config.db, {
        attempt_id: attempt.attempt_id,
        last_error: `Reconciliation failed: ${redactedErrorText(err)}`,
        next_attempt_at: nextRetryAt(config, attempt.attempt_count + 1),
        updated_at: nowIso(config.now()),
      });
      return { kind: "reconciliation_failure" };
    }
  }
  if (attempt.attempt_count >= config.maxAttempts) {
    const terminalized = kind.lifecycle.markTerminalFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error: kind.terminal.maxAttemptsExceeded(config.maxAttempts),
      updated_at: nowIso(config.now()),
    });
    // A claimed row belongs to its owner or the stuck-claim sweep; not terminal_failure.
    return { kind: terminalized ? "terminal_failure" : "skipped" };
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
    // Re-check halt state INSIDE the serialized broadcast slot; the checks above
    // ran before the queue wait and may be stale.
    const preBroadcast = () => {
      // A hash appeared since this attempt was read (an earlier worker's late write).
      // Not a halt: the tx exists and must be confirmed, not terminalized.
      // Must run before the auth checks, same as the top-of-function check.
      const current = kind.lifecycle.byId(config.db, attempt.attempt_id);
      if (current?.tx_hash && !attempt.tx_hash) {
        throw new GatewayLateTxHashError(current.tx_hash);
      }
      const checkedAt = config.now();
      if (
        attempt.runtime_key_id &&
        !isRuntimeKeyActive(config.db, {
          runtime_key_id: attempt.runtime_key_id,
          checkedAt,
        })
      ) {
        throw new GatewayBroadcastHaltedError(kind.terminal.runtimeKeyRevoked);
      }
      if (agentCredentialsDisabledAt(config.db, attempt.account_id)) {
        throw new GatewayBroadcastHaltedError(
          "account kill switch engaged before broadcast",
        );
      }
      // Market-level halt: else an on-chain call lands that DB acceptance then rejects.
      const marketId = kind.marketId?.(attempt);
      if (marketId && marketsRepo.isOperatorHalted(config.db, marketId)) {
        throw new GatewayBroadcastHaltedError(
          `market ${marketId} halted by operator before broadcast`,
        );
      }
    };
    const { value: txHash, latencyMs } = await measure(
      () => config.now().getTime(),
      () => withTimeout(
        config.client.writeContract(write, { preBroadcast }),
        config.broadcastTimeoutMs,
        write.functionName,
        config.timers,
      ),
    );
    const recorded = kind.lifecycle.markSubmitted(config.db, {
      attempt_id: attempt.attempt_id,
      tx_hash: txHash.toLowerCase(),
      next_attempt_at: isoFromMs(config.now().getTime() + config.retryMaxMs),
      updated_at: nowIso(config.now()),
      broadcast_started_at: broadcastStartedAt,
      broadcast_latency_ms: latencyMs,
      claim_token: claimToken,
    });
    if (!recorded) {
      // The tx WAS sent but the token-guarded write matched no row. Journal the
      // hash and touch nothing else: this worker may no longer own the row.
      kind.lifecycle.journalLateTxHash(config.db, {
        attempt_id: attempt.attempt_id,
        tx_hash: txHash.toLowerCase(),
        updated_at: nowIso(config.now()),
      });
      // Still holding the claim means the first-wins hash guard refused us (an earlier
      // hash is recorded); adopt it so the row reaches confirmation.
      const adopted = kind.lifecycle.adoptJournalledTxHash(config.db, {
        attempt_id: attempt.attempt_id,
        claim_token: claimToken,
        next_attempt_at: isoFromMs(config.now().getTime() + config.retryMaxMs),
        updated_at: nowIso(config.now()),
      });
      // Not adopted ⇒ we genuinely lost the claim; the new owner drives it.
      return { kind: adopted ? "reconciled" : "skipped" };
    }
    return { kind: "submitted" };
  } catch (err) {
    if (err instanceof GatewayLateTxHashError) {
      // Adopt the recorded hash for confirmation; markSubmitted's refusal to overwrite keeps this race-safe.
      kind.lifecycle.adoptJournalledTxHash(config.db, {
        attempt_id: attempt.attempt_id,
        claim_token: claimToken,
        next_attempt_at: isoFromMs(config.now().getTime() + config.retryMaxMs),
        updated_at: nowIso(config.now()),
      });
      return { kind: "reconciled" };
    }
    if (err instanceof GatewayBroadcastHaltedError) {
      // Halted inside the slot; no tx sent. Terminal: the halt is durable.
      // Release our claim by token CAS so another worker's claim isn't clobbered.
      kind.lifecycle.markTerminalFailure(config.db, {
        attempt_id: attempt.attempt_id,
        last_error: err.message,
        updated_at: nowIso(config.now()),
        expect_claim_token: claimToken,
      });
      return { kind: "terminal_failure" };
    }
    kind.lifecycle.markRetryableFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error: redactedErrorText(err),
      next_attempt_at: nextRetryAt(config, attempt.attempt_count + 1),
      updated_at: nowIso(config.now()),
      broadcast_started_at: broadcastStartedAt,
      broadcast_latency_ms: null,
      claim_token: claimToken,
    });
    return { kind: "retryable_failure" };
  }
}

/** A tx hash was journalled while queued (an earlier worker's late write); the row goes to confirmation. */
export class GatewayLateTxHashError extends Error {
  constructor(readonly txHash: string) {
    super(
      `a transaction hash was recorded for this attempt while it was queued ` +
        `(${txHash}); refusing to broadcast a duplicate`,
    );
    this.name = "GatewayLateTxHashError";
  }
}

/** Thrown by preBroadcast on halt state inside the slot; mapped to a terminal failure. */
export class GatewayBroadcastHaltedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayBroadcastHaltedError";
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
      last_rpc_error: redactedErrorText(err),
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
      last_rpc_error: redactedErrorText(err),
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
      // Post-broadcast: row is `submitted` with no claim; the pre-claim CAS would never match.
      expect_status: "submitted" as const,
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
