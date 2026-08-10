import { SETTLEMENT_CURRENCY } from "../../integrations/circle-gateway.js";
import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

/**
 * What an agent owner charges for early decrypt access to their calls.
 *
 * Replaces a deployment-wide price and cohort cap. Murmur is a referee, not
 * the one who sets the terms of somebody else's product: the provider prices
 * their own signal and says how many subscribers they will serve.
 */
export interface AgentProviderTermsRow {
  agent_id: string;
  /** Access price in the settlement asset's atomic units. Always > 0. */
  price_atoms: string;
  currency: string;
  /** Stamps which commercial terms a subscriber agreed to. */
  pricing_version: string;
  /**
   * The owner's BUSINESS ceiling, or null for "as many as murmur can serve".
   *
   * Null is not "unlimited" in practice — every grant is its own transaction
   * and they must all confirm inside the delivery budget, so murmur clamps
   * this to what it can actually deliver. The owner's number and the
   * deployment's deliverability are different constraints and are kept apart
   * on purpose.
   */
  max_subscribers_per_call: number | null;
  created_at: string;
  updated_at: string;
}

export interface AgentProviderTermsInput {
  agent_id: string;
  price_atoms: string;
  currency: string;
  pricing_version: string;
  max_subscribers_per_call: number | null;
  now: string;
}

export const agentProviderTermsRepo = {
  get(db: Database.Database, agentId: string): AgentProviderTermsRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM agent_provider_terms WHERE agent_id = ?`,
      ).get(agentId) as AgentProviderTermsRow | undefined) ?? null
    );
  },

  /**
   * Set or update an owner's terms.
   *
   * Mutable by design — an owner may reprice whenever they like. That is safe
   * only because every sealed call SNAPSHOTS the terms it was sold under
   * (fhenix_sealed_calls.provider_*), so a change here never reaches a call a
   * subscriber has already bought into.
   */
  upsert(db: Database.Database, input: AgentProviderTermsInput): void {
    if (!/^[0-9]+$/.test(input.price_atoms) || BigInt(input.price_atoms) <= 0n) {
      throw new Error(
        `price_atoms must be a positive integer atomic amount (got "${input.price_atoms}")`,
      );
    }
    // The rail settles in exactly one asset. The HTTP schema enforces this too,
    // but the invariant belongs where every writer passes — a price recorded in
    // a currency nothing charges is a mislabel waiting to reach a receipt.
    if (input.currency.toUpperCase() !== SETTLEMENT_CURRENCY) {
      throw new Error(
        `currency must be ${SETTLEMENT_CURRENCY} — the settlement rail charges in ` +
          `that asset (got "${input.currency}")`,
      );
    }
    if (
      input.max_subscribers_per_call !== null &&
      (!Number.isInteger(input.max_subscribers_per_call) ||
        input.max_subscribers_per_call <= 0)
    ) {
      throw new Error(
        `max_subscribers_per_call must be a positive integer or null (got ${input.max_subscribers_per_call})`,
      );
    }
    prep(
      db,
      `INSERT INTO agent_provider_terms (
         agent_id, price_atoms, currency, pricing_version,
         max_subscribers_per_call, created_at, updated_at)
       VALUES (
         @agent_id, @price_atoms, @currency, @pricing_version,
         @max_subscribers_per_call, @now, @now)
       ON CONFLICT(agent_id) DO UPDATE SET
         price_atoms              = excluded.price_atoms,
         currency                 = excluded.currency,
         pricing_version          = excluded.pricing_version,
         max_subscribers_per_call = excluded.max_subscribers_per_call,
         updated_at               = excluded.updated_at`,
    ).run(input);
  },

  /** Stop selling access to this provider's calls. Past sales are untouched. */
  clear(db: Database.Database, agentId: string): void {
    prep(db, `DELETE FROM agent_provider_terms WHERE agent_id = ?`).run(agentId);
  },
};

/**
 * The cohort size murmur will actually sell for one call.
 *
 * Two independent limits, and the smaller wins:
 *
 *   ownerMax        what the provider is willing to serve (business)
 *   deliverableMax  what this deployment can grant inside the delivery budget
 *                   (physics — each grant is its own transaction)
 *
 * An owner who names no limit gets the deliverable one. An owner who names a
 * larger one is clamped, and callers surface that rather than silently
 * overselling: taking payment murmur cannot deliver means a refund obligation,
 * and refunds are manual today.
 */
export function effectiveCohortCap(
  ownerMax: number | null | undefined,
  deliverableMax: number | undefined,
): { cap: number | undefined; clampedByDeliverability: boolean } {
  if (ownerMax == null) return { cap: deliverableMax, clampedByDeliverability: false };
  if (deliverableMax === undefined) return { cap: ownerMax, clampedByDeliverability: false };
  return deliverableMax < ownerMax
    ? { cap: deliverableMax, clampedByDeliverability: true }
    : { cap: ownerMax, clampedByDeliverability: false };
}
