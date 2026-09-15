// ─── Delivery acceptance — the gate between a sale and a payout ─────────────
//
// A buyer pays to read a sealed call early. `entitlements` says whether the
// on-chain GRANT landed. This module answers the separate question that gates
// paying the provider: did the buyer actually get what they paid for?
//
// ─── "valid" means DELIVERED, never CORRECT ────────────────────────────────
//
// The only thing a buyer may complain about is a defect in delivery:
//
//   decrypt_unavailable    the ciphertext could not be decrypted
//   malformed_prediction   it decrypted to something that is not a prediction
//   market_mismatch        it is not about the market that was bought
//   late_delivery          access arrived after the delivery deadline
//
// "the prediction lost" is NOT on that list, is rejected by a CHECK constraint
// in migration 080, and must never be added. A marketplace where the buyer
// decides after the fact whether to pay is a marketplace that only pays for
// winning calls, which is not what murmur sells. Nothing in this file reads an
// outcome, a score, or a resolution, and nothing in it should ever start.
//
// ─── Silence is not a veto ─────────────────────────────────────────────────
//
// A buyer who simply never answers would otherwise freeze the provider's money
// forever, which makes non-answering a free option worth taking. So a sale
// auto-accepts once the call has been PUBLICLY REVEALED and that reveal is
// finalized and valid: at that point anyone can check the call for themselves,
// so the buyer's private complaint has no privileged standing left.
//
// The deadline elapsing is NOT sufficient on its own. `publicRevealAt` only
// permits a reveal; publishing it takes a transaction that may never have been
// sent, and the reveal worker treats `Invalid` as terminal too. So the sweep
// VERIFIES a finalized valid reveal before it accepts anything, and a call
// that never got one falls to the longstop as a refund rather than being
// swept into a payout.

import type Database from "better-sqlite3";

import { verifySignedMessageAddress } from "./controller-wallet.js";
import { entitlementsRepo } from "./repos/entitlements-repo.js";
import {
  DISPUTE_GROUNDS,
  entitlementDeliveryRepo,
  type DisputeGround,
  type EntitlementDeliveryRow,
} from "./repos/entitlement-delivery-repo.js";

/** The grace between the reveal horizon and the end of adjudication. */
export const DISPUTE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface DeliveryDeps {
  db: Database.Database;
  now: () => Date;
}

/**
 * What the sweep must establish before it may accept a sale on the buyer's
 * behalf. Injected rather than imported so the rule can be tested against a
 * fixed answer instead of a chain.
 */
export interface RevealVerifier {
  /**
   * Did this exact call reach a FINALIZED, VALID public reveal?
   *
   * `false` for a call that was revealed Invalid, never revealed at all, or
   * whose reveal is not yet final. `null` means "could not tell" — the sweep
   * then leaves the row alone rather than guessing in either direction.
   */
  hasValidPublicReveal(input: {
    chainId: number;
    contractAddress: string;
    onchainCallId: string;
  }): Promise<boolean | null>;
}

/**
 * Open the delivery record for a sale, carrying the deadlines the buyer was
 * shown before they paid.
 *
 * `publicRevealAtIso` is frozen here and never re-read. A deadline that can
 * move is not a deadline: a market rescheduled after the sale would otherwise
 * silently extend or collapse a window the buyer already paid against.
 */
export function openDelivery(
  deps: DeliveryDeps,
  entitlementId: number,
  publicRevealAtIso: string,
): void {
  const horizon = Date.parse(publicRevealAtIso);
  if (!Number.isFinite(horizon)) {
    throw new Error(`openDelivery: unparsable publicRevealAt ${publicRevealAtIso}`);
  }
  entitlementDeliveryRepo.open(deps.db, {
    entitlement_id: entitlementId,
    accept_deadline_at: new Date(horizon).toISOString(),
    dispute_longstop_at: new Date(horizon + DISPUTE_GRACE_MS).toISOString(),
    created_at: deps.now().toISOString(),
  });
}

/**
 * The message a buyer signs to accept delivery.
 *
 * Action-specific and single-use by construction: it names the action, the
 * deployment, the exact entitlement and call, and the signer. It deliberately
 * does NOT reuse the purchases-surface message, which authorizes replayable
 * READS — a signature minted to look at a purchase history must never also
 * release somebody else's money.
 */
export function deliveryActionMessage(input: {
  action: "accept_delivery" | "dispute_delivery";
  audience: string;
  entitlementId: number;
  chainId: number;
  contractAddress: string;
  onchainCallId: string;
  subscriberAddress: string;
  ground?: DisputeGround;
}): string {
  const lines = [
    "murmur.verdict",
    `action=${input.action}`,
    `audience=${input.audience}`,
    `entitlement=${input.entitlementId}`,
    `chain=${input.chainId}`,
    `contract=${input.contractAddress.toLowerCase()}`,
    `call=${input.onchainCallId.toLowerCase()}`,
    `subscriber=${input.subscriberAddress.toLowerCase()}`,
  ];
  if (input.ground) lines.push(`ground=${input.ground}`);
  return lines.join("\n");
}

export type DeliveryOutcome =
  | { ok: true; state: EntitlementDeliveryRow["state"] }
  | { ok: false; code: DeliveryErrorCode; message: string };

export type DeliveryErrorCode =
  | "not_found"
  | "not_granted"
  | "bad_signature"
  | "already_settled"
  | "window_closed"
  | "unknown_ground";

/**
 * The buyer accepts: this sale may be paid out.
 *
 * Accepting is allowed at any time after the grant, including after the
 * deadline — a buyer who is satisfied should never be blocked from saying so,
 * and saying so only ever moves money TOWARD the provider.
 */
export async function acceptDelivery(
  deps: DeliveryDeps,
  input: {
    entitlementId: number;
    subscriberAddress: string;
    signature: `0x${string}`;
    audience: string;
  },
): Promise<DeliveryOutcome> {
  const checked = await authorize(deps, {
    ...input,
    action: "accept_delivery",
  });
  if (!checked.ok) return checked;
  const nowIso = deps.now().toISOString();
  const changed = entitlementDeliveryRepo.transition(
    deps.db,
    input.entitlementId,
    // A live dispute can still be settled by the buyer accepting: they are the
    // one who raised it, and withdrawing it is theirs to do.
    ["pending", "disputed"],
    {
      state: "buyer_accepted",
      accepted_at: nowIso,
      acceptance_signature: input.signature,
      acceptance_digest: checked.message,
      decided_by: "buyer",
      decided_at: nowIso,
      updated_at: nowIso,
    },
  );
  if (!changed) {
    return { ok: false, code: "already_settled", message: "This sale is already settled." };
  }
  return { ok: true, state: "buyer_accepted" };
}

/**
 * The buyer raises a delivery defect. This HOLDS the money; it never refunds
 * on its own. An operator adjudicates before anything moves in either
 * direction, because a self-serve refund button is a self-serve theft button.
 */
export async function disputeDelivery(
  deps: DeliveryDeps,
  input: {
    entitlementId: number;
    subscriberAddress: string;
    signature: `0x${string}`;
    audience: string;
    ground: string;
    evidence: string | null;
  },
): Promise<DeliveryOutcome> {
  if (!(DISPUTE_GROUNDS as readonly string[]).includes(input.ground)) {
    return {
      ok: false,
      code: "unknown_ground",
      // Named explicitly, because this is the error a buyer hits when they try
      // to dispute a call that simply lost.
      message: `Not a delivery defect. Murmur accepts: ${DISPUTE_GROUNDS.join(", ")}. Whether the prediction was right has no bearing on payment.`,
    };
  }
  const ground = input.ground as DisputeGround;
  const checked = await authorize(deps, { ...input, action: "dispute_delivery", ground });
  if (!checked.ok) return checked;

  const row = entitlementDeliveryRepo.byEntitlementId(deps.db, input.entitlementId);
  if (!row) return { ok: false, code: "not_found", message: "No delivery record." };
  // Complaints close at the horizon: past it the call is public, and a
  // complaint about private delivery can no longer be told apart from regret.
  if (Date.parse(row.accept_deadline_at) <= deps.now().getTime()) {
    return {
      ok: false,
      code: "window_closed",
      message: "The dispute window closed when this call was published.",
    };
  }
  const nowIso = deps.now().toISOString();
  const changed = entitlementDeliveryRepo.transition(deps.db, input.entitlementId, ["pending"], {
    state: "disputed",
    dispute_ground: ground,
    dispute_evidence: input.evidence,
    disputed_at: nowIso,
    updated_at: nowIso,
  });
  if (!changed) {
    return { ok: false, code: "already_settled", message: "This sale is already settled." };
  }
  return { ok: true, state: "disputed" };
}

/**
 * Shared gate: the sale exists, it was granted, and the caller proved they are
 * the buyer by signing an action-specific message.
 */
async function authorize(
  deps: DeliveryDeps,
  input: {
    entitlementId: number;
    subscriberAddress: string;
    signature: `0x${string}`;
    audience: string;
    action: "accept_delivery" | "dispute_delivery";
    ground?: DisputeGround;
  },
): Promise<{ ok: true; message: string } | { ok: false; code: DeliveryErrorCode; message: string }> {
  const entitlement = entitlementsRepo.byId(deps.db, input.entitlementId);
  if (!entitlement) return { ok: false, code: "not_found", message: "No such purchase." };
  // Nothing to accept before access exists.
  if (entitlement.status !== "granted") {
    return {
      ok: false,
      code: "not_granted",
      message: "Access has not been granted for this purchase yet.",
    };
  }
  if (
    entitlement.subscriber_address.toLowerCase() !== input.subscriberAddress.toLowerCase()
  ) {
    return { ok: false, code: "bad_signature", message: "Not the buyer of this purchase." };
  }
  const message = deliveryActionMessage({
    action: input.action,
    audience: input.audience,
    entitlementId: input.entitlementId,
    chainId: entitlement.chain_id,
    contractAddress: entitlement.contract_address,
    onchainCallId: entitlement.onchain_call_id,
    subscriberAddress: entitlement.subscriber_address,
    ground: input.ground,
  });
  const valid = await verifySignedMessageAddress(
    entitlement.subscriber_address,
    message,
    input.signature,
  );
  if (!valid) {
    return { ok: false, code: "bad_signature", message: "Signature did not match the buyer." };
  }
  return { ok: true, message };
}

export interface DeliverySweepResult {
  scanned: number;
  autoAccepted: number;
  rejected: number;
  /** Left alone because the chain could not be read. Retried next tick. */
  deferred: number;
}

/**
 * Settle deadlines that have passed.
 *
 * Two distinct outcomes, and the difference is evidence:
 *
 *   a finalized VALID public reveal  → auto_accepted, the provider is paid
 *   past the longstop with no such reveal → rejected, the buyer is refunded
 *
 * The second is the honest answer when murmur cannot show that the thing it
 * sold was ever publishable. Between the two deadlines the row simply waits,
 * because a reveal that has not happened yet may still happen.
 */
export async function sweepDeliveryDeadlines(
  deps: DeliveryDeps,
  verifier: RevealVerifier,
  limit = 50,
): Promise<DeliverySweepResult> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const due = entitlementDeliveryRepo.listDue(deps.db, nowIso, limit);
  const result: DeliverySweepResult = {
    scanned: due.length,
    autoAccepted: 0,
    rejected: 0,
    deferred: 0,
  };

  for (const row of due) {
    const entitlement = entitlementsRepo.byId(deps.db, row.entitlement_id);
    if (!entitlement) {
      result.deferred += 1;
      continue;
    }
    const revealed = await verifier.hasValidPublicReveal({
      chainId: entitlement.chain_id,
      contractAddress: entitlement.contract_address,
      onchainCallId: entitlement.onchain_call_id,
    });

    if (revealed === true) {
      // A disputed row is NOT swept into acceptance by a reveal: the buyer
      // raised a delivery defect in time, and a published call does not
      // disprove that it was undecryptable when they paid for it. That stays
      // for an operator.
      if (row.state === "disputed") {
        result.deferred += 1;
        continue;
      }
      if (
        entitlementDeliveryRepo.transition(deps.db, row.entitlement_id, ["pending"], {
          state: "auto_accepted",
          decided_by: "auto",
          decided_at: nowIso,
          decision_note: "public reveal finalized valid; no dispute raised in time",
          updated_at: nowIso,
        })
      ) {
        result.autoAccepted += 1;
      }
      continue;
    }

    if (revealed === null) {
      result.deferred += 1;
      continue;
    }

    // No valid reveal. Wait until the longstop, then refuse the sale rather
    // than pay a provider for something murmur cannot show was deliverable.
    if (Date.parse(row.dispute_longstop_at) > now.getTime()) {
      result.deferred += 1;
      continue;
    }
    const settled = deps.db.transaction(() => {
      const changed = entitlementDeliveryRepo.transition(
        deps.db,
        row.entitlement_id,
        ["pending", "disputed"],
        {
          state: "rejected",
          decided_by: "auto",
          decided_at: nowIso,
          decision_note: "no finalized valid public reveal by the longstop",
          updated_at: nowIso,
        },
      );
      if (changed) {
        // The buyer is owed their GROSS payment back, murmur's fee included.
        // The accrual row stays: release-balance moves it to `cancelled`, so
        // the sale remains visible instead of being erased from history.
        entitlementsRepo.transition(deps.db, row.entitlement_id, ["granted"], {
          refundStatus: "refund_due",
          now: nowIso,
        });
      }
      return changed;
    });
    if (settled.immediate()) result.rejected += 1;
  }

  return result;
}
