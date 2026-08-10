import type Database from "better-sqlite3";

import {
  reconcileEntitlement,
  type EntitlementAccessDeps,
} from "../verdict/entitlement-access.js";
import {
  entitlementsRepo,
  type EntitlementRow,
} from "../verdict/repos/entitlements-repo.js";
import { sweepUnaccruedGrants } from "../verdict/provider-earnings.js";

// Background reconciler for Flow 2 entitlements stuck in a non-terminal state
// after the synchronous access request returned (grant_queued /
// grant_broadcast / settlement_unknown). It reuses reconcileEntitlement (the
// same durable step logic the route drives inline) so a dropped grant tx, a
// slow confirmation, or an uncertain settlement heals without operator
// intervention. Default-off/gated by the daemon.
//
// grant_failed_refund_due is NOT handled here: it is terminal for grant work
// and owed a refund instead. entitlementsRepo.listDue excludes it so a backlog
// of dead rows cannot consume this reconciler's per-tick budget; the refund
// path reads entitlementsRepo.listRefundDue.
//
// A settled payment is NEVER relabeled a plain failure: an ungrantable grant
// ends in grant_failed_refund_due so the operator/refund path owes money back.
export interface FhenixGrantReconcilerConfig {
  db: Database.Database;
  access: EntitlementAccessDeps;
  /** Max due rows processed per tick. */
  maxJobsPerTick?: number;
  /**
   * Max paid-but-unaccrued entitlements repaired per tick by the earnings
   * audit sweep. Separate budget from the grant work: the two must not be able
   * to starve each other.
   */
  maxAccrualRepairsPerTick?: number;
  /** How many attempts before a still-unsettled row is marked settlement_unknown. */
  settlementUnknownAfterAttempts?: number;
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn">;
}

export interface FhenixGrantReconcilerTickResult {
  processed: number;
  granted: number;
  refund_due: number;
  still_pending: number;
  errors: number;
  /** Paid, granted entitlements that were missing an earnings row and got one. */
  earnings_repaired: number;
  /** Real sales whose producing agent could not be resolved. Never zero quietly. */
  earnings_unattributed: number;
}

export class FhenixGrantReconciler {
  private readonly db: Database.Database;
  private readonly access: EntitlementAccessDeps;
  private readonly maxJobsPerTick: number;
  private readonly maxAccrualRepairsPerTick: number;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "log" | "warn">;

  constructor(config: FhenixGrantReconcilerConfig) {
    this.db = config.db;
    this.access = config.access;
    this.maxJobsPerTick = Math.max(1, Math.floor(config.maxJobsPerTick ?? 10));
    this.maxAccrualRepairsPerTick = Math.max(
      1,
      Math.floor(config.maxAccrualRepairsPerTick ?? 50),
    );
    this.now = config.now ?? config.access.now;
    this.logger = config.logger ?? console;
  }

  async tick(): Promise<FhenixGrantReconcilerTickResult> {
    const result: FhenixGrantReconcilerTickResult = {
      processed: 0,
      granted: 0,
      refund_due: 0,
      still_pending: 0,
      errors: 0,
      earnings_repaired: 0,
      earnings_unattributed: 0,
    };
    const nowIso = this.now().toISOString();
    const due = entitlementsRepo.listDue(this.db, {
      now: nowIso,
      limit: this.maxJobsPerTick,
    });
    for (const row of due) {
      result.processed += 1;
      try {
        const next = await this.advance(row);
        if (next.status === "granted") result.granted += 1;
        else if (next.status === "grant_failed_refund_due") result.refund_due += 1;
        else result.still_pending += 1;
      } catch (err) {
        result.errors += 1;
        this.logger.warn(
          `[fhenix-grant-reconciler] entitlement=${row.id} error: ${describe(err)}`,
        );
      }
    }

    // Earnings audit. `granted` is terminal and absent from listDue, so a sale
    // that reached it without accruing is never revisited by the loop above —
    // a receipt attached after another writer granted the row, or a row written
    // by a build that predates the ledger. This is the pass that makes "a paid,
    // granted entitlement has exactly one earnings row" true rather than
    // intended, and it reports every repair.
    try {
      const sweep = sweepUnaccruedGrants(
        {
          db: this.db,
          protocolFeeBps: this.access.protocolFeeBps,
          now: this.now,
          logger: this.logger,
        },
        { limit: this.maxAccrualRepairsPerTick },
      );
      result.earnings_repaired = sweep.accrued;
      result.earnings_unattributed = sweep.unattributed;
      result.errors += sweep.errors;
    } catch (err) {
      result.errors += 1;
      this.logger.warn(
        `[fhenix-grant-reconciler] earnings sweep failed: ${describe(err)}`,
      );
    }
    return result;
  }

  private async advance(row: EntitlementRow): Promise<EntitlementRow> {
    // A row still in payment_settling never settled durably — the request
    // process crashed between reserve and settle. Without the payment payload we
    // cannot re-settle, so mark it settlement_unknown for operator review; the
    // subscriber has an on-chain-checkable record and no grant was issued.
    if (row.status === "payment_settling") {
      entitlementsRepo.transition(this.db, row.id, ["payment_settling"], {
        status: "settlement_unknown",
        lastError: "reservation never settled (recovered by reconciler)",
        nextAttemptAt: this.now().toISOString(),
        now: this.now().toISOString(),
      });
      return entitlementsRepo.byId(this.db, row.id) ?? row;
    }
    // grant_queued / grant_broadcast advance through the shared step logic, as
    // does settlement_unknown (retried under its own budget, then terminalized
    // to grant_failed_refund_due). Terminal refund_due rows never reach here —
    // listDue excludes them so they cannot starve live grants.
    return reconcileEntitlement(this.access, row);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
