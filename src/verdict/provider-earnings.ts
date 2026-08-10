import type Database from "better-sqlite3";

import { requireProtocolFeeBps, splitFeeAtoms } from "./protocol-fee.js";
import {
  entitlementsRepo,
  type EntitlementPatch,
  type EntitlementRow,
  type EntitlementStatus,
} from "./repos/entitlements-repo.js";
import { fhenixSealedCallsRepo } from "./repos/fhenix-sealed-calls-repo.js";
import { providerEarningsRepo } from "./repos/provider-earnings-repo.js";

// ─── Accrual — turning a settled sale into a ledger row ─────────────────────
//
// The invariant, stated as a predicate rather than as a sequence of steps:
//
//     a PAID, GRANTED entitlement has exactly one provider_earnings row.
//
// Three writers converge on it, and none of them is trusted to be the only one
// that runs:
//
//   1. grantAndAccrue — the granted CAS and the earnings insert in ONE
//      transaction. `granted` is terminal and excluded from the reconciler's
//      due query, so a crash between a separate CAS and a separate insert
//      would lose that sale's earnings FOREVER. They commit together or not
//      at all.
//   2. accrueIfEligible — after a receipt is attached to a row another writer
//      already granted. attachReceipt makes a row eligible retroactively; the
//      grant that preceded it had nothing to accrue at the time.
//   3. sweepUnaccruedGrants — the reconciler's audit pass, which repairs
//      anything the first two missed (an older build, a crash in an unlucky
//      place) and says so in the log.
//
// Accrual never moves money. Circle settles every sale to one recipient, so the
// funds land at MURMUR_NANOPAY_SELLER_ADDRESS regardless; this records WHOSE
// they are. Paying providers out is manual, like refunds.

export interface ProviderEarningsDeps {
  readonly db: Database.Database;
  /**
   * The CURRENT protocol fee. Used ONLY for rows predating migration 071,
   * which froze no split of their own. Never for a row that carries
   * fee_bps_at_sale — the sale is where the split freezes, and re-reading the
   * live fee at grant time would let a mid-flight change re-cut a purchase the
   * subscriber already answered a 402 for.
   *
   * Resolved from MURMUR_PROTOCOL_FEE_BPS when omitted, and only at the moment
   * a legacy row actually needs it.
   */
  readonly protocolFeeBps?: number;
  readonly now: () => Date;
  readonly logger?: Pick<Console, "warn">;
}

export type AccrualOutcome =
  /** A new ledger row was written. */
  | { kind: "accrued"; entitlementId: number; feeAtoms: string; netAtoms: string }
  /** Already recorded — the convergent case, and not a problem. */
  | { kind: "already_accrued"; entitlementId: number }
  /** Not a paid, granted sale: nothing is owed. */
  | { kind: "not_eligible"; entitlementId: number; reason: string }
  /** A real sale nobody can be paid for. Logged loudly; stays in the sweep. */
  | { kind: "unattributed"; entitlementId: number; reason: string };

/**
 * Advance an entitlement to `granted` and accrue its earnings in ONE
 * transaction.
 *
 * Replaces a bare `entitlementsRepo.transition(..., { status: "granted" })` at
 * every site that grants. The accrual is attempted from the row as re-read
 * INSIDE the transaction, so it also covers the case where the CAS matched
 * nothing because a concurrent writer had already granted the row: the sale
 * still ends the transaction with exactly one earnings row.
 *
 * Returns whether the CAS itself changed the row, so callers keep the same
 * signal `transition` gave them.
 */
export function grantAndAccrue(
  deps: ProviderEarningsDeps,
  id: number,
  from: readonly EntitlementStatus[],
  patch: EntitlementPatch & { status: "granted" },
): boolean {
  const run = deps.db.transaction(() => {
    const changed = entitlementsRepo.transition(deps.db, id, from, patch);
    accrueWithinTransaction(deps, id);
    return changed;
  });
  // IMMEDIATE: the transaction writes from its first statement, and taking the
  // write lock up front is what keeps two grantors from both reading "no
  // earnings row yet" before either inserts.
  return run.immediate();
}

/**
 * Accrue for one entitlement if it is a paid, granted sale that has not
 * accrued yet. Safe to call at any time, on any row, any number of times.
 */
export function accrueIfEligible(
  deps: ProviderEarningsDeps,
  id: number,
): AccrualOutcome {
  const run = deps.db.transaction(() => accrueWithinTransaction(deps, id));
  return run.immediate();
}

export interface AccrualSweepResult {
  scanned: number;
  accrued: number;
  unattributed: number;
  errors: number;
}

/**
 * Audit pass: find paid, granted entitlements with no earnings row and repair
 * them. Runs on the grant reconciler's tick.
 *
 * Every repair is logged by name. A silent self-heal would hide the thing worth
 * knowing — that some writer upstream is dropping accruals — behind a ledger
 * that always looks right.
 */
export function sweepUnaccruedGrants(
  deps: ProviderEarningsDeps,
  input: { limit: number } = { limit: 50 },
): AccrualSweepResult {
  const logger = deps.logger ?? console;
  const result: AccrualSweepResult = {
    scanned: 0,
    accrued: 0,
    unattributed: 0,
    errors: 0,
  };
  const rows = providerEarningsRepo.listAccruableEntitlements(deps.db, {
    limit: input.limit,
  });
  for (const row of rows) {
    result.scanned += 1;
    try {
      const outcome = accrueIfEligible(deps, row.id);
      if (outcome.kind === "accrued") {
        result.accrued += 1;
        logger.warn(
          `[provider-earnings] REPAIRED a paid granted entitlement that carried ` +
            `no earnings row: entitlement=${row.id} call=${row.onchain_call_id} ` +
            `net=${outcome.netAtoms} fee=${outcome.feeAtoms}. The grant path ` +
            `should have accrued this at grant time — investigate why it did not.`,
        );
      } else if (outcome.kind === "unattributed") {
        result.unattributed += 1;
      }
    } catch (err) {
      result.errors += 1;
      logger.warn(
        `[provider-earnings] accrual failed for entitlement=${row.id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

/**
 * The accrual decision itself. MUST run inside a transaction — it reads the row,
 * decides, and writes, and those three must not be interleaved with another
 * grantor doing the same.
 */
function accrueWithinTransaction(
  deps: ProviderEarningsDeps,
  id: number,
): AccrualOutcome {
  const logger = deps.logger ?? console;
  const row = entitlementsRepo.byId(deps.db, id);
  if (!row) return { kind: "not_eligible", entitlementId: id, reason: "no such entitlement" };

  // Only a granted sale accrues. `grant_failed_refund_due` and `refunded` are
  // money owed BACK; recording revenue on them would book income murmur is in
  // the middle of returning.
  if (row.status !== "granted") {
    return { kind: "not_eligible", entitlementId: id, reason: `status=${row.status}` };
  }
  if (row.refund_status !== null) {
    return {
      kind: "not_eligible",
      entitlementId: id,
      reason: `refund_status=${row.refund_status}`,
    };
  }
  // No payment, no revenue. This is what excludes adoptOnchainGrant rows: the
  // chain already granted that subscriber, murmur charged nothing, and inventing
  // a receipt for them would put phantom revenue in the ledger.
  if (!row.nanopay_receipt_id || row.amount === null) {
    return { kind: "not_eligible", entitlementId: id, reason: "no settled payment" };
  }
  if (providerEarningsRepo.byEntitlement(deps.db, id)) {
    return { kind: "already_accrued", entitlementId: id };
  }

  const producerAgentId = resolveProducer(deps.db, row);
  if (!producerAgentId) {
    // NOT an insert with a placeholder owner. An earnings row naming nobody
    // counts toward every total while being unpayable — strictly worse than a
    // gap that keeps showing up in the sweep until somebody looks at it.
    logger.warn(
      `[provider-earnings] UNATTRIBUTED SALE: entitlement=${row.id} ` +
        `call=${row.onchain_call_id} chain=${row.chain_id} ` +
        `contract=${row.contract_address} amount=${row.amount} — the producing ` +
        `agent could not be resolved from the entitlement or from the sealed ` +
        `call, so no earnings row was written. Money settled; nobody is ` +
        `recorded as owed it. This row stays in the accrual sweep until fixed.`,
    );
    return {
      kind: "unattributed",
      entitlementId: id,
      reason: "producer agent could not be resolved",
    };
  }

  // The split as of the SALE. NULL means the row predates migration 071 and
  // froze no split at all — those accrue at the current fee, and say so.
  const sale = row.fee_bps_at_sale;
  const feeBps = sale ?? deps.protocolFeeBps ?? requireProtocolFeeBps();
  const accrualSource = sale === null ? "legacy_fallback" : "sale_snapshot";
  const split = splitFeeAtoms(row.amount, feeBps);

  const accruedAt = deps.now().toISOString();
  const inserted = providerEarningsRepo.insert(deps.db, {
    entitlement_id: row.id,
    producer_agent_id: producerAgentId,
    chain_id: row.chain_id,
    contract_address: row.contract_address,
    onchain_call_id: row.onchain_call_id,
    gross_atoms: split.gross.toString(),
    fee_bps: feeBps,
    fee_atoms: split.fee.toString(),
    net_atoms: split.net.toString(),
    // A settled payment always carries the currency it settled in; the fallback
    // is unreachable in practice and exists so a malformed row fails the
    // currency CHECK rather than throwing on a null bind.
    currency: row.currency ?? "",
    accrual_source: accrualSource,
    accrued_at: accruedAt,
  });
  return inserted
    ? {
        kind: "accrued",
        entitlementId: row.id,
        feeAtoms: split.fee.toString(),
        netAtoms: split.net.toString(),
      }
    : { kind: "already_accrued", entitlementId: row.id };
}

/**
 * Who produced this sale.
 *
 * The entitlement's own column first — resolved at reservation, so it reflects
 * the deployment that actually sold the call. The sealed-call join is the
 * fallback for rows reserved before that wiring existed (it was declared as an
 * optional dependency and never supplied in production, so the column is NULL
 * on every row written by those builds).
 *
 * An agent id that names no agent is NOT attribution. provider_earnings has a
 * NOT NULL foreign key to agents, and checking here means the caller gets the
 * loud "unattributed" path instead of a constraint error thrown from inside a
 * grant transaction.
 */
function resolveProducer(
  db: Database.Database,
  row: EntitlementRow,
): string | null {
  const candidates = [
    row.producer_agent_id,
    fhenixSealedCallsRepo.producerAgentIdByOnchainCall(db, {
      chain_id: row.chain_id,
      contract_address: row.contract_address,
      onchain_call_id: row.onchain_call_id,
    }),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const exists = db
      .prepare("SELECT 1 AS ok FROM agents WHERE agent_id = ? LIMIT 1")
      .get(candidate) as { ok?: number } | undefined;
    if (exists) return candidate;
  }
  return null;
}
