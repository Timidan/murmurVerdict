// ─── Provider terms — an agent owner prices their own signal ───────────────
//
// Murmur is a referee, not the seller. Price and cohort size used to be single
// deployment-wide env values, which meant the operator set the terms of every
// provider's product. These routes hand that back to the owner.
//
//   GET    /v1/account/agents/:slug/provider-terms   read current terms
//   PUT    /v1/account/agents/:slug/provider-terms   set or update them
//   DELETE /v1/account/agents/:slug/provider-terms   stop selling access
//
// Two limits are deliberately kept apart:
//
//   max_subscribers_per_call  the OWNER's business ceiling (optional)
//   deliverable cap           what this deployment can grant inside the
//                             delivery budget — physics, not policy
//
// The response reports both so an owner asking for more than murmur can serve
// is told plainly rather than silently clamped.
import type Database from "better-sqlite3";
import { z } from "zod";

import { SETTLEMENT_CURRENCY } from "../integrations/circle-gateway.js";
import { requireOwnedAgentBySlug } from "./agent-identity.js";
import { PROTOCOL_FEE_BPS_ENV, parseProtocolFeeBps } from "./protocol-fee.js";
import {
  agentProviderTermsRepo,
  effectiveCohortCap,
} from "./repos/agent-provider-terms-repo.js";
import { SCHEMA_VERSION } from "./schema.js";

export const ProviderTermsBodySchema = z
  .object({
    /**
     * Atomic units of the settlement asset, as a decimal string. A string, not
     * a number: prices can exceed the safe integer range in low-decimal
     * assets, and a float would quietly round somebody's price.
     */
    price_atoms: z.string().regex(/^[0-9]+$/, "price_atoms must be decimal digits"),
    /**
     * Must be the asset the settlement rail actually charges in.
     *
     * Accepting any label let an owner set `currency: "ETH"` with an
     * 18-decimal price: the buyer was still challenged for that number of USDC
     * atoms, and the receipt was stamped ETH. A currency nothing enforces is
     * not a currency, it is a mislabel on real money.
     */
    currency: z.literal(SETTLEMENT_CURRENCY),
    /**
     * Bump when the price changes. It stamps which terms a subscriber agreed
     * to, so receipts stay attributable across a reprice.
     */
    pricing_version: z.string().min(1).max(32),
    /**
     * Optional. Omit (or null) to serve as many subscribers as murmur can
     * deliver to. This is a business ceiling; it never raises the deliverable
     * limit.
     */
    max_subscribers_per_call: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((v) => BigInt(v.price_atoms) > 0n, {
    message: "price_atoms must be greater than zero",
    path: ["price_atoms"],
  });

export interface ProviderTermsResponse {
  status: number;
  body: unknown;
}

export interface ProviderTermsDeps {
  db: Database.Database;
  accountId: string;
  slug: string;
  /**
   * What this deployment can actually grant for one call inside the delivery
   * budget. Reported alongside the owner's number so a clamp is visible.
   */
  deliverableCap: number | undefined;
  /**
   * Murmur's cut, in basis points. `undefined` means "read it from the
   * environment", which is what the mounted routes do; tests pass it directly.
   * `null` states outright that none is configured.
   */
  protocolFeeBps?: number | null;
  now: () => Date;
}

/**
 * Setting terms is a promise that calls will be sellable. Sealing a call for a
 * selling agent freezes the protocol fee onto it, and refuses when there is no
 * fee to freeze — so without this check an owner would price their signal
 * successfully and only discover the problem when their next submission was
 * rejected, or when a buyer could not be quoted.
 *
 * 503, not 400: nothing is wrong with what the owner sent. The deployment is
 * not ready to sell, and the message names the variable that makes it ready.
 */
function configuredFeeBps(deps: ProviderTermsDeps): number | null {
  return deps.protocolFeeBps === undefined
    ? parseProtocolFeeBps(process.env)
    : deps.protocolFeeBps;
}

function view(
  deps: ProviderTermsDeps,
  terms: ReturnType<typeof agentProviderTermsRepo.get>,
): unknown {
  if (!terms) {
    return {
      schema_version: SCHEMA_VERSION,
      selling: false,
      deliverable_max_subscribers_per_call: deps.deliverableCap ?? null,
    };
  }
  const { cap, clampedByDeliverability } = effectiveCohortCap(
    terms.max_subscribers_per_call,
    deps.deliverableCap,
  );
  return {
    schema_version: SCHEMA_VERSION,
    selling: true,
    price_atoms: terms.price_atoms,
    currency: terms.currency,
    pricing_version: terms.pricing_version,
    max_subscribers_per_call: terms.max_subscribers_per_call,
    deliverable_max_subscribers_per_call: deps.deliverableCap ?? null,
    /** What murmur will actually sell — min(owner, deliverable). */
    effective_max_subscribers_per_call: cap ?? null,
    clamped_by_deliverability: clampedByDeliverability,
    ...(clampedByDeliverability
      ? {
          notice:
            `you set ${terms.max_subscribers_per_call}, but this deployment can ` +
            `only grant ${deps.deliverableCap} inside the delivery budget — each ` +
            `grant is its own transaction. Sales stop at ${cap}.`,
        }
      : {}),
    updated_at: terms.updated_at,
  };
}

export function readProviderTerms(deps: ProviderTermsDeps): ProviderTermsResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  return { status: 200, body: view(deps, agentProviderTermsRepo.get(deps.db, agent.agent_id)) };
}

export function setProviderTerms(
  deps: ProviderTermsDeps & { body: unknown },
): ProviderTermsResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  const parsed = ProviderTermsBodySchema.safeParse(deps.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { code: "schema_invalid", issues: parsed.error.format() },
    };
  }
  if (configuredFeeBps(deps) === null) {
    return {
      status: 503,
      body: {
        code: "protocol_fee_unconfigured",
        message:
          `this deployment has no ${PROTOCOL_FEE_BPS_ENV} set, so it cannot ` +
          `record the revenue split for a sale. Sealing a call for a selling ` +
          `agent freezes that split onto the call, and refuses without one — ` +
          `your terms would be accepted here and then break your next ` +
          `submission. Ask the operator to set ${PROTOCOL_FEE_BPS_ENV}.`,
      },
    };
  }
  agentProviderTermsRepo.upsert(deps.db, {
    agent_id: agent.agent_id,
    price_atoms: parsed.data.price_atoms,
    currency: parsed.data.currency,
    pricing_version: parsed.data.pricing_version,
    max_subscribers_per_call: parsed.data.max_subscribers_per_call ?? null,
    now: deps.now().toISOString(),
  });
  // Terms take effect for calls sealed FROM NOW ON. Calls already sealed keep
  // the snapshot they were sold under — see fhenix_sealed_calls.provider_*.
  return { status: 200, body: view(deps, agentProviderTermsRepo.get(deps.db, agent.agent_id)) };
}

export function clearProviderTerms(deps: ProviderTermsDeps): ProviderTermsResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  agentProviderTermsRepo.clear(deps.db, agent.agent_id);
  // Calls already sealed keep their snapshot and remain purchasable; this only
  // stops FUTURE calls from being offered.
  return { status: 200, body: view(deps, null) };
}
