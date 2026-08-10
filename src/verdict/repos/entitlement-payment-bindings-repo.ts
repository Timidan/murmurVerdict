import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

/**
 * Binds a settled x402 payment to the one resource it bought.
 *
 * The access broker used to compute a payload hash and a requirements hash and
 * discard both, under a comment claiming the entitlement reservation was the
 * real anti-double-charge guard. It is not: the reservation is unique per
 * (call, subscriber), so the SAME signed payment header replayed against a
 * DIFFERENT call at the same price satisfied every local check. Whether it
 * actually settled twice then depended entirely on the facilitator's nonce
 * handling — someone else's guarantee, not one this service makes.
 */
export const entitlementPaymentBindingsRepo = {
  /**
   * Claim `payload_hash` for `resource_fingerprint`.
   *
   * Returns true when the payment is now bound to that resource — either
   * because this call bound it, or because it was already bound to the SAME
   * resource (clients retry, and a retry of one purchase must still work).
   *
   * Returns false when the hash is already bound to a DIFFERENT resource:
   * that is a replay, and the caller refuses it before any settlement.
   */
  bind(
    db: Database.Database,
    input: {
      payload_hash: string;
      resource_fingerprint: string;
      requirements_hash: string;
      now_iso: string;
    },
  ): boolean {
    // INSERT-or-ignore then read back, in one transaction: two concurrent
    // presentations of the same header must not both see "not yet bound".
    const run = db.transaction(() => {
      prep(
        db,
        `INSERT OR IGNORE INTO entitlement_payment_bindings (
           payload_hash, resource_fingerprint, requirements_hash, created_at
         ) VALUES (
           @payload_hash, @resource_fingerprint, @requirements_hash, @now_iso
         )`,
      ).run(input);
      const row = prep(
        db,
        `SELECT resource_fingerprint FROM entitlement_payment_bindings
          WHERE payload_hash = ?`,
      ).get(input.payload_hash) as { resource_fingerprint: string } | undefined;
      return row?.resource_fingerprint === input.resource_fingerprint;
    });
    return run.immediate();
  },

  get(
    db: Database.Database,
    payloadHash: string,
  ): { resource_fingerprint: string; requirements_hash: string } | null {
    return (
      (prep(
        db,
        `SELECT resource_fingerprint, requirements_hash
           FROM entitlement_payment_bindings WHERE payload_hash = ?`,
      ).get(payloadHash) as
        | { resource_fingerprint: string; requirements_hash: string }
        | undefined) ?? null
    );
  },
};
