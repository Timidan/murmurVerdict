// ─── Public storefront: sealed calls whose sale window is open ──────────────
//
//   GET /v2/gateway/calls/sellable
//
// Everything needed to render a buy list, and nothing a buyer should not see.
// No ciphertext handles, no rationale, no provider economics — a listed row is
// an OFFER: who is selling, for what market, at what price, until when, and
// how many seats are left.
//
// The price on every row here is a `locked_terms`: the snapshot frozen onto
// the call when it was sealed, which is what a buyer pays for THAT call. It is
// NOT the agent's standing listing — that is `current_terms` in
// `agent_provider_terms`, served by /v1/marketplace/listings, and it is what
// the NEXT call would cost. The two legitimately disagree the moment an owner
// reprices, so `agent_provider_terms` is deliberately NOT joined here: joining
// it would let a repricing rewrite the price of a call already on offer.
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

/** What a buyer can do with a listed row, right now, on THIS daemon. */
export type InventoryStatus = "available" | "full" | "checkout_unavailable";

/** The frozen terms this specific call is sold under. Never the standing listing. */
export interface LockedTerms {
  price_atoms: string;
  currency: string;
  pricing_version: string;
}

export interface SellableCallRow {
  onchain_call_id: string;
  agent: { slug: string; display_name: string };
  /** The seller's durable id, so a client can join to the catalog surface. */
  agent_id: string;
  market: { market_id: string; question: string | null };
  /**
   * The venue series this call's market belongs to, or null for a market
   * registered before/outside series linking (migration 075 leaves those NULL
   * rather than fabricating one).
   */
  venue_series_id: string | null;
  /** The snapshot. Authoritative for what checkout will charge. */
  locked_terms: LockedTerms;
  /**
   * Temporary compatibility aliases for `locked_terms`. Same values, kept
   * while existing clients migrate; they carry no independent meaning and will
   * be removed once nothing reads them.
   */
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
  /**
   * Seats a new buyer could still take: `seats_cap - seats_reserved`, floored
   * at 0. Null when there is no cap at all, which means "not limited here",
   * NOT "none left" — a client must not render null as zero.
   */
  seats_remaining: number | null;
  /**
   * available            — a seat exists and checkout is mounted here.
   * full                 — the cohort is fully reserved; nothing to sell.
   * checkout_unavailable — this daemon has no checkout, so EVERY row is
   *                        informational regardless of its seats. It dominates
   *                        `full` on purpose: when nothing can be bought, the
   *                        reason a buyer needs is the missing checkout, not
   *                        the seat count.
   */
  inventory_status: InventoryStatus;
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
  agent_id: string;
  market_id: string;
  venue_series_id: string | null;
  question: string | null;
  provider_max_subscribers: number | null;
  series_max_armed_per_call: number;
  submission_close_at_ms: number;
}

/**
 * Optional narrowing, all AND-ed together. Absent means "no restriction",
 * never "match nothing".
 */
export interface SellableFilters {
  /** Repeatable venue_series_id; the call's MARKET must belong to one. */
  venueSeriesIds?: readonly string[];
  /** Seller's public slug, matched case-insensitively. */
  agentSlug?: string | null;
}

function filterClauses(filters: SellableFilters): {
  sql: string;
  bind: Record<string, unknown>;
} {
  const clauses: string[] = [];
  const bind: Record<string, unknown> = {};
  const series = filters.venueSeriesIds ?? [];
  if (series.length > 0) {
    const names = series.map((_value, index) => `@series_${index}`);
    series.forEach((value, index) => {
      bind[`series_${index}`] = value;
    });
    clauses.push(`AND m.venue_series_id IN (${names.join(",")})`);
  }
  const slug = filters.agentSlug?.trim();
  if (slug) {
    // NOCASE so a caller who typed the slug with different casing still finds
    // the seller; slugs are canonically lowercase but URLs are not.
    clauses.push("AND a.display_slug = @agent_slug COLLATE NOCASE");
    bind["agent_slug"] = slug;
  }
  return { sql: clauses.join("\n    "), bind };
}

// The `for sale` predicate mirrors termsFromSnapshot so LIMIT applies to rows
// that will actually be listed — filtering after the fact would silently
// shorten pages. The resolver is still the authority on the VALUES, and any
// row it unexpectedly refuses is dropped below.
//
// Paging is KEYSET, not OFFSET, over the same (submission_close_at_ms, call_id)
// the ORDER BY uses. Calls are sealed continuously and the window closes
// continuously, so rows enter and leave the result set between requests; an
// OFFSET page would skip or repeat rows every time either happened. call_id
// breaks ties so the order is total and the cursor cannot stall.
function sellableSql(filters: SellableFilters): string {
  return `
  SELECT
    f.onchain_call_id                AS onchain_call_id,
    f.call_id                        AS call_id,
    f.reveal_open_at                 AS reveal_open_at,
    f.provider_price_atoms           AS provider_price_atoms,
    f.provider_currency              AS provider_currency,
    f.provider_pricing_version       AS provider_pricing_version,
    f.provider_terms_snapshotted     AS provider_terms_snapshotted,
    f.provider_max_subscribers       AS provider_max_subscribers,
    a.agent_id                       AS agent_id,
    a.display_slug                   AS agent_slug,
    a.display_name                   AS agent_display_name,
    m.market_id                      AS market_id,
    m.venue_series_id                AS venue_series_id,
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
    AND (
      @cursor_close_ms IS NULL
      OR mc.submission_close_at_ms > @cursor_close_ms
      OR (mc.submission_close_at_ms = @cursor_close_ms AND f.call_id > @cursor_call_id)
    )
    ${filterClauses(filters).sql}
  -- sale_closes_at is submission_close_at_ms shifted by a constant, so ordering
  -- on the raw column is the same order without recomputing it per row.
  ORDER BY mc.submission_close_at_ms ASC, f.call_id ASC
  LIMIT @limit
`;
}

// Legacy rows this daemon cannot price. Counted, never listed: quoting the
// operator's price for a call sealed under terms nobody configured here would
// invent a number, and hiding them silently would make an empty storefront
// look like an empty market.
//
// Scoped by the SAME filters as the listing. A count that ignored them would
// describe a different slice than the page it annotates, so a caller filtering
// to one series could be told about exclusions in another.
function excludedLegacySql(filters: SellableFilters): string {
  return `
  SELECT COUNT(*) AS n
  FROM fhenix_sealed_calls f
  JOIN submissions s    ON s.call_id = f.call_id
  JOIN agents a         ON a.agent_id = s.agent_id
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
    ${filterClauses(filters).sql}
`;
}

/** Opaque page token over the (submission_close_at_ms, call_id) sort key. */
function encodeCursor(closeAtMs: number, callId: string): string {
  return Buffer.from(`${closeAtMs}|${callId}`, "utf8").toString("base64url");
}

function parseCursor(
  raw: string | null | undefined,
): { closeAtMs: number; callId: string } | null | "invalid" {
  const value = raw?.trim();
  if (!value) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return "invalid";
  }
  // The call id may itself contain a separator, so split on the FIRST one:
  // the timestamp cannot.
  const separator = decoded.indexOf("|");
  if (separator <= 0) return "invalid";
  const closeAtMs = Number(decoded.slice(0, separator));
  const callId = decoded.slice(separator + 1);
  if (!Number.isSafeInteger(closeAtMs) || !callId) return "invalid";
  return { closeAtMs, callId };
}

export function listSellableCallsResponse(
  deps: SellableCallsDeps,
  input: {
    limit?: number;
    cursor?: string | null;
    venueSeriesIds?: readonly string[];
    agentSlug?: string | null;
  } = {},
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

  const cursor = parseCursor(input.cursor);
  if (cursor === "invalid") {
    return {
      status: 400,
      body: { error: "BadCursor", message: "cursor is not one this endpoint issued" },
    };
  }

  const filters: SellableFilters = {
    venueSeriesIds: input.venueSeriesIds ?? [],
    agentSlug: input.agentSlug ?? null,
  };
  const filterBind = filterClauses(filters).bind;
  const params = {
    chain_id: deps.chain.chainId,
    contract_address: contractAddress,
    early_access: SUBMISSION_CLASS_EARLY_ACCESS,
    safety_ms: deps.salesSafetySeconds * 1000,
    now_ms: deps.now().getTime(),
    ...filterBind,
  };
  const rows = deps.db.prepare(sellableSql(filters)).all({
    ...params,
    has_legacy_terms: deps.legacyTerms ? 1 : 0,
    cursor_close_ms: cursor?.closeAtMs ?? null,
    // Only read when cursor_close_ms is non-null, but better-sqlite3 binds
    // every named parameter in the statement, so it always needs a value.
    cursor_call_id: cursor?.callId ?? "",
    limit,
  }) as SellableQueryRow[];

  // ONE grouped read for the whole page. This was a query per listed row, so a
  // full page of 200 cost 200 round trips to answer a single question.
  const reserved = entitlementsRepo.countActiveForCalls(deps.db, {
    chainId: deps.chain.chainId,
    contractAddress,
    onchainCallIds: rows.map((row) => row.onchain_call_id),
  });

  const calls: SellableCallRow[] = [];
  for (const row of rows) {
    const terms = termsFromSnapshot(row, deps.legacyTerms);
    if (!terms) continue; // unreachable given the SQL predicate; resolver wins.
    const { cap } = effectiveCohortCap(
      row.provider_max_subscribers,
      row.series_max_armed_per_call,
    );
    const seatsCap = cap ?? null;
    const seatsReserved = reserved.get(row.onchain_call_id.toLowerCase()) ?? 0;
    const seatsRemaining = seatsCap === null ? null : Math.max(0, seatsCap - seatsReserved);
    calls.push({
      onchain_call_id: row.onchain_call_id,
      agent: { slug: row.agent_slug, display_name: row.agent_display_name },
      agent_id: row.agent_id,
      market: { market_id: row.market_id, question: row.question ?? null },
      venue_series_id: row.venue_series_id ?? null,
      locked_terms: {
        price_atoms: terms.priceAtoms,
        currency: terms.currency,
        pricing_version: terms.pricingVersion,
      },
      price_atoms: terms.priceAtoms,
      currency: terms.currency,
      pricing_version: terms.pricingVersion,
      seats_cap: seatsCap,
      seats_reserved: seatsReserved,
      seats_remaining: seatsRemaining,
      inventory_status: !deps.purchaseAvailable
        ? "checkout_unavailable"
        : seatsRemaining !== null && seatsRemaining <= 0
          ? "full"
          : "available",
      sale_closes_at: new Date(
        row.submission_close_at_ms - deps.salesSafetySeconds * 1000,
      ).toISOString(),
      reveal_open_at: row.reveal_open_at,
    });
  }

  const excludedLegacy = deps.legacyTerms
    ? 0
    : ((deps.db.prepare(excludedLegacySql(filters)).get(params) as { n: number }).n ?? 0);

  // Taken from the last SQL row, not the last projected call: a row the terms
  // resolver unexpectedly refuses is still a position in the keyset, and
  // skipping it in the cursor would replay it forever.
  const lastRow = rows.length === limit ? rows[rows.length - 1] : undefined;

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
      next_cursor: lastRow
        ? encodeCursor(lastRow.submission_close_at_ms, lastRow.call_id)
        : null,
      page: { limit, returned: calls.length },
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}
