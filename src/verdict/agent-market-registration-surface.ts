// ─── Agent ↔ market-series registration — an owner opts into serving a series ─
//
// A price is per venue series (migration 075), and a registration is its
// precondition: agent_provider_terms FKs to agent_market_registrations, so an
// agent must be registered for a series before it can price it, and dropping
// the registration cascades the price away.
//
//   GET    /v1/account/agents/:slug/market-registrations   list series + state
//   POST   /v1/account/agents/:slug/market-registrations   register (idempotent)
//   DELETE /v1/account/agents/:slug/market-registrations/:venueSeriesId  unregister
//
// Ownership is enforced exactly like provider-terms: requireOwnedAgentBySlug
// throws 404 for an unknown agent and 403 for one owned by another account.
import type Database from "better-sqlite3";
import { z } from "zod";

import { requireOwnedAgentBySlug } from "./agent-identity.js";
import { agentMarketRegistrationsRepo } from "./repos/agent-market-registrations-repo.js";
import { agentProviderTermsRepo } from "./repos/agent-provider-terms-repo.js";
import { venueMarketSeriesRepo } from "./repos/venue-market-series-repo.js";
import { SCHEMA_VERSION } from "./schema.js";

export interface MarketRegistrationResponse {
  status: number;
  body: unknown;
}

export interface MarketRegistrationDeps {
  db: Database.Database;
  accountId: string;
  slug: string;
}

const RegisterBodySchema = z
  .object({ venue_series_id: z.string().min(1) })
  .strict();

/** The terms shape echoed in the list, or null when the owner has not priced. */
function termsView(
  terms: ReturnType<typeof agentProviderTermsRepo.get>,
): unknown {
  if (!terms) return null;
  return {
    price_atoms: terms.price_atoms,
    currency: terms.currency,
    pricing_version: terms.pricing_version,
    max_subscribers_per_call: terms.max_subscribers_per_call,
  };
}

/**
 * Every venue series, with THIS agent's registration and pricing state on each,
 * so the settings UI can render the whole opt-in surface in one call. Terms
 * only exist for a registered series (the FK guarantees it), so a non-null
 * terms block always sits under registered:true.
 */
export function listAgentMarketRegistrations(
  deps: MarketRegistrationDeps,
): MarketRegistrationResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  const series = venueMarketSeriesRepo.list(deps.db).map((s) => {
    const registered = agentMarketRegistrationsRepo.isRegistered(deps.db, {
      agentId: agent.agent_id,
      venueSeriesId: s.venue_series_id,
    });
    const terms = registered
      ? agentProviderTermsRepo.get(deps.db, {
          agentId: agent.agent_id,
          venueSeriesId: s.venue_series_id,
        })
      : null;
    return {
      venue_series_id: s.venue_series_id,
      series_title: s.series_title,
      series_slug: s.series_slug,
      venue_category: s.venue_category,
      registered,
      terms: termsView(terms),
    };
  });
  return {
    status: 200,
    body: { schema_version: SCHEMA_VERSION, series },
  };
}

/**
 * Register the agent to serve a series. Idempotent — a repeat is a no-op and
 * still answers 200. 404 when the series is unknown (a client mistake, not the
 * raw FK-violation 500 the repo would otherwise surface).
 */
export function registerAgentForSeries(
  deps: MarketRegistrationDeps & { body: unknown; now: () => Date },
): MarketRegistrationResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  const parsed = RegisterBodySchema.safeParse(deps.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { code: "schema_invalid", issues: parsed.error.format() },
    };
  }
  const series = venueMarketSeriesRepo.get(deps.db, parsed.data.venue_series_id);
  if (!series) {
    return {
      status: 404,
      body: {
        code: "series_unknown",
        message: `no venue series '${parsed.data.venue_series_id}'`,
      },
    };
  }
  agentMarketRegistrationsRepo.register(deps.db, {
    agentId: agent.agent_id,
    venueSeriesId: series.venue_series_id,
    now: deps.now().toISOString(),
  });
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      venue_series_id: series.venue_series_id,
      series_title: series.series_title,
      series_slug: series.series_slug,
      venue_category: series.venue_category,
      registered: true,
    },
  };
}

/**
 * Drop the agent's registration for a series. Idempotent, and with foreign
 * keys enforced (they are, at db open) this cascades the agent's provider terms
 * for that series away in the same step — the price cannot outlive the
 * registration it FKs to.
 */
export function unregisterAgentFromSeries(
  deps: MarketRegistrationDeps & { venueSeriesId: string },
): MarketRegistrationResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  agentMarketRegistrationsRepo.unregister(deps.db, {
    agentId: agent.agent_id,
    venueSeriesId: deps.venueSeriesId,
  });
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      venue_series_id: deps.venueSeriesId,
      registered: false,
    },
  };
}
