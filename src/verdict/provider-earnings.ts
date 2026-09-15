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
// Invariant: a paid, granted entitlement has exactly one provider_earnings row.
// Writers: grantAndAccrue (CAS + insert in one transaction), accrueIfEligible (after a
// late receipt attach), sweepUnaccruedGrants (reconciler repair pass).
// Accrual never moves money; it records whose the funds at MURMUR_NANOPAY_SELLER_ADDRESS are.

export interface ProviderEarningsDeps {
  readonly db: Database.Database;
  /**
   * Current fee, used only for rows with a NULL fee_bps_at_sale; never re-cuts a frozen split.
   * Read lazily from MURMUR_PROTOCOL_FEE_BPS when omitted.
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
 * Grant and accrue in one transaction. Accrual re-reads the row inside it, so a CAS that lost
 * to a concurrent grant still ends with one earnings row. Returns whether the CAS changed the row.
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
  // IMMEDIATE: take the write lock up front so two grantors can't both see no earnings row.
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
 * Repair paid, granted entitlements with no earnings row; runs on the grant reconciler tick.
 * Every repair is logged so a writer dropping accruals stays visible.
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

/** Must run inside a transaction: read, decide and write can't interleave with another grantor. */
function accrueWithinTransaction(
  deps: ProviderEarningsDeps,
  id: number,
): AccrualOutcome {
  const logger = deps.logger ?? console;
  const row = entitlementsRepo.byId(deps.db, id);
  if (!row) return { kind: "not_eligible", entitlementId: id, reason: "no such entitlement" };

  // Only a granted sale accrues; refund states are money owed back.
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
  // No payment, no revenue; this excludes adoptOnchainGrant rows.
  if (!row.nanopay_receipt_id || row.amount === null) {
    return { kind: "not_eligible", entitlementId: id, reason: "no settled payment" };
  }
  if (providerEarningsRepo.byEntitlement(deps.db, id)) {
    return { kind: "already_accrued", entitlementId: id };
  }

  const producerAgentId = resolveProducer(deps.db, row);
  if (!producerAgentId) {
    // No placeholder owner: an unpayable row would count in totals; the gap stays in the sweep.
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

  // The split frozen at sale; NULL falls back to the current fee, labelled legacy_fallback.
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
    // Fallback makes a malformed row fail the currency CHECK instead of a null bind.
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
 * Producer of this sale: the entitlement's column first, then the sealed-call join when it's NULL.
 * The agent must exist (FK), so a dangling id takes the unattributed path instead of throwing mid-grant.
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
