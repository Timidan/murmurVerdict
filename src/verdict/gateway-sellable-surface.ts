// ─── Public storefront: sealed calls whose sale window is open ──────────────
//
//   GET /v2/gateway/calls/sellable
//
// Everything needed to render a buy list, and nothing a buyer should not see.
// No ciphertext handles, no rationale, no provider economics — a listed row is
// an OFFER: who is selling, for what market, at what price, until when, and
// how many seats are left.
//
// Deployment scope is a hard filter, not a nicety. `fhenix_sealed_calls` is
// keyed by (chain, contract, onchain call id), and a database that has served
// more than one deployment holds rows the CURRENT contract knows nothing
// about. Listing those would offer access the grantor cannot deliver, so every
// query here is scoped to the runtime's configured chain + sealed-verdicts
// address.

import type Database from "better-sqlite3";

import {
  termsFromSnapshot,
  type CallTerms,
  type CallTermsSnapshot,
} from "./call-sale-terms.js";
import { entitlementsRepo } from "./repos/entitlements-repo.js";
import { effectiveCohortCap } from "./repos/agent-provider-terms-repo.js";
import { SCHEMA_VERSION } from "./schema.js";

export const SELLABLE_DEFAULT_LIMIT = 50;
export const SELLABLE_MAX_LIMIT = 200;

/** On-chain SubmissionClass 1. Only EarlyAccess calls can ever be granted. */
const SUBMISSION_CLASS_EARLY_ACCESS = 1;

export interface SellableCallsDeps {
  db: Database.Database;
  /** The deployment these rows must belong to. Null → nothing to sell here. */
  chain: { chainId: number; sealedVerdictsAddress: string | null } | null;
  /** Deployment-wide fallback terms for pre-070 rows; null when unconfigured. */
  legacyTerms: CallTerms | null;
  /** Sales close this many seconds before the market's submission close. */
  salesSafetySeconds: number;
  /**
   * Whether THIS daemon can actually take the money.
   *
   * Threaded from the daemon wiring rather than inferred, because the paid
   * route is mounted only when the grant runtime AND the settlement rail are
   * both configured. A storefront that advertised a buy button on a daemon
   * whose checkout answers 503 would be lying in the most expensive place.
   */
  purchaseAvailable: boolean;
  now: () => Date;
}

export interface SellableCallRow {
  onchain_call_id: string;
  agent: { slug: string; display_name: string };
  market: { market_id: string; question: string | null };
  price_atoms: string;
  currency: string;
  pricing_version: string;
  /** Owner's ceiling clamped by what this series can deliver; null if neither. */
  seats_cap: number | null;
  /**
   * Seats RESERVED, not seats sold.
   *
   * Counts every entitlement still on its way to a grant alongside those
   * already granted, because a reservation holds a seat from the moment a
   * purchase starts — that is what the cohort cap is enforced against. A buyer
   * reading this as "already delivered" would understate how full the call is
   * and could be refused at checkout after seeing free seats here.
   */
  seats_reserved: number;
  sale_closes_at: string;
  reveal_open_at: string;
}

export interface SellableCallsResponse {
  status: number;
  body: unknown;
}

interface SellableQueryRow extends CallTermsSnapshot {
  onchain_call_id: string;
  call_id: string;
  reveal_open_at: string;
  agent_slug: string;
  agent_display_name: string;
  market_id: string;
  question: string | null;
  provider_max_subscribers: number | null;
  series_max_armed_per_call: number;
  submission_close_at_ms: number;
}

// The `for sale` predicate mirrors termsFromSnapshot so LIMIT applies to rows
// that will actually be listed — filtering after the fact would silently
// shorten pages. The resolver is still the authority on the VALUES, and any
// row it unexpectedly refuses is dropped below.
const SELLABLE_SQL = `
  SELECT
    f.onchain_call_id                AS onchain_call_id,
    f.call_id                        AS call_id,
    f.reveal_open_at                 AS reveal_open_at,
    f.provider_price_atoms           AS provider_price_atoms,
    f.provider_currency              AS provider_currency,
    f.provider_pricing_version       AS provider_pricing_version,
    f.provider_terms_snapshotted     AS provider_terms_snapshotted,
    f.provider_max_subscribers       AS provider_max_subscribers,
    a.display_slug                   AS agent_slug,
    a.display_name                   AS agent_display_name,
    m.market_id                      AS market_id,
    pds.question                     AS question,
    ms.max_armed_per_call            AS series_max_armed_per_call,
    mc.submission_close_at_ms        AS submission_close_at_ms
  FROM fhenix_sealed_calls f
  JOIN submissions s    ON s.call_id = f.call_id
  JOIN agents a         ON a.agent_id = s.agent_id
  JOIN markets m        ON m.market_id = s.market_id
  JOIN market_clocks mc ON mc.market_id = s.market_id
  JOIN market_series ms ON ms.series_id = mc.series_id
  -- Human question text exists only for discovery-registered markets; a
  -- directly registered market legitimately has none, so this must not filter.
  LEFT JOIN polymarket_discovery_state pds ON pds.condition_id = s.market_id
  WHERE f.chain_id = @chain_id
    AND lower(f.contract_address) = lower(@contract_address)
    AND f.submission_class = @early_access
    AND f.reveal_status = 'pending'
    AND mc.submission_close_at_ms - @safety_ms > @now_ms
    AND (
      (f.provider_price_atoms IS NOT NULL
        AND f.provider_currency IS NOT NULL
        AND f.provider_pricing_version IS NOT NULL)
      OR (f.provider_terms_snapshotted != 1 AND @has_legacy_terms = 1)
    )
  -- sale_closes_at is submission_close_at_ms shifted by a constant, so ordering
  -- on the raw column is the same order without recomputing it per row.
  ORDER BY mc.submission_close_at_ms ASC, f.call_id ASC
  LIMIT @limit
`;

// Legacy rows this daemon cannot price. Counted, never listed: quoting the
// operator's price for a call sealed under terms nobody configured here would
// invent a number, and hiding them silently would make an empty storefront
// look like an empty market.
const EXCLUDED_LEGACY_SQL = `
  SELECT COUNT(*) AS n
  FROM fhenix_sealed_calls f
  JOIN submissions s    ON s.call_id = f.call_id
  JOIN markets m        ON m.market_id = s.market_id
  JOIN market_clocks mc ON mc.market_id = s.market_id
  WHERE f.chain_id = @chain_id
    AND lower(f.contract_address) = lower(@contract_address)
    AND f.submission_class = @early_access
    AND f.reveal_status = 'pending'
    AND mc.submission_close_at_ms - @safety_ms > @now_ms
    AND f.provider_terms_snapshotted != 1
    AND (f.provider_price_atoms IS NULL
      OR f.provider_currency IS NULL
      OR f.provider_pricing_version IS NULL)
`;

export function listSellableCallsResponse(
  deps: SellableCallsDeps,
  input: { limit?: number } = {},
): SellableCallsResponse {
  const limit = clamp(input.limit ?? SELLABLE_DEFAULT_LIMIT, 1, SELLABLE_MAX_LIMIT);
  const contractAddress = deps.chain?.sealedVerdictsAddress ?? null;
  if (!deps.chain || !contractAddress) {
    // Fail closed rather than list every deployment's rows. An unconfigured
    // contract means there is no deployment whose grants this daemon can honour.
    return {
      status: 503,
      body: {
        error: "FhenixDeploymentUnconfigured",
        message:
          "this daemon has no Fhenix chain + sealed-verdicts address configured, " +
          "so it cannot say which deployment's calls are for sale",
      },
    };
  }

  const params = {
    chain_id: deps.chain.chainId,
    contract_address: contractAddress,
    early_access: SUBMISSION_CLASS_EARLY_ACCESS,
    safety_ms: deps.salesSafetySeconds * 1000,
    now_ms: deps.now().getTime(),
  };
  const rows = deps.db
    .prepare(SELLABLE_SQL)
    .all({ ...params, has_legacy_terms: deps.legacyTerms ? 1 : 0, limit }) as SellableQueryRow[];

  const calls: SellableCallRow[] = [];
  for (const row of rows) {
    const terms = termsFromSnapshot(row, deps.legacyTerms);
    if (!terms) continue; // unreachable given the SQL predicate; resolver wins.
    const { cap } = effectiveCohortCap(
      row.provider_max_subscribers,
      row.series_max_armed_per_call,
    );
    calls.push({
      onchain_call_id: row.onchain_call_id,
      agent: { slug: row.agent_slug, display_name: row.agent_display_name },
      market: { market_id: row.market_id, question: row.question ?? null },
      price_atoms: terms.priceAtoms,
      currency: terms.currency,
      pricing_version: terms.pricingVersion,
      seats_cap: cap ?? null,
      seats_reserved: entitlementsRepo.countActiveForCall(deps.db, {
        chainId: deps.chain.chainId,
        contractAddress,
        onchainCallId: row.onchain_call_id,
      }),
      sale_closes_at: new Date(
        row.submission_close_at_ms - deps.salesSafetySeconds * 1000,
      ).toISOString(),
      reveal_open_at: row.reveal_open_at,
    });
  }

  const excludedLegacy = deps.legacyTerms
    ? 0
    : ((deps.db.prepare(EXCLUDED_LEGACY_SQL).get(params) as { n: number }).n ?? 0);

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      chain_id: deps.chain.chainId,
      contract_address: contractAddress,
      // Whether the buy flow exists on THIS daemon. False means every listed
      // row is informational: POST …/access answers 503 PaidAccessDisabled.
      purchase_available: deps.purchaseAvailable,
      legacy_terms_available: Boolean(deps.legacyTerms),
      excluded_legacy_unpriced: excludedLegacy,
      note:
        excludedLegacy > 0
          ? `${excludedLegacy} call(s) sealed before per-provider pricing are open but ` +
            `not listed: this daemon has no deployment-wide price configured ` +
            `(FHENIX_GRANT_PRICE_ATOMS / _CURRENCY / _PRICING_VERSION), and a price ` +
            `nobody set must not be quoted.`
          : null,
      calls,
      page: { limit, returned: calls.length },
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}
