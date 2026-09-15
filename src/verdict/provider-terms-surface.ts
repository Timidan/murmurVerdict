// ─── Provider terms — an agent owner prices their own signal ───────────────
//
//   GET    /v1/account/agents/:slug/provider-terms   read current terms
//   PUT    /v1/account/agents/:slug/provider-terms   set or update them
//   DELETE /v1/account/agents/:slug/provider-terms   stop selling access
//
// max_subscribers_per_call is the owner's ceiling; the deliverable cap is what the deployment
// can grant inside the delivery budget. Both are reported so a clamp is visible.
import type Database from "better-sqlite3";
import { z } from "zod";

import { SETTLEMENT_CURRENCY } from "../integrations/circle-gateway.js";
import { requireOwnedAgentBySlug } from "./agent-identity.js";
import { PROTOCOL_FEE_BPS_ENV, parseProtocolFeeBps } from "./protocol-fee.js";
import { agentMarketRegistrationsRepo } from "./repos/agent-market-registrations-repo.js";
import {
  agentProviderTermsRepo,
  effectiveCohortCap,
} from "./repos/agent-provider-terms-repo.js";
import { SCHEMA_VERSION } from "./schema.js";

export const ProviderTermsBodySchema = z
  .object({
    /** Atomic units as a decimal string; a float would round the price. */
    price_atoms: z.string().regex(/^[0-9]+$/, "price_atoms must be decimal digits"),
    /** Must be the asset the settlement rail actually charges in. */
    currency: z.literal(SETTLEMENT_CURRENCY),
    /**
     * Bump when the price changes. It stamps which terms a subscriber agreed
     * to, so receipts stay attributable across a reprice.
     */
    pricing_version: z.string().min(1).max(32),
    /** Optional business ceiling; null serves as many as murmur can deliver. Never raises the deliverable limit. */
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
  /** Venue series being priced; terms are per-series. Empty answers 400. */
  venueSeriesId: string;
  /** What this deployment can grant for one call inside the delivery budget. */
  deliverableCap: number | undefined;
  /** Murmur's cut in bps. `undefined` reads the environment; `null` means none configured. */
  protocolFeeBps?: number | null;
  now: () => Date;
}

/**
 * Sealing a selling agent's call refuses without a fee, so terms without one are a 503
 * (deployment not ready), not a 400.
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

/** Terms are per-series with no agent-wide default; naming no series is a 400. */
function seriesRequired(): ProviderTermsResponse {
  return {
    status: 400,
    body: {
      code: "series_required",
      message:
        "provider terms are per market series; name one with " +
        "?series=<venue_series_id>",
    },
  };
}

export function readProviderTerms(deps: ProviderTermsDeps): ProviderTermsResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  if (!deps.venueSeriesId) return seriesRequired();
  return {
    status: 200,
    body: view(
      deps,
      agentProviderTermsRepo.get(deps.db, {
        agentId: agent.agent_id,
        venueSeriesId: deps.venueSeriesId,
      }),
    ),
  };
}

export function setProviderTerms(
  deps: ProviderTermsDeps & { body: unknown },
): ProviderTermsResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  if (!deps.venueSeriesId) return seriesRequired();
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
  // A price presupposes the agent serves the series. The repo's foreign key
  // enforces this too, but that surfaces as a 500; answer the honest 409 first.
  if (
    !agentMarketRegistrationsRepo.isRegistered(deps.db, {
      agentId: agent.agent_id,
      venueSeriesId: deps.venueSeriesId,
    })
  ) {
    return {
      status: 409,
      body: {
        code: "not_registered_for_series",
        message:
          "this agent is not registered to serve that series; register before " +
          "pricing it",
      },
    };
  }
  agentProviderTermsRepo.upsert(deps.db, {
    agent_id: agent.agent_id,
    venue_series_id: deps.venueSeriesId,
    price_atoms: parsed.data.price_atoms,
    currency: parsed.data.currency,
    pricing_version: parsed.data.pricing_version,
    max_subscribers_per_call: parsed.data.max_subscribers_per_call ?? null,
    now: deps.now().toISOString(),
  });
  // Terms take effect for calls sealed FROM NOW ON. Calls already sealed keep
  // the snapshot they were sold under — see fhenix_sealed_calls.provider_*.
  return {
    status: 200,
    body: view(
      deps,
      agentProviderTermsRepo.get(deps.db, {
        agentId: agent.agent_id,
        venueSeriesId: deps.venueSeriesId,
      }),
    ),
  };
}

export function clearProviderTerms(deps: ProviderTermsDeps): ProviderTermsResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  if (!deps.venueSeriesId) return seriesRequired();
  agentProviderTermsRepo.clear(deps.db, {
    agentId: agent.agent_id,
    venueSeriesId: deps.venueSeriesId,
  });
  // Calls already sealed keep their snapshot and remain purchasable; this only
  // stops FUTURE calls from being offered.
  return { status: 200, body: view(deps, null) };
}
