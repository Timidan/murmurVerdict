import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

/**
 * Binds a settled x402 payment to the one resource it bought, so one signed header cannot buy
 * two calls. The entitlement reservation alone is per (call, subscriber) and does not stop that.
 */
export const entitlementPaymentBindingsRepo = {
  /**
   * Claim `payload_hash` for `resource_fingerprint`. True when bound to this resource (a retry
   * counts). False when bound to a different one: a replay, refused before any settlement.
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
