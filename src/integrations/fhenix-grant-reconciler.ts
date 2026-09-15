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

// Background reconciler for entitlements left non-terminal after the access request
// (grant_queued / grant_broadcast / settlement_unknown), via reconcileEntitlement.
// grant_failed_refund_due is terminal and excluded from listDue so it can't eat the budget.
// A settled payment is NEVER relabeled a plain failure: ungrantable ends in grant_failed_refund_due.
export interface FhenixGrantReconcilerConfig {
  db: Database.Database;
  access: EntitlementAccessDeps;
  /** Max due rows processed per tick. */
  maxJobsPerTick?: number;
  /** Max unaccrued entitlements repaired per tick; separate budget so it can't starve grant work. */
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

    // Earnings audit: `granted` rows never reach listDue, so this pass ensures every
    // paid, granted entitlement has exactly one earnings row.
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
    // payment_settling never settled (crash between reserve and settle); without the
    // payload we can't re-settle, so mark settlement_unknown for operator review.
    if (row.status === "payment_settling") {
      entitlementsRepo.transition(this.db, row.id, ["payment_settling"], {
        status: "settlement_unknown",
        lastError: "reservation never settled (recovered by reconciler)",
        nextAttemptAt: this.now().toISOString(),
        now: this.now().toISOString(),
      });
      return entitlementsRepo.byId(this.db, row.id) ?? row;
    }
    // Other due statuses advance through the shared step logic.
    return reconcileEntitlement(this.access, row);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
