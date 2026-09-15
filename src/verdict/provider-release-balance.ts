// ─── What a provider may actually withdraw ──────────────────────────────────
//
// One question, asked in one place, because every caller that answers it
// separately is a chance to pay the same sale twice.
//
//   accrued    every sale that accrued to this agent, delivered or not
//   accepted   sales whose delivery the buyer accepted, or that a finalized
//              valid reveal accepted for them
//   held       sales still pending or disputed — earned, not yet releasable
//   cancelled  sales adjudicated against; a gross refund is owed to the buyer
//   unenrolled sales that predate the delivery policy and carry no record
//   paid       the payout journal, payouts less reversals
//   reserved   withdrawals already in flight
//
//   available = max(0, accepted − paid − reserved)
//
// `unenrolled` is its own bucket and never counts toward `available`. Treating
// a historical `granted` row as though a buyer had accepted it would be
// inventing consent that was never given; those rows wait for an operator to
// reconcile them, and until then they are visibly excluded rather than
// silently included.
//
// Every amount is atomic units as a decimal STRING, summed in BigInt. Nothing
// here goes through a JS number: these values routinely exceed 2^53 in
// low-decimal assets and SQLite's SUM() would quietly round them.

import type Database from "better-sqlite3";

import { prep } from "./db-statements.js";
import { providerPayoutsRepo } from "./repos/provider-payouts-repo.js";
import { providerWithdrawalsRepo } from "./repos/provider-withdrawals-repo.js";

export interface ProviderReleaseBalance {
  currency: string;
  accrued_net_atoms: string;
  accepted_net_atoms: string;
  held_net_atoms: string;
  cancelled_net_atoms: string;
  unenrolled_net_atoms: string;
  net_paid_atoms: string;
  reserved_atoms: string;
  /** What a withdrawal request may take right now. Never negative. */
  available_atoms: string;
  /** Sales counted in `accepted`, for the panel's "n releasable" line. */
  accepted_sales: number;
  held_sales: number;
  cancelled_sales: number;
  unenrolled_sales: number;
}

interface Bucket {
  accrued: bigint;
  accepted: bigint;
  held: bigint;
  cancelled: bigint;
  unenrolled: bigint;
  acceptedSales: number;
  heldSales: number;
  cancelledSales: number;
  unenrolledSales: number;
}

const emptyBucket = (): Bucket => ({
  accrued: 0n,
  accepted: 0n,
  held: 0n,
  cancelled: 0n,
  unenrolled: 0n,
  acceptedSales: 0,
  heldSales: 0,
  cancelledSales: 0,
  unenrolledSales: 0,
});

/**
 * Per-currency release balances for one agent.
 *
 * MUST be called inside the same transaction as any reservation it informs.
 * Read outside one, two concurrent withdrawal requests each see the other's
 * funds as free and the agent withdraws its balance twice.
 */
export function readProviderReleaseBalances(
  db: Database.Database,
  producerAgentId: string,
): ProviderReleaseBalance[] {
  // LEFT JOIN, so a sale with no delivery record still appears — as
  // `unenrolled`. An INNER JOIN would make those rows vanish from `accrued`
  // too, and a total that silently omits real sales is worse than one that
  // shows them as unavailable.
  const rows = prep(
    db,
    `SELECT e.currency AS currency, e.net_atoms AS net_atoms, d.state AS delivery_state
       FROM provider_earnings e
       LEFT JOIN entitlement_delivery d ON d.entitlement_id = e.entitlement_id
      WHERE e.producer_agent_id = ?`,
  ).all(producerAgentId) as Array<{
    currency: string;
    net_atoms: string;
    delivery_state: string | null;
  }>;

  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const currency = row.currency.toUpperCase();
    const bucket = buckets.get(currency) ?? emptyBucket();
    const net = BigInt(row.net_atoms);
    bucket.accrued += net;
    switch (row.delivery_state) {
      case "buyer_accepted":
      case "auto_accepted":
        bucket.accepted += net;
        bucket.acceptedSales += 1;
        break;
      case "pending":
      case "disputed":
        bucket.held += net;
        bucket.heldSales += 1;
        break;
      case "rejected":
        bucket.cancelled += net;
        bucket.cancelledSales += 1;
        break;
      default:
        bucket.unenrolled += net;
        bucket.unenrolledSales += 1;
        break;
    }
    buckets.set(currency, bucket);
  }

  // Currencies the agent has been PAID in but never accrued in would otherwise
  // disappear from this report — an overpayment with no matching sale is
  // exactly the operator error worth surfacing.
  for (const total of providerPayoutsRepo.totalsForAgent(db, producerAgentId)) {
    if (!buckets.has(total.currency.toUpperCase())) {
      buckets.set(total.currency.toUpperCase(), emptyBucket());
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, b]) => {
      const netPaid = providerPayoutsRepo.netPaidAtoms(db, {
        producerAgentId,
        currency,
      });
      const reserved = providerWithdrawalsRepo.heldAtoms(db, {
        producerAgentId,
        currency,
      });
      // Clamped at zero: an overpaid or over-reserved agent has nothing to
      // take, and a negative "available" read as a number to withdraw would be
      // a very expensive sign error.
      const raw = b.accepted - netPaid - reserved;
      const available = raw > 0n ? raw : 0n;
      return {
        currency,
        accrued_net_atoms: b.accrued.toString(),
        accepted_net_atoms: b.accepted.toString(),
        held_net_atoms: b.held.toString(),
        cancelled_net_atoms: b.cancelled.toString(),
        unenrolled_net_atoms: b.unenrolled.toString(),
        net_paid_atoms: netPaid.toString(),
        reserved_atoms: reserved.toString(),
        available_atoms: available.toString(),
        accepted_sales: b.acceptedSales,
        held_sales: b.heldSales,
        cancelled_sales: b.cancelledSales,
        unenrolled_sales: b.unenrolledSales,
      };
    });
}

/** One currency's balance, or null when the agent has no history in it. */
export function readProviderReleaseBalance(
  db: Database.Database,
  producerAgentId: string,
  currency: string,
): ProviderReleaseBalance | null {
  const want = currency.toUpperCase();
  return (
    readProviderReleaseBalances(db, producerAgentId).find((b) => b.currency === want) ??
    null
  );
}
