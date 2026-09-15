import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

// ─── entitlement_delivery — may this sale be released? (migration 080) ──────
//
// A buyer pays for early private access to a sealed call. `entitlements`
// tracks whether the GRANT landed; this table tracks whether the buyer got
// what they paid for, which is the separate question that gates paying the
// provider.
//
// IT IS ABOUT DELIVERY, NEVER ABOUT ACCURACY. A losing call is delivered as
// completely as a winning one, and there is no column here that could express
// the difference: the dispute grounds are a closed list of delivery defects,
// and the words "correct", "won" and "score" appear nowhere in this file by
// design. A system where a buyer can withhold payment because the prediction
// lost is not a prediction marketplace.

export type DeliveryState =
  | "pending"
  | "buyer_accepted"
  | "auto_accepted"
  | "disputed"
  | "rejected";

/** The only things a buyer may complain about. Objective, and checkable. */
export type DisputeGround =
  | "decrypt_unavailable"
  | "malformed_prediction"
  | "market_mismatch"
  | "late_delivery";

export const DISPUTE_GROUNDS: readonly DisputeGround[] = [
  "decrypt_unavailable",
  "malformed_prediction",
  "market_mismatch",
  "late_delivery",
];

/** Accepted either way. These are the states that let money move. */
export const RELEASED_DELIVERY_STATES: readonly DeliveryState[] = [
  "buyer_accepted",
  "auto_accepted",
];

export type DeliveryDecider = "buyer" | "auto" | "operator";

export interface EntitlementDeliveryRow {
  entitlement_id: number;
  state: DeliveryState;
  /** Frozen at purchase from the call's publicRevealAt. Never re-read. */
  accept_deadline_at: string;
  dispute_longstop_at: string;
  accepted_at: string | null;
  acceptance_signature: string | null;
  acceptance_digest: string | null;
  dispute_ground: DisputeGround | null;
  dispute_evidence: string | null;
  disputed_at: string | null;
  decided_by: DeliveryDecider | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntitlementDeliveryInsert {
  entitlement_id: number;
  accept_deadline_at: string;
  dispute_longstop_at: string;
  created_at: string;
}

const COLUMNS = `entitlement_id, state, accept_deadline_at, dispute_longstop_at,
       accepted_at, acceptance_signature, acceptance_digest,
       dispute_ground, dispute_evidence, disputed_at,
       decided_by, decided_at, decision_note, created_at, updated_at`;

export const entitlementDeliveryRepo = {
  /**
   * Open a delivery record at reservation time, carrying the deadlines the
   * buyer was shown BEFORE they paid.
   *
   * `OR IGNORE`: the reservation it rides along with is itself idempotent, so
   * a retried purchase must not fail here — and must not reset a deadline
   * either. The first write wins, which is the one the buyer agreed to.
   */
  open(db: Database.Database, input: EntitlementDeliveryInsert): void {
    prep(
      db,
      `INSERT OR IGNORE INTO entitlement_delivery
         (entitlement_id, state, accept_deadline_at, dispute_longstop_at,
          created_at, updated_at)
       VALUES (@entitlement_id, 'pending', @accept_deadline_at,
               @dispute_longstop_at, @created_at, @created_at)`,
    ).run(input);
  },

  byEntitlementId(db: Database.Database, id: number): EntitlementDeliveryRow | null {
    return (prep(
      db,
      `SELECT ${COLUMNS} FROM entitlement_delivery WHERE entitlement_id = ?`,
    ).get(id) ?? null) as EntitlementDeliveryRow | null;
  },

  /**
   * Compare-and-set on `state`, the same shape entitlementsRepo.transition
   * uses. Returns whether THIS call made the change, so a caller can tell its
   * own write from a concurrent writer's.
   *
   * Every money-adjacent decision in this system is a CAS from an expected
   * state, never a blind UPDATE: two workers that both read `pending` must not
   * both get to decide it.
   */
  transition(
    db: Database.Database,
    id: number,
    from: readonly DeliveryState[],
    patch: {
      state: DeliveryState;
      accepted_at?: string | null;
      acceptance_signature?: string | null;
      acceptance_digest?: string | null;
      dispute_ground?: DisputeGround | null;
      dispute_evidence?: string | null;
      disputed_at?: string | null;
      decided_by?: DeliveryDecider | null;
      decided_at?: string | null;
      decision_note?: string | null;
      updated_at: string;
    },
  ): boolean {
    if (from.length === 0) return false;
    const sets: string[] = ["state = @state", "updated_at = @updated_at"];
    for (const key of [
      "accepted_at",
      "acceptance_signature",
      "acceptance_digest",
      "dispute_ground",
      "dispute_evidence",
      "disputed_at",
      "decided_by",
      "decided_at",
      "decision_note",
    ] as const) {
      if (key in patch) sets.push(`${key} = @${key}`);
    }
    const placeholders = from.map((_, i) => `@from${i}`).join(", ");
    const params: Record<string, unknown> = { ...patch, entitlement_id: id };
    from.forEach((s, i) => {
      params[`from${i}`] = s;
    });
    const info = prep(
      db,
      `UPDATE entitlement_delivery SET ${sets.join(", ")}
       WHERE entitlement_id = @entitlement_id AND state IN (${placeholders})`,
    ).run(params);
    return info.changes > 0;
  },

  /**
   * Pending or disputed rows whose deadline has passed, oldest first.
   *
   * The sweep that reads this still has to VERIFY a finalized valid reveal
   * before it may auto-accept — a deadline that has merely elapsed proves
   * nothing about whether the call was ever published.
   */
  listDue(
    db: Database.Database,
    nowIso: string,
    limit: number,
  ): EntitlementDeliveryRow[] {
    return prep(
      db,
      `SELECT ${COLUMNS} FROM entitlement_delivery
        WHERE state IN ('pending','disputed') AND accept_deadline_at <= @now
        ORDER BY accept_deadline_at ASC
        LIMIT @limit`,
    ).all({ now: nowIso, limit }) as EntitlementDeliveryRow[];
  },

  /** Entitlement ids for one agent whose delivery is accepted. */
  acceptedEntitlementIds(db: Database.Database, producerAgentId: string): number[] {
    return prep(
      db,
      `SELECT d.entitlement_id AS id
         FROM entitlement_delivery d
         JOIN entitlements e ON e.id = d.entitlement_id
        WHERE e.producer_agent_id = @agent
          AND d.state IN ('buyer_accepted','auto_accepted')`,
    )
      .all({ agent: producerAgentId })
      .map((r) => (r as { id: number }).id);
  },
};
