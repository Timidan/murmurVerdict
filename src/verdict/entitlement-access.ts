import type Database from "better-sqlite3";

import { fhenixSealedCallsRepo } from "./repos/fhenix-sealed-calls-repo.js";
import { effectiveCohortCap } from "./repos/agent-provider-terms-repo.js";
import {
  marketClocksRepo,
  marketSeriesRepo,
} from "./repos/market-clocks-repo.js";

import type {
  GrantChainAdapter,
  GrantDecryptAccessView,
} from "../integrations/fhenix-grant-env.js";
import {
  entitlementsRepo,
  NON_TERMINAL_ENTITLEMENT_STATUSES,
  type EntitlementRow,
} from "./repos/entitlements-repo.js";
import {
  accrueIfEligible,
  grantAndAccrue,
  type ProviderEarningsDeps,
} from "./provider-earnings.js";
import { requireProtocolFeeBps } from "./protocol-fee.js";

// Flow 2 v1 orchestrator: the durable payment→reserve→settle→grant→confirm state
// machine for paid private decrypt-grant. Kept free of Express/x402 wiring so it
// is unit-testable with injected fakes (no live chain). The HTTP glue lives in
// entitlement-access-surface.ts; the stuck-row recovery in
// src/integrations/fhenix-grant-reconciler.ts reuses reconcileEntitlement here.
//
// On-chain CallState mirror.
const STATE_SEALED = 1;
/** On-chain SubmissionClass.EarlyAccess — the only sellable class. */
const SUBMISSION_CLASS_EARLY_ACCESS = 1;

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
  /** Seconds of margin before the contract's grantCloseAt when sales close. */
  readonly salesSafetySeconds: number;
  /**
   * Max armed consumers per call, from the market's series. Undefined disables
   * the check — but note that leaves the cohort unbounded, which is what the
   * cap exists to prevent.
   */
  readonly maxArmedPerCall?: number;
  /** Wall clock; epoch seconds derived for the on-chain window comparison. */
  readonly now: () => Date;
  /**
   * Resolves the agent that produced a call, for revenue attribution.
   *
   * Supply it. When it is absent every reservation records a NULL producer, and
   * accrual has to fall back to re-deriving the owner from the sealed call —
   * which works, but leaves the entitlement itself unable to say whose sale it
   * was.
   */
  readonly resolveProducerAgentId?: (onchainCallId: string) => string | null;
  /**
   * Murmur's cut, in basis points. Stamped onto a reservation only when the
   * CALL carries no snapshot of its own (a legacy row), and used as the split
   * for legacy accruals. Falls back to MURMUR_PROTOCOL_FEE_BPS when omitted.
   */
  readonly protocolFeeBps?: number;
  /** Where accrual repairs and unattributed sales are reported. */
  readonly logger?: Pick<Console, "warn">;
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

/**
 * How long a fresh reservation is left alone before the reconciler may treat
 * it as abandoned. Reuses the rebroadcast delay: both answer the same
 * question — how long to wait before presuming an in-flight operation died.
 */
function settleGraceSeconds(deps: EntitlementAccessDeps): number {
  return deps.grantRebroadcastDelaySeconds ?? DEFAULT_REBROADCAST_DELAY_SEC;
}

/** The accrual engine's view of these deps. */
function earnings(deps: EntitlementAccessDeps): ProviderEarningsDeps {
  return {
    db: deps.db,
    protocolFeeBps: deps.protocolFeeBps,
    now: deps.now,
    logger: deps.logger,
  };
}

/**
 * The split THIS sale freezes.
 *
 * From the call's own snapshot, taken when it was sealed. A call with no
 * snapshot predates migration 071 and froze nothing, so it is stamped with the
 * fee as it stands right now — that is still a decision made at the SALE, which
 * is the boundary that matters. What must never happen is reading the live fee
 * at GRANT time: a fee change between payment and grant would then re-cut a
 * purchase the subscriber had already answered a 402 for.
 *
 * Throws when no fee is configured at all. That is a startup-level
 * misconfiguration, and it surfaces here BEFORE any reservation or settlement —
 * no money has moved.
 */
function feeBpsForSale(deps: EntitlementAccessDeps, onchainCallId: string): number {
  const call = fhenixSealedCallsRepo.byOnchainCall(deps.db, {
    chain_id: deps.grantChain.chainId,
    contract_address: deps.grantChain.contractAddress,
    onchain_call_id: onchainCallId,
  });
  return (
    call?.provider_fee_bps ??
    deps.protocolFeeBps ??
    requireProtocolFeeBps(
      process.env,
      "this call carries no fee snapshot, so the sale has no split to freeze",
    )
  );
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
  | "sale_window_closed"
  | "cohort_full"
  | "not_sellable";

export interface EntitlementEligibility {
  reason: EligibilityReason;
  view: GrantDecryptAccessView | null;
  /**
   * The cohort limit this call is actually sold under — the provider's own
   * ceiling clamped by what the deployment can deliver. Returned rather than
   * recomputed by the caller because the reservation transaction MUST enforce
   * the same number this check used; enforcing a different one is how two
   * buyers racing for the last slot both got in.
   *
   * `undefined` means no limit applies.
   */
  cap: number | undefined;
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
  if (!view || view.state === 0) return { reason: "call_not_found", view: null, cap: undefined };
  if (view.state !== STATE_SEALED) return { reason: "not_sealed", view, cap: undefined };
  const nowSec = Math.floor(deps.now().getTime() / 1000);
  // Sales close a safety margin before the CONTRACT's grant deadline, so the
  // gate can never settle a payment for a grant that will revert.
  const salesCloseAt = view.grantCloseAt - deps.salesSafetySeconds;
  if (nowSec >= salesCloseAt) return { reason: "sale_window_closed", view, cap: undefined };

  // Cohort capacity. Each grant is its own transaction, so an unbounded cohort is a funding and
  // throughput problem rather than a block-limit one: N subscribers means N
  // grant transactions that must all confirm inside the delivery budget.
  //
  // Checked before the 402 challenge, so a full call is never charged for.
  // Source of truth is the SERIES cap persisted when the market was
  // registered, falling back to the global setting only when this call's
  // market cannot be resolved. Reading the global value alone let a series
  // registered with a cap of 50 sell more because the daemon setting differed.
  // The contract refuses to grant a LateUnsellable call (CallNotSellable), so
  // selling one takes payment for access that can never be delivered. Checked
  // here, before the 402 — eligibility previously looked only at state, time
  // and count.
  const sealedCall = fhenixSealedCallsRepo.byOnchainCall(deps.db, {
    chain_id: deps.grantChain.chainId,
    contract_address: deps.grantChain.contractAddress,
    onchain_call_id: onchainCallId,
  });
  // FAIL CLOSED on unknown. NULL means the class was never recorded (a call
  // accepted before migration 065, or a gateway attempt whose submit log was
  // never decoded). Treating unknown as sellable settles the payment and only
  // then discovers the contract reverts CallNotSellable — the subscriber has
  // paid for access that can never be delivered. Refusing costs a lost sale;
  // allowing costs a refund obligation with no refund worker to honour it.
  if (sealedCall?.submission_class !== SUBMISSION_CLASS_EARLY_ACCESS) {
    return { reason: "not_sellable", view, cap: undefined };
  }

  // Cohort size: the PROVIDER's business limit, clamped by what this
  // deployment can actually deliver. Two different constraints — an owner
  // saying "serve 200" does not make 200 grants confirmable inside the
  // delivery budget, and selling past that is a refund obligation.
  //
  // Read from the call's snapshot, not the live terms row: an owner who
  // raises their limit must not resize a cohort subscribers already joined.
  // Falls back to the series cap for calls sealed before per-provider terms.
  const deliverableCap = seriesCapForCall(deps, onchainCallId) ?? deps.maxArmedPerCall;
  const { cap } = effectiveCohortCap(
    sealedCall.provider_max_subscribers,
    deliverableCap,
  );
  if (cap !== undefined) {
    const armed = entitlementsRepo.countActiveForCall(deps.db, {
      chainId: deps.grantChain.chainId,
      contractAddress: deps.grantChain.contractAddress,
      onchainCallId,
    });
    if (armed >= cap) return { reason: "cohort_full", view, cap };
  }
  return { reason: "ok", view, cap };
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

  // (1b) Does THIS payer already hold the on-chain grant? The eligibility read
  // above uses a throwaway address, so it cannot answer that. The contract
  // treats a duplicate grant as a successful no-op, so without this check a
  // payer whose local entitlement row is missing — restored-from-backup DB,
  // manual grant, reconciler gap — pays again for access they already own.
  //
  // The chain is authoritative here, not our table: that is the whole point.
  const payerView = await deps.grantChain.readDecryptAccess(
    input.onchainCallId,
    input.verifiedPayer,
  );
  if (payerView?.alreadyGranted) {
    const known = entitlementsRepo.byReservation(deps.db, key);
    if (known) return classifyExisting(known);
    // On-chain access with no local row. Record it as granted rather than
    // charging for it; the subscriber can decrypt right now either way.
    //
    // ONE transaction. Reserving and promoting as two autocommit writes left a
    // crash window in which a `payment_settling` row existed for a payment
    // that never happened — the reconciler moves that to settlement_unknown
    // and then to grant_failed_refund_due, inventing a refund obligation. The
    // same transaction also resolves the race between two adoptions: the
    // second sees the row the first wrote.
    const nowAdopt = deps.now().toISOString();
    const adopted = entitlementsRepo.adoptOnchainGrant(deps.db, {
      ...key,
      producerAgentId: deps.resolveProducerAgentId?.(input.onchainCallId) ?? null,
      now: nowAdopt,
    });
    return adopted
      ? classifyExisting(adopted)
      : { kind: "error", status: 500, body: { error: "InternalStateInconsistent" } };
  }

  // (2) Reserve the unique entitlement BEFORE settlement. A racing identical
  // reservation throws SQLITE_CONSTRAINT_UNIQUE — resolve to the existing row.
  //
  // The cap is re-counted INSIDE the reservation's write transaction. Step (1)
  // above checks it too, but that check is a read: two different buyers on the
  // last slot both passed it and both inserted, because the unique index keys
  // on subscriber and so does not serialize them against each other.
  //
  // It enforces the cap step (1) COMPUTED — the provider's own ceiling clamped
  // by deliverability. Re-deriving the deployment cap here instead meant the
  // serialized check used a larger number than the check it was there to
  // backstop: an owner selling to 1 had both racing buyers admitted, because
  // the transaction was asking whether the deployment could take 50.
  const nowIso = deps.now().toISOString();
  let id: number;
  try {
    const reserved = entitlementsRepo.reserveWithinCap(deps.db, {
      ...key,
      callId: null,
      producerAgentId: deps.resolveProducerAgentId?.(input.onchainCallId) ?? null,
      amount: null,
      currency: null,
      // The split is frozen HERE, at the sale, not at the grant.
      feeBpsAtSale: feeBpsForSale(deps, input.onchainCallId),
      now: nowIso,
      // Hold the reconciler off while THIS request settles. It exists to
      // recover reservations whose request died, and it cannot tell that case
      // from one still waiting on the payment rail — so without a grace it
      // took live rows first, `listDue` ordering unscheduled ones ahead of
      // everything else.
      nextAttemptAt: new Date(
        deps.now().getTime() + settleGraceSeconds(deps) * 1000,
      ).toISOString(),
      cap: eligibility.cap,
    });
    if (reserved === null) return eligibilityError("cohort_full");
    id = reserved;
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
    //
    // Releases a `settlement_unknown` row too, and the result is CHECKED. If
    // the rejection took longer than the reconciler's grace, the row was
    // already relabelled by a tick that had no idea how the payment ended;
    // this definitive answer supersedes that guess. Leaving it behind blocked
    // the subscriber's retry and aged into a refund owed on money nobody took.
    const released = entitlementsRepo.releaseReservation(deps.db, id);
    if (!released) {
      // Something advanced the row past a releasable state, or it already
      // carries settlement evidence. Not ours to delete, but the rail's
      // rejection is worth recording against it — from ANY non-terminal state
      // plus refund_due, which is exactly where a slow rejection lands.
      entitlementsRepo.transition(
        deps.db,
        id,
        [...NON_TERMINAL_ENTITLEMENT_STATUSES, "grant_failed_refund_due"],
        {
          lastError: `settlement rejected: ${outcome.reason}`,
          now: nowIso,
        },
      );
    }
    return {
      kind: "error",
      status: 402,
      body: { error: "PaymentSettlementFailed", message: outcome.reason },
    };
  }
  if (outcome.kind === "unknown") {
    // Already settlement_unknown if the reconciler beat us here — same
    // destination, so accept it as a from-state rather than silently failing
    // the CAS and reporting a state we never confirmed.
    entitlementsRepo.transition(deps.db, id, ["payment_settling", "settlement_unknown"], {
      status: "settlement_unknown",
      lastError: outcome.reason,
      nextAttemptAt: nowIso,
      now: nowIso,
    });
    return pendingRow(deps.db, id);
  }

  // Settled: record the receipt + amount and move to grant_queued.
  //
  // `settlement_unknown` is an accepted from-state, and the result is CHECKED.
  // While this request awaited the payment rail, a reconciler tick could pick
  // the row up and move it there — it has no way to know a settle is in
  // flight. A CAS pinned to `payment_settling` then updated nothing, and the
  // ignored `false` meant the transaction id, amount and currency of a payment
  // that DID settle were never written down. Money in, no grant, and no local
  // evidence of the receipt for the manual refund.
  const recorded = entitlementsRepo.transition(
    deps.db,
    id,
    ["payment_settling", "settlement_unknown"],
    {
      status: "grant_queued",
      nanopayReceiptId: outcome.transaction,
      amount: outcome.amount,
      currency: outcome.currency,
      nextAttemptAt: nowIso,
      now: nowIso,
    },
  );
  if (!recorded) {
    // The row moved somewhere neither state covers — already granted by an
    // adoption, or terminalized as refund_due. Do not fight it for the status,
    // but the receipt is evidence of a real payment and must be attached
    // wherever the row ended up, or a refund gets processed with no record of
    // what was taken.
    entitlementsRepo.attachReceipt(deps.db, id, {
      nanopayReceiptId: outcome.transaction,
      amount: outcome.amount,
      currency: outcome.currency,
      now: nowIso,
    });
    // The row may have been granted by another writer BEFORE this receipt
    // existed, and `granted` is terminal — nothing revisits it. Attaching the
    // receipt is what makes the sale accruable, so accrue right here rather
    // than waiting for the sweep to notice a gap that is already resolvable.
    accrueIfEligible(earnings(deps), id);
  }

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
      grantAndAccrue(earnings(deps), id, ["grant_broadcast"], {
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
      grantAndAccrue(earnings(deps), id, ["grant_broadcast"], {
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
    grantAndAccrue(earnings(deps), id, [row.status], {
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


/**
 * The cohort cap for a call, read from the series its market belongs to.
 *
 * Registration persists `max_armed_per_call` on the series, so that is what
 * the market was actually sized for. Returns null when the call's market or
 * series cannot be resolved, so the caller can fall back rather than sell
 * uncapped.
 */
function seriesCapForCall(
  deps: EntitlementAccessDeps,
  onchainCallId: string,
): number | null {
  const sealed = fhenixSealedCallsRepo.byOnchainCall(deps.db, {
    chain_id: deps.grantChain.chainId,
    contract_address: deps.grantChain.contractAddress,
    onchain_call_id: onchainCallId,
  });
  if (!sealed?.call_id) return null;
  const row = deps.db
    .prepare("SELECT market_id FROM submissions WHERE call_id = ?")
    .get(sealed.call_id) as { market_id?: string } | undefined;
  const marketId = row?.market_id ?? null;
  if (!marketId) return null;
  const clock = marketClocksRepo.get(deps.db, marketId);
  if (!clock) return null;
  return marketSeriesRepo.get(deps.db, clock.series_id)?.max_armed_per_call ?? null;
}

function eligibilityError(reason: EligibilityReason): PurchaseResult {
  if (reason === "not_sellable") {
    return {
      kind: "error",
      status: 409,
      body: {
        error: "CallNotSellable",
        message:
          "this call is not proven sellable: its on-chain submission class is " +
          "not EarlyAccess, or was never recorded",
      },
    };
  }
  if (reason === "call_not_found") {
    return { kind: "error", status: 404, body: { error: "CallNotFound" } };
  }
  if (reason === "cohort_full") {
    // A capacity race lost at the SECOND eligibility check (immediately before
    // settlement) must not be reported as SaleWindowClosed — that tells the
    // caller the sale is over when in fact the call filled up.
    return {
      kind: "error",
      status: 409,
      body: {
        error: "CohortFull",
        message: "this call reached its maximum number of armed subscribers",
      },
    };
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
