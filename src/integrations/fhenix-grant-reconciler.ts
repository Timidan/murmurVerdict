import type Database from "better-sqlite3";

import {
  reconcileEntitlement,
  type EntitlementAccessDeps,
} from "../verdict/entitlement-access.js";
import {
  entitlementsRepo,
  type EntitlementRow,
} from "../verdict/repos/entitlements-repo.js";

// Background reconciler for Flow 2 entitlements stuck in a non-terminal state
// after the synchronous access request returned (grant_queued /
// grant_broadcast / settlement_unknown / grant_failed_refund_due). It reuses
// reconcileEntitlement (the same durable step logic the route drives inline)
// so a dropped grant tx, a slow confirmation, or an uncertain settlement heals
// without operator intervention. Default-off/gated by the daemon.
//
// A settled payment is NEVER relabeled a plain failure: an ungrantable grant
// ends in grant_failed_refund_due so the operator/refund path owes money back.
export interface FhenixGrantReconcilerConfig {
  db: Database.Database;
  access: EntitlementAccessDeps;
  /** Max due rows processed per tick. */
  maxJobsPerTick?: number;
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
}

export class FhenixGrantReconciler {
  private readonly db: Database.Database;
  private readonly access: EntitlementAccessDeps;
  private readonly maxJobsPerTick: number;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "log" | "warn">;

  constructor(config: FhenixGrantReconcilerConfig) {
    this.db = config.db;
    this.access = config.access;
    this.maxJobsPerTick = Math.max(1, Math.floor(config.maxJobsPerTick ?? 10));
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
    // grant_queued / grant_broadcast advance through the shared step logic.
    // settlement_unknown and grant_failed_refund_due are left for the operator
    // refund tooling; reconcileEntitlement is a no-op on them.
    return reconcileEntitlement(this.access, row);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
