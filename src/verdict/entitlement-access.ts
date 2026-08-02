import type Database from "better-sqlite3";

import type {
  GrantChainAdapter,
  GrantDecryptAccessView,
} from "../integrations/fhenix-grant-env.js";
import {
  entitlementsRepo,
  type EntitlementRow,
} from "./repos/entitlements-repo.js";

// Flow 2 v1 orchestrator: the durable payment→reserve→settle→grant→confirm state
// machine for paid private decrypt-grant. Kept free of Express/x402 wiring so it
// is unit-testable with injected fakes (no live chain). The HTTP glue lives in
// entitlement-access-surface.ts; the stuck-row recovery in
// src/integrations/fhenix-grant-reconciler.ts reuses reconcileEntitlement here.
//
// On-chain CallState mirror.
const STATE_SEALED = 1;

export interface EntitlementSettlement {
  /**
   * Settle the already-verified payment. Called AFTER the unique reservation
   * exists, so a crash between reserve and settle leaves a row to reconcile.
   */
  settle(): Promise<SettleOutcome>;
}

export type SettleOutcome =
  | {
      kind: "settled";
      transaction: string;
      payer: string;
      amount: string;
      currency: string;
    }
  // Definitive pre-settlement rejection — no money moved, the reservation is
  // released so a fresh nonce can retry.
  | { kind: "rejected"; reason: string }
  // Transport/uncertain after the settle attempt — money may have moved, so the
  // row stays for authoritative reconciliation (settlement_unknown).
  | { kind: "unknown"; reason: string };

export interface EntitlementAccessDeps {
  readonly db: Database.Database;
  readonly grantChain: GrantChainAdapter;
  /** Seconds of margin before revealOpenAt when sales close (Codex §6). */
  readonly salesSafetySeconds: number;
  /** Wall clock; epoch seconds derived for the on-chain window comparison. */
  readonly now: () => Date;
  /** Optional producer lookup for later accounting (no v1 revenue split). */
  readonly resolveProducerAgentId?: (onchainCallId: string) => string | null;
  /**
   * Block-depth required before a grant is marked terminally `granted`
   * (Codex §6 step 6). Default 1.
   */
  readonly grantConfirmations?: number;
  /**
   * Max grant broadcasts before a settled-but-ungrantable row is owed a refund.
   * Bounds the reconciler's re-broadcast of a dropped grant tx so a genuinely
   * stuck grant heals to refund_due instead of retrying forever. Default 5.
   */
  readonly maxGrantAttempts?: number;
  /**
   * Grace (seconds) an unmined grant_broadcast tx is given before the reconciler
   * presumes it dropped and re-broadcasts; also paces settlement_unknown
   * resolution. Default 30.
   */
  readonly grantRebroadcastDelaySeconds?: number;
  /**
   * Reconcile attempts an ambiguous settlement_unknown row survives before it is
   * conservatively marked refund_due (never stranded silently). Default 8.
   */
  readonly settlementUnknownMaxAttempts?: number;
}

const DEFAULT_GRANT_CONFIRMATIONS = 1;
const DEFAULT_MAX_GRANT_ATTEMPTS = 5;
const DEFAULT_REBROADCAST_DELAY_SEC = 30;
const DEFAULT_CONFIRM_POLL_DELAY_SEC = 15;
const DEFAULT_SETTLEMENT_UNKNOWN_MAX_ATTEMPTS = 8;

export type EligibilityReason =
  | "ok"
  | "call_not_found"
  | "not_sealed"
  | "sale_window_closed";

export interface EntitlementEligibility {
  reason: EligibilityReason;
  view: GrantDecryptAccessView | null;
}

/**
 * On-chain eligibility check, run BEFORE returning the 402 challenge and again
 * immediately before settlement (Codex §6). The contract re-enforces the window
 * at grant time — this is the early, no-charge gate.
 */
export async function checkEntitlementEligibility(
  deps: EntitlementAccessDeps,
  onchainCallId: string,
): Promise<EntitlementEligibility> {
  const view = await deps.grantChain.readDecryptAccess(
    onchainCallId,
    // The subscriber does not affect state/window; use a throwaway zero-ish
    // read address. alreadyGranted for the real subscriber is re-read later.
    ZERO_ADDRESS,
  );
  if (!view || view.state === 0) return { reason: "call_not_found", view: null };
  if (view.state !== STATE_SEALED) return { reason: "not_sealed", view };
  const nowSec = Math.floor(deps.now().getTime() / 1000);
  const salesCloseAt = view.revealOpenAt - deps.salesSafetySeconds;
  if (nowSec >= salesCloseAt) return { reason: "sale_window_closed", view };
  return { reason: "ok", view };
}

export type PurchaseResult =
  | { kind: "granted"; row: EntitlementRow }
  | { kind: "processing"; row: EntitlementRow }
  | { kind: "refund_due"; row: EntitlementRow }
  | { kind: "already_owned"; row: EntitlementRow }
  | {
      kind: "error";
      status: number;
      body: { error: string; message?: string };
    };

export interface PurchaseInput {
  readonly onchainCallId: string;
  /** Subscriber = the VERIFIED payer wallet, never a JSON-supplied address. */
  readonly verifiedPayer: string;
  readonly settlement: EntitlementSettlement;
}

/**
 * Codex §3 ordering: (1) validate call + window (done by the caller before 402,
 * re-checked here), (2) reserve unique entitlement, (3) persist intent, (4)
 * settle, (5) queue + broadcast grant, (6) wait confirmations, (7) mark granted.
 * A grant that cannot be broadcast/confirmed AFTER settlement becomes
 * refund_due — a settled payment is never relabeled a plain failure.
 */
export async function purchaseEntitlementAccess(
  deps: EntitlementAccessDeps,
  input: PurchaseInput,
): Promise<PurchaseResult> {
  const key = {
    chainId: deps.grantChain.chainId,
    contractAddress: deps.grantChain.contractAddress,
    onchainCallId: input.onchainCallId,
    subscriberAddress: input.verifiedPayer,
  };

  // (1) Re-validate eligibility immediately before charging.
  const eligibility = await checkEntitlementEligibility(deps, input.onchainCallId);
  if (eligibility.reason !== "ok") {
    return eligibilityError(eligibility.reason);
  }

  // (2) Reserve the unique entitlement BEFORE settlement. A racing identical
  // reservation throws SQLITE_CONSTRAINT_UNIQUE — resolve to the existing row.
  const nowIso = deps.now().toISOString();
  let id: number;
  try {
    id = entitlementsRepo.reserve(deps.db, {
      ...key,
      callId: null,
      producerAgentId: deps.resolveProducerAgentId?.(input.onchainCallId) ?? null,
      amount: null,
      currency: null,
      now: nowIso,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = entitlementsRepo.byReservation(deps.db, key);
    if (!existing) {
      return { kind: "error", status: 500, body: { error: "InternalStateInconsistent" } };
    }
    return classifyExisting(existing);
  }

  // (3)+(4) Persist intent implicitly (the reservation row) and settle.
  let outcome: SettleOutcome;
  try {
    outcome = await input.settlement.settle();
  } catch (err) {
    // An exception mid-settle is uncertain: leave the row for the reconciler.
    entitlementsRepo.transition(deps.db, id, ["payment_settling"], {
      status: "settlement_unknown",
      lastError: messageFrom(err),
      nextAttemptAt: nowIso,
      now: nowIso,
    });
    return pendingRow(deps.db, id);
  }

  if (outcome.kind === "rejected") {
    // No money moved — release the reservation so a fresh nonce can retry.
    entitlementsRepo.releaseReservation(deps.db, id);
    return {
      kind: "error",
      status: 402,
      body: { error: "PaymentSettlementFailed", message: outcome.reason },
    };
  }
  if (outcome.kind === "unknown") {
    entitlementsRepo.transition(deps.db, id, ["payment_settling"], {
      status: "settlement_unknown",
      lastError: outcome.reason,
      nextAttemptAt: nowIso,
      now: nowIso,
    });
    return pendingRow(deps.db, id);
  }

  // Settled: record the receipt + amount and move to grant_queued.
  entitlementsRepo.transition(deps.db, id, ["payment_settling"], {
    status: "grant_queued",
    nanopayReceiptId: outcome.transaction,
    amount: outcome.amount,
    currency: outcome.currency,
    nextAttemptAt: nowIso,
    now: nowIso,
  });

  // (5)+(6)+(7) Broadcast the grant and try to confirm inline; the reconciler
  // finishes any row left in grant_queued / grant_broadcast.
  let row = entitlementsRepo.byId(deps.db, id);
  if (!row) return { kind: "error", status: 500, body: { error: "InternalStateInconsistent" } };
  // Drive the durable steps inline (grant_queued → grant_broadcast → granted)
  // until the row stops advancing; a still-pending receipt leaves it for the
  // reconciler. Bounded so a stuck adapter can never spin the request.
  for (let step = 0; step < 3; step += 1) {
    const next = await reconcileEntitlement(deps, row);
    if (next.status === row.status) break;
    row = next;
    if (next.status === "granted" || next.status === "grant_failed_refund_due") break;
  }
  return finalResult(row);
}

/**
 * Advance a single non-terminal entitlement one durable step. Shared by the
 * synchronous route (fast-path confirm) and the background reconciler. Never
 * relabels a settled payment as a plain failure — grant trouble ends in
 * refund_due.
 */
export async function reconcileEntitlement(
  deps: EntitlementAccessDeps,
  row: EntitlementRow,
): Promise<EntitlementRow> {
  const nowIso = deps.now().toISOString();
  const id = row.id;
  const maxAttempts = deps.maxGrantAttempts ?? DEFAULT_MAX_GRANT_ATTEMPTS;
  const rebroadcastDelay = deps.grantRebroadcastDelaySeconds ?? DEFAULT_REBROADCAST_DELAY_SEC;
  const requiredConfirmations = deps.grantConfirmations ?? DEFAULT_GRANT_CONFIRMATIONS;

  if (row.status === "grant_queued") {
    // Broadcast (or re-broadcast) the grant.
    try {
      const txHash = await deps.grantChain.sendGrant(
        row.onchain_call_id,
        row.subscriber_address,
      );
      entitlementsRepo.transition(deps.db, id, ["grant_queued"], {
        status: "grant_broadcast",
        grantTxHash: txHash,
        incrementAttempts: true,
        lastError: null,
        // Grace before the tx is presumed dropped and re-broadcast (Codex ii:
        // a dropped grant tx must heal without operator intervention).
        nextAttemptAt: addSeconds(nowIso, rebroadcastDelay),
        now: nowIso,
      });
    } catch (err) {
      // A revert (e.g. DecryptGrantWindowClosed) means this tx can never land.
      // Before refunding, re-read on-chain access for the REAL subscriber: a
      // crash-restart can re-broadcast a grant whose earlier tx already landed,
      // and the contract checks the window BEFORE its idempotent early-return,
      // so the retry reverts even though the subscriber already holds access.
      // Refunding that subscriber would pay them AND hand them the product.
      if (isGrantWindowClosed(err)) {
        return finalizeGrantFailure(deps, row, id, nowIso, messageFrom(err));
      }
      // Transient RPC failure: retry with backoff, bounded by maxAttempts so a
      // permanently failing broadcast still resolves (granted-or-refund) rather
      // than retrying forever.
      if (row.grant_attempts + 1 >= maxAttempts) {
        return finalizeGrantFailure(deps, row, id, nowIso, messageFrom(err));
      }
      entitlementsRepo.transition(deps.db, id, ["grant_queued"], {
        status: "grant_queued",
        incrementAttempts: true,
        lastError: messageFrom(err),
        nextAttemptAt: addSeconds(nowIso, rebroadcastDelay),
        now: nowIso,
      });
      return entitlementsRepo.byId(deps.db, id) ?? row;
    }
    return entitlementsRepo.byId(deps.db, id) ?? row;
  }

  if (row.status === "grant_broadcast" && row.grant_tx_hash) {
    const receipt = await deps.grantChain.getReceipt(row.grant_tx_hash);
    if (receipt) {
      if (!receipt.success) {
        // Reverted on-chain (window closed between broadcast and mining, etc.).
        // Same crash-restart caveat as above: confirm the subscriber does not
        // already hold access before refunding.
        return finalizeGrantFailure(
          deps,
          row,
          id,
          nowIso,
          "grant transaction reverted on-chain",
        );
      }
      if (receipt.confirmations < requiredConfirmations) {
        // Mined but not deep enough yet — revisit soon (Codex §6 step 6). A
        // shallow-reorg before this depth must not have been marked granted.
        entitlementsRepo.transition(deps.db, id, ["grant_broadcast"], {
          status: "grant_broadcast",
          lastError: null,
          nextAttemptAt: addSeconds(nowIso, DEFAULT_CONFIRM_POLL_DELAY_SEC),
          now: nowIso,
        });
        return entitlementsRepo.byId(deps.db, id) ?? row;
      }
      entitlementsRepo.transition(deps.db, id, ["grant_broadcast"], {
        status: "granted",
        grantBlockNumber: receipt.blockNumber,
        grantedAt: nowIso,
        lastError: null,
        nextAttemptAt: null,
        now: nowIso,
      });
      return entitlementsRepo.byId(deps.db, id) ?? row;
    }

    // Receipt is null: the tx is either still pending or was dropped/evicted.
    // Within the grace window, just revisit later (also keeps the synchronous
    // purchase path from re-broadcasting a fresh, still-propagating tx).
    if (row.next_attempt_at && nowIso < row.next_attempt_at) return row;

    // Grace elapsed and still unmined. The on-chain grant map is the source of
    // truth: an earlier broadcast (or a concurrent grantor) may already have
    // landed the grant even though THIS tx hash never mined.
    if (await bestEffortAlreadyGranted(deps, row)) {
      entitlementsRepo.transition(deps.db, id, ["grant_broadcast"], {
        status: "granted",
        grantedAt: nowIso,
        lastError: null,
        nextAttemptAt: null,
        now: nowIso,
      });
      return entitlementsRepo.byId(deps.db, id) ?? row;
    }
    if (row.grant_attempts >= maxAttempts) {
      // Exhausted re-broadcasts on a dropped tx — the settled payment is owed a
      // refund (P0: never leave a settled payment stranded in grant_broadcast).
      entitlementsRepo.transition(deps.db, id, ["grant_broadcast"], {
        status: "grant_failed_refund_due",
        refundStatus: "refund_due",
        lastError: "grant tx unmined after max attempts (presumed dropped)",
        nextAttemptAt: nowIso,
        now: nowIso,
      });
      return entitlementsRepo.byId(deps.db, id) ?? row;
    }
    // Presumed dropped — re-queue for a fresh broadcast (the grantor adapter
    // resets its nonce so the reclaimed nonce re-sends rather than stranding).
    entitlementsRepo.transition(deps.db, id, ["grant_broadcast"], {
      status: "grant_queued",
      lastError: "grant tx unmined within grace; re-broadcasting",
      nextAttemptAt: nowIso,
      now: nowIso,
    });
    return entitlementsRepo.byId(deps.db, id) ?? row;
  }

  if (row.status === "settlement_unknown") {
    // A settlement whose outcome is unknown (transport-uncertain settle, or a
    // crash between reserve and settle) cannot be safely granted — that would
    // hand out access for a payment that may never have cleared. We also must
    // not strand it: after a bounded number of resolution attempts, mark it
    // refund_due so the operator/refund path always sees it. A never-settled
    // row refunds to a no-op; a settled one is made whole. (Never relabeled a
    // plain failure — settled-but-lost always ends refund_due.)
    const maxUnknown =
      deps.settlementUnknownMaxAttempts ?? DEFAULT_SETTLEMENT_UNKNOWN_MAX_ATTEMPTS;
    if (row.grant_attempts >= maxUnknown) {
      entitlementsRepo.transition(deps.db, id, ["settlement_unknown"], {
        status: "grant_failed_refund_due",
        refundStatus: "refund_due",
        lastError: "settlement remained unknown after resolution budget; refund owed",
        nextAttemptAt: nowIso,
        now: nowIso,
      });
      return entitlementsRepo.byId(deps.db, id) ?? row;
    }
    entitlementsRepo.transition(deps.db, id, ["settlement_unknown"], {
      status: "settlement_unknown",
      incrementAttempts: true,
      lastError: row.last_error,
      nextAttemptAt: addSeconds(nowIso, rebroadcastDelay),
      now: nowIso,
    });
    return entitlementsRepo.byId(deps.db, id) ?? row;
  }

  return row;
}

/**
 * Terminal resolution of a grant that could not be broadcast/mined (window-closed
 * revert or on-chain revert). Reads the REAL subscriber's on-chain access first:
 * if an earlier tx already granted them (crash-restart double-broadcast), mark
 * granted — never refund a subscriber who already holds the product. Otherwise a
 * settled payment is owed a refund. A read failure does NOT terminalize to
 * refund (it would risk a false refund of a granted subscriber); the row is left
 * for a later attempt, ultimately bounded by maxGrantAttempts.
 */
async function finalizeGrantFailure(
  deps: EntitlementAccessDeps,
  row: EntitlementRow,
  id: number,
  nowIso: string,
  errText: string,
): Promise<EntitlementRow> {
  let alreadyGranted: boolean | null;
  try {
    const view = await deps.grantChain.readDecryptAccess(
      row.onchain_call_id,
      row.subscriber_address,
    );
    alreadyGranted = view ? view.alreadyGranted : false;
  } catch {
    alreadyGranted = null; // read failed — cannot confirm either way
  }

  if (alreadyGranted === true) {
    entitlementsRepo.transition(deps.db, id, [row.status], {
      status: "granted",
      grantedAt: nowIso,
      lastError: null,
      nextAttemptAt: null,
      now: nowIso,
    });
    return entitlementsRepo.byId(deps.db, id) ?? row;
  }

  if (alreadyGranted === null) {
    // Could not read on-chain state — retry later rather than risk a false
    // refund. Bounded: once broadcasts are exhausted, refund conservatively.
    const maxAttempts = deps.maxGrantAttempts ?? DEFAULT_MAX_GRANT_ATTEMPTS;
    const rebroadcastDelay =
      deps.grantRebroadcastDelaySeconds ?? DEFAULT_REBROADCAST_DELAY_SEC;
    if (row.grant_attempts < maxAttempts) {
      entitlementsRepo.transition(deps.db, id, [row.status], {
        status: "grant_queued",
        incrementAttempts: true,
        lastError: `${errText} | access read failed; will retry`,
        nextAttemptAt: addSeconds(nowIso, rebroadcastDelay),
        now: nowIso,
      });
      return entitlementsRepo.byId(deps.db, id) ?? row;
    }
  }

  entitlementsRepo.transition(deps.db, id, [row.status], {
    status: "grant_failed_refund_due",
    refundStatus: "refund_due",
    lastError: errText,
    nextAttemptAt: nowIso,
    now: nowIso,
  });
  return entitlementsRepo.byId(deps.db, id) ?? row;
}

async function bestEffortAlreadyGranted(
  deps: EntitlementAccessDeps,
  row: EntitlementRow,
): Promise<boolean> {
  try {
    const view = await deps.grantChain.readDecryptAccess(
      row.onchain_call_id,
      row.subscriber_address,
    );
    return view ? view.alreadyGranted : false;
  } catch {
    return false;
  }
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function classifyExisting(row: EntitlementRow): PurchaseResult {
  switch (row.status) {
    case "granted":
      return { kind: "already_owned", row };
    case "grant_failed_refund_due":
    case "refunded":
      return { kind: "refund_due", row };
    default:
      return { kind: "processing", row };
  }
}

function finalResult(row: EntitlementRow): PurchaseResult {
  switch (row.status) {
    case "granted":
      return { kind: "granted", row };
    case "grant_failed_refund_due":
    case "refunded":
      return { kind: "refund_due", row };
    default:
      return { kind: "processing", row };
  }
}

function pendingRow(db: Database.Database, id: number): PurchaseResult {
  const row = entitlementsRepo.byId(db, id);
  if (!row) return { kind: "error", status: 500, body: { error: "InternalStateInconsistent" } };
  return { kind: "processing", row };
}

function eligibilityError(reason: EligibilityReason): PurchaseResult {
  if (reason === "call_not_found") {
    return { kind: "error", status: 404, body: { error: "CallNotFound" } };
  }
  if (reason === "not_sealed") {
    return {
      kind: "error",
      status: 409,
      body: { error: "CallNotSealed", message: "call is no longer sealed" },
    };
  }
  return {
    kind: "error",
    status: 409,
    body: {
      error: "SaleWindowClosed",
      message: "the private decrypt-access sale window for this call has closed",
    },
  };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function isGrantWindowClosed(err: unknown): boolean {
  return /DecryptGrantWindowClosed|CallNotFound|ZeroSubscriber|execution reverted|revert/i.test(
    messageFrom(err),
  );
}

function messageFrom(err: unknown): string {
  if (err instanceof Error) {
    const short = (err as { shortMessage?: string }).shortMessage;
    return short ? `${err.message} | ${short}` : err.message;
  }
  return String(err);
}
