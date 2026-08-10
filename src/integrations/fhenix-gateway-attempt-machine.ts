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
  /**
   * The market this attempt writes against, when the lane has one. Used for
   * the last-moment operator-halt check inside the broadcast slot; a lane that
   * is not market-scoped omits it.
   */
  marketId?(attempt: Row): string | null;
  /**
   * The deployment this attempt was RESERVED against. Compared with the
   * daemon's current one so a redeploy — or a chain switch to an identical
   * address — cannot silently relay old intents onto it.
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
  /**
   * Block height for recovering a write made against a PREVIOUS deployment on
   * the same chain (FHENIX_RECONCILE_OLD_FROM_BLOCK). Absent means no such
   * recovery is attempted, and the terminal error says so rather than
   * reporting "nothing landed" — a claim the daemon has no basis to make.
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
  // A broadcastable row that ALREADY carries a tx_hash has a transaction out
  // there — from an earlier worker whose write landed after losing its claim.
  // Promote it to `submitted` instead of writing again.
  //
  // This is the general case; the late-journal and first-wins paths below are
  // only particular ways the hash arrives.
  //
  // FIRST, before every authorization and halt check. Those decide whether to
  // BROADCAST, and this row is not going to: its transaction already exists
  // and only needs confirming. A key revoked, or a kill switch engaged, in the
  // window after the write landed does not un-send it — terminalizing here
  // dropped the row out of confirmation (which scans `submitted`) and stranded
  // a real transaction. Without it, the next tick
  // re-broadcasts, viem's gas estimate reverts with CallAlreadyExists /
  // PacketAlreadyExists before any hash comes back, and the generic catch
  // marks the row retryable — forever, while the landed transaction is never
  // confirmed.
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
    // A claimed row belongs to its owner (or to the stuck-claim sweep);
    // reporting terminal_failure for it would be a lie.
    return { kind: terminalized ? "terminal_failure" : "skipped" };
  }
  // The kill switch revokes every key in the same transaction, so the check
  // above already fells most queued attempts — this account-level gate closes
  // the remainder (rows whose runtime_key_id went NULL, and the window
  // between an engage commit and a claim that read the key just before).
  if (agentCredentialsDisabledAt(config.db, attempt.account_id)) {
    const terminalized = kind.lifecycle.markTerminalFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error: "account kill switch engaged before broadcast",
      updated_at: nowIso(runtimeKeyCheckedAt),
    });
    // A claimed row belongs to its owner (or to the stuck-claim sweep);
    // reporting terminal_failure for it would be a lie.
    return { kind: terminalized ? "terminal_failure" : "skipped" };
  }
  // FAIL CLOSED on a deployment change. The row records the contract it was
  // reserved against; the tick supplies the CURRENTLY configured one. After a
  // redeploy + sync-deployments those differ, and every step below silently
  // uses the new address: reconciliation looks for the id on the wrong
  // contract, the broadcast relays an intent the agent formed against the old
  // one, and receipt decoding then fails because event extraction still keys
  // on the row's original address. The result is a stranded row and a wasted
  // on-chain write.
  //
  // Terminal, not retryable: no future tick makes an old-deployment intent
  // valid again. The operator drains or replays these deliberately.
  //
  // Compares (chain_id, contract_address), not the address alone: the same
  // address can exist on another chain, and repointing the daemon there would
  // otherwise relay an old-chain intent onto it.
  const rowDeployment = kind.deploymentOf?.(attempt);
  if (
    rowDeployment &&
    (rowDeployment.chainId !== config.chainId ||
      rowDeployment.contractAddress.toLowerCase() !==
        config.contractAddress.toLowerCase())
  ) {
    // Reconcile FIRST when a write could plausibly have landed. A row with no
    // tx_hash that has been attempted may have a transaction on the OLD
    // deployment whose receipt was lost; terminalizing it without looking
    // leaves that write permanently unrecorded and unrecoverable, because no
    // later tick will ever read the old contract again.
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
            // NOT the manifest's reconcileFromBlock — that belongs to the
            // NEW contract and is later than any old-contract write, so a
            // search from it can never find one. Genesis is not the answer
            // either: most public RPCs reject a full-range getLogs, and the
            // rejection used to be swallowed and reported as "nothing landed".
            // FHENIX_RECONCILE_OLD_FROM_BLOCK lets an operator state the old
            // deployment's block; without it the lookup is not attempted and
            // says so.
            reconcileFromBlock: config.reconcileOldFromBlock ?? 0,
          },
          attempt,
        );
        if (recovered) {
          // The write DID land on the old deployment. Persist it and stop —
          // the result used to be discarded and the row terminalized anyway,
          // which lost a real transaction permanently.
          const handedOff = kind.lifecycle.markReconciledSubmitted(config.db, {
            attempt_id: attempt.attempt_id,
            tx_hash: recovered.txHash,
            next_attempt_at: isoFromMs(
              config.now().getTime() + config.retryMaxMs,
            ),
            updated_at: nowIso(config.now()),
          });
          if (!handedOff) {
            // Another worker claimed this row during the awaited RPC read, so the
            // claim-guarded write correctly did nothing. The recovered hash still
            // has to reach it — journalling makes the claimant's preBroadcast see
            // it and hand the row to confirmation instead of sending a duplicate.
            // Reporting "reconciled" here would have been a lie.
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
        // A failed recovery read must not mask the mismatch below, but it must
        // not be reported as "nothing landed" either — the two are different
        // facts and only one of them is safe to act on.
        lookupFailed = true;
      }
    }
    // Cross-CHAIN rows are not recovered here at all, and say so. `config.client`
    // is bound to one RPC — passing a different chainId does not switch
    // networks — so a recovery read would silently query the wrong chain and
    // report "nothing landed" for a transaction that exists. Naming it is
    // honest; guessing is not.
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
    // A claimed row belongs to its owner (or to the stuck-claim sweep);
    // reporting terminal_failure for it would be a lie.
    return { kind: terminalized ? "terminal_failure" : "skipped" };
  }
  // Re-validate lane-specific policy that may have narrowed since reservation.
  // The feed lane's reveal-policy guard runs at reservation, so attempts
  // already queued when it landed were never checked: a legacy manual /
  // fixed_delay / after_horizon feed could still broadcast and then be
  // revealed on the market clock, contradicting the policy it publicly
  // advertises. Terminal — no later tick makes that intent honourable.
  const policyError = kind.revalidate?.(config.db, attempt);
  if (policyError) {
    const terminalized = kind.lifecycle.markTerminalFailure(config.db, {
      attempt_id: attempt.attempt_id,
      last_error: policyError,
      updated_at: nowIso(runtimeKeyCheckedAt),
    });
    // A claimed row belongs to its owner (or to the stuck-claim sweep);
    // reporting terminal_failure for it would be a lie.
    return { kind: terminalized ? "terminal_failure" : "skipped" };
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
        const handedOff = kind.lifecycle.markReconciledSubmitted(config.db, {
          attempt_id: attempt.attempt_id,
          tx_hash: recovered.txHash,
          next_attempt_at: isoFromMs(
            config.now().getTime() + config.retryMaxMs,
          ),
          updated_at: nowIso(config.now()),
        });
        if (!handedOff) {
          // Another worker claimed this row during the awaited RPC read, so the
          // claim-guarded write correctly did nothing. The recovered hash still
          // has to reach it — journalling makes the claimant's preBroadcast see
          // it and hand the row to confirmation instead of sending a duplicate.
          // Reporting "reconciled" here would have been a lie.
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
      // Reconciliation failure (e.g. RPC dropped). Surface as a clear
      // retryable error WITHOUT incrementing attempt_count — the row
      // still hasn't been broadcast in this tick.
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
    // A claimed row belongs to its owner (or to the stuck-claim sweep);
    // reporting terminal_failure for it would be a lie.
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
    // Re-check halt state INSIDE the serialized broadcast slot: a kill switch
    // engaged (or key revoked) while this write waited behind earlier queue
    // work must still stop it — the checks at the top of this function ran
    // before the queue wait and can be stale by the time the slot opens.
    const preBroadcast = () => {
      // A hash appeared since this attempt was read — an earlier worker's
      // write landed late and journalled it. Broadcasting now would send a
      // duplicate the contract rejects, and markSubmitted would overwrite the
      // real hash with the failing one, stranding the write that succeeded.
      //
      // NOT a halt. A halt means "nothing was sent, stop for good"; here a
      // transaction exists and must be CONFIRMED. Throwing GatewayBroadcastHalted
      // sent the row to failed_terminal, and confirmation only scans
      // `submitted` rows — so the landed write was recorded and then never
      // looked at again.
      //
      // FIRST inside the slot, for the same reason the top-of-function check
      // comes before the auth checks: a key revoked or a kill switch engaged
      // during the queue wait does not un-send a transaction that already
      // landed. Checking those first terminalized the row and stranded it.
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
      // Market-level halt, same reasoning as the two above. A submission
      // queued while the market was listed could still be broadcast after an
      // operator pulled it: the DB acceptance check then rejects the call,
      // leaving an on-chain call with nothing behind it and gas spent.
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
      // The transaction WAS sent, but the token-guarded write matched no row:
      // something else moved this attempt while we were broadcasting. The
      // boolean used to be discarded and "submitted" returned anyway, so a
      // real on-chain write vanished from the database silently.
      //
      // Journal the hash and touch NOTHING else. It is the one piece of state
      // that must not be lost, but this worker no longer owns the row —
      // markReconciledSubmitted would have cleared whatever claim the new
      // owner holds.
      kind.lifecycle.journalLateTxHash(config.db, {
        attempt_id: attempt.attempt_id,
        tx_hash: txHash.toLowerCase(),
        updated_at: nowIso(config.now()),
      });
      // If we STILL hold the claim, the refusal was the first-wins hash guard,
      // not a lost claim: an earlier worker's hash is already recorded and
      // this attempt sent a duplicate. Adopt the recorded hash so the row
      // reaches confirmation.
      //
      // Returning `skipped` here left it `queued` with our claim held, so
      // confirmation (which scans `submitted`) never saw it and, once the
      // claim was swept, it rebroadcast duplicates instead of confirming the
      // transaction that landed.
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
      // Hand the row to the confirmation loop. The hash is ALREADY recorded —
      // adopt it rather than rewriting it, because markSubmitted deliberately
      // refuses to overwrite an existing hash and that refusal is what makes
      // this handoff race-safe.
      kind.lifecycle.adoptJournalledTxHash(config.db, {
        attempt_id: attempt.attempt_id,
        claim_token: claimToken,
        next_attempt_at: isoFromMs(config.now().getTime() + config.retryMaxMs),
        updated_at: nowIso(config.now()),
      });
      return { kind: "reconciled" };
    }
    if (err instanceof GatewayBroadcastHaltedError) {
      // Halted at the last moment inside the broadcast slot — no tx was
      // sent. Terminal, not retryable: the halt condition is durable.
      //
      // This caller OWNS the claim, so it releases it: the token makes that a
      // compare-and-set, which is what stops it from clobbering a different
      // worker's in-flight claim.
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

/** Thrown by the preBroadcast seam when halt state is detected inside the
 *  serialized broadcast slot; the attempt machine maps it to a terminal
 *  failure instead of a retryable one. */
/**
 * A transaction hash was journalled for this attempt while it sat queued — an
 * earlier worker's write landed after losing its claim. Distinct from a halt:
 * a real transaction exists, so the row must reach CONFIRMATION, not terminal
 * failure.
 */
export class GatewayLateTxHashError extends Error {
  constructor(readonly txHash: string) {
    super(
      `a transaction hash was recorded for this attempt while it was queued ` +
        `(${txHash}); refusing to broadcast a duplicate`,
    );
    this.name = "GatewayLateTxHashError";
  }
}

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
      // POST-broadcast: the row is `submitted` and holds no claim. Without
      // this the pre-claim CAS matched nothing, so a reverted transaction was
      // re-fetched on every tick forever and kept consuming in-flight quota.
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
