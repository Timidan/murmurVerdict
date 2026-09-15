import { SETTLEMENT_CURRENCY } from "../../integrations/circle-gateway.js";
import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

/** What an agent owner charges for early decrypt access; the provider prices their own signal. */
export interface AgentProviderTermsRow {
  agent_id: string;
  /** The venue series these terms price; terms are per series. */
  venue_series_id: string;
  /** Access price in the settlement asset's atomic units. Always > 0. */
  price_atoms: string;
  currency: string;
  /** Stamps which commercial terms a subscriber agreed to. */
  pricing_version: string;
  /**
   * The owner's business ceiling, or null for "as many as murmur can serve".
   * Murmur still clamps it to what it can deliver (see effectiveCohortCap).
   */
  max_subscribers_per_call: number | null;
  created_at: string;
  updated_at: string;
}

export interface AgentProviderTermsInput {
  agent_id: string;
  venue_series_id: string;
  price_atoms: string;
  currency: string;
  pricing_version: string;
  max_subscribers_per_call: number | null;
  now: string;
}

/** The composite key every read/write of provider terms is scoped to. */
export interface AgentProviderTermsKey {
  agentId: string;
  venueSeriesId: string;
}

export const agentProviderTermsRepo = {
  get(
    db: Database.Database,
    key: AgentProviderTermsKey,
  ): AgentProviderTermsRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM agent_provider_terms
          WHERE agent_id = ? AND venue_series_id = ?`,
      ).get(key.agentId, key.venueSeriesId) as
        | AgentProviderTermsRow
        | undefined) ?? null
    );
  },

  /**
   * Set or update an owner's terms. Repricing is safe: sealed calls snapshot the terms they
   * were sold under. Requires a registration for (agent_id, venue_series_id) (composite FK).
   */
  upsert(db: Database.Database, input: AgentProviderTermsInput): void {
    if (!/^[0-9]+$/.test(input.price_atoms) || BigInt(input.price_atoms) <= 0n) {
      throw new Error(
        `price_atoms must be a positive integer atomic amount (got "${input.price_atoms}")`,
      );
    }
    // The rail settles in one asset; checked here so every writer passes through it.
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
         agent_id, venue_series_id, price_atoms, currency, pricing_version,
         max_subscribers_per_call, created_at, updated_at)
       VALUES (
         @agent_id, @venue_series_id, @price_atoms, @currency, @pricing_version,
         @max_subscribers_per_call, @now, @now)
       ON CONFLICT(agent_id, venue_series_id) DO UPDATE SET
         price_atoms              = excluded.price_atoms,
         currency                 = excluded.currency,
         pricing_version          = excluded.pricing_version,
         max_subscribers_per_call = excluded.max_subscribers_per_call,
         updated_at               = excluded.updated_at`,
    ).run(input);
  },

  /**
   * Stop selling access to this provider's calls for one series. Past sales are
   * untouched. Scoped to a single series — clearing one leaves the rest.
   */
  clear(db: Database.Database, key: AgentProviderTermsKey): void {
    prep(
      db,
      `DELETE FROM agent_provider_terms
        WHERE agent_id = ? AND venue_series_id = ?`,
    ).run(key.agentId, key.venueSeriesId);
  },
};

/**
 * Cohort size murmur will sell for one call: the smaller of ownerMax (business) and
 * deliverableMax (grants that fit the delivery budget). Callers surface a clamp, never oversell.
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
