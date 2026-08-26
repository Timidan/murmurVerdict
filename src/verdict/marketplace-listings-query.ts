// ─── The durable marketplace catalog: who is selling what, right now ────────
//
// The read behind `GET /v1/marketplace/listings`. It answers a question no
// per-call inventory query can: "which agents sell which series, and at what
// standing price" — even when not a single call is currently open.
//
// TWO PRICES EXIST AND THEY MAY DISAGREE. This module only ever reads the
// first, and names it so nothing downstream can confuse them:
//
//   current_terms — the standing listing in `agent_provider_terms`. What the
//                   NEXT sealed call from this agent in this series would cost.
//                   Mutable: the owner reprices whenever they like.
//   locked_terms  — the frozen snapshot on an ALREADY-SEALED call
//                   (`fhenix_sealed_calls.provider_*`). What a buyer actually
//                   pays for THAT call. Resolved by `call-sale-terms.ts`.
//
// So `agent_provider_terms` is deliberately absent from the sellable-call
// query, and `fhenix_sealed_calls` is deliberately absent from this one. A
// join either way would let a repricing rewrite the price of a call already on
// offer, which is the single most expensive bug this surface can have.
//
// The catalog starts from `agent_provider_terms`, NOT from registrations: a
// registration without terms means "serves this series, is not selling it",
// and that is not a listing.

import type Database from "better-sqlite3";

/**
 * Kinds that can carry a storefront listing. `benchmark` agents are murmur's
 * own anchor rows and `internal_test` is QA — neither is marketplace-eligible,
 * so neither may appear as a seller. Matches the marketplace exclusion the
 * leaderboard already applies via `marketplace_eligible`.
 */
const LISTABLE_AGENT_KINDS = ["agent", "attested"] as const;

/** A venue series, returned ONCE per response rather than per listing cell. */
export interface MarketplaceSeriesRow {
  venue_series_id: string;
  venue: string;
  series_slug: string;
  series_title: string;
  venue_category: string | null;
}

/** One (agent, series) listing as it stands in the database. */
export interface MarketplaceListingCell {
  agent_id: string;
  display_slug: string;
  display_name: string;
  venue_series_id: string;
  price_atoms: string;
  currency: string;
  pricing_version: string;
  max_subscribers_per_call: number | null;
  updated_at: string;
}

export interface MarketplaceListingFilters {
  /** Repeatable `series=`; empty means every series. */
  series: string[];
  /**
   * Price bounds in ATOMS, compared as BigInt.
   *
   * Atoms are TEXT and routinely exceed Number.MAX_SAFE_INTEGER, so neither
   * `CAST(price_atoms AS INTEGER)` in SQLite (a 64-bit float round-trip) nor
   * `Number(...)` in JS can be used to compare them. Both bounds are
   * inclusive.
   */
  minListPriceAtoms: bigint | null;
  maxListPriceAtoms: bigint | null;
  /** Track-record floors, applied per AGENT against the all-time record. */
  minResolvedCalls: number | null;
  /** Floor on verdict_score_lb, the lower bound — never the raw score. */
  minScoreFloor: number | null;
}

export const NO_MARKETPLACE_FILTERS: MarketplaceListingFilters = {
  series: [],
  minListPriceAtoms: null,
  maxListPriceAtoms: null,
  minResolvedCalls: null,
  minScoreFloor: null,
};

export interface MarketplaceFilterProblem {
  error: string;
  message: string;
}

export type MarketplaceFilterParse =
  | { ok: true; filters: MarketplaceListingFilters }
  | { ok: false; problem: MarketplaceFilterProblem };

/**
 * Parse the query string into filters, or say precisely what was wrong.
 *
 * Malformed input is REJECTED, never silently dropped: a caller who asked for
 * `min_list_price_atoms=1e9` and received the unfiltered catalog would read it
 * as "everything is under a thousand dollars".
 */
export function parseMarketplaceListingFilters(
  query: Record<string, unknown> | undefined,
): MarketplaceFilterParse {
  const series = repeatableStrings(query?.["series"]);
  for (const value of series) {
    if (value.length > 128) {
      return bad("BadSeriesFilter", `series value is too long: "${value.slice(0, 32)}…"`);
    }
  }

  const minPrice = atomsParam(query?.["min_list_price_atoms"], "min_list_price_atoms");
  if ("problem" in minPrice) return { ok: false, problem: minPrice.problem };
  const maxPrice = atomsParam(query?.["max_list_price_atoms"], "max_list_price_atoms");
  if ("problem" in maxPrice) return { ok: false, problem: maxPrice.problem };
  if (
    minPrice.value !== null &&
    maxPrice.value !== null &&
    minPrice.value > maxPrice.value
  ) {
    return bad(
      "BadPriceRange",
      "min_list_price_atoms is greater than max_list_price_atoms, which can never match",
    );
  }

  const minResolved = nonNegativeIntParam(query?.["min_resolved_calls"], "min_resolved_calls");
  if ("problem" in minResolved) return { ok: false, problem: minResolved.problem };
  const minScore = finiteNumberParam(query?.["min_score_floor"], "min_score_floor");
  if ("problem" in minScore) return { ok: false, problem: minScore.problem };

  return {
    ok: true,
    filters: {
      series,
      minListPriceAtoms: minPrice.value,
      maxListPriceAtoms: maxPrice.value,
      minResolvedCalls: minResolved.value,
      minScoreFloor: minScore.value,
    },
  };
}

/**
 * The series dimension of the response.
 *
 * Returned independently of the listing cells so the wire stays normalized —
 * a per-listing copy of the title and category would grow the payload by a
 * property per market and invite the dashboard to key on the wrong thing. A
 * series with no sellers still appears: an empty aisle is information, and
 * hiding it would make a new venue look unsupported.
 */
export function queryMarketplaceSeries(
  db: Database.Database,
  series: readonly string[],
): MarketplaceSeriesRow[] {
  const scoped = series.length > 0;
  const sql =
    `SELECT venue_series_id, venue, series_slug, series_title, venue_category
       FROM venue_market_series` +
    (scoped ? ` WHERE venue_series_id IN (${placeholders(series.length)})` : "") +
    ` ORDER BY venue, series_slug`;
  return db.prepare(sql).all(...(scoped ? series : [])) as MarketplaceSeriesRow[];
}

/**
 * Every standing listing, ordered so the response is stable across calls.
 *
 * `markets` and `fhenix_sealed_calls` are NOT joined. This surface describes a
 * standing offer, which exists whether or not an instance of the series is
 * currently open; joining live inventory would make the catalog blink in and
 * out with the 5-minute market clock.
 *
 * Unbounded on purpose: the row count is (sellers × series they sell), which
 * IS the marketplace. Bounding it would mean silently omitting sellers.
 */
export function queryMarketplaceListingCells(
  db: Database.Database,
  filters: MarketplaceListingFilters,
): MarketplaceListingCell[] {
  const scoped = filters.series.length > 0;
  const sql = `
    SELECT
      t.agent_id                 AS agent_id,
      a.display_slug             AS display_slug,
      a.display_name             AS display_name,
      t.venue_series_id          AS venue_series_id,
      t.price_atoms              AS price_atoms,
      t.currency                 AS currency,
      t.pricing_version          AS pricing_version,
      t.max_subscribers_per_call AS max_subscribers_per_call,
      t.updated_at               AS updated_at
    FROM agent_provider_terms t
    JOIN agent_market_registrations r
      ON r.agent_id = t.agent_id
     AND r.venue_series_id = t.venue_series_id
    JOIN agents a
      ON a.agent_id = t.agent_id
    JOIN venue_market_series v
      ON v.venue_series_id = t.venue_series_id
    WHERE a.retired_at IS NULL
      AND a.kind IN (${placeholders(LISTABLE_AGENT_KINDS.length)})
      ${scoped ? `AND t.venue_series_id IN (${placeholders(filters.series.length)})` : ""}
    ORDER BY lower(a.display_slug), a.agent_id, v.venue, v.series_slug
  `;
  const rows = db
    .prepare(sql)
    .all(...LISTABLE_AGENT_KINDS, ...(scoped ? filters.series : [])) as MarketplaceListingCell[];

  if (filters.minListPriceAtoms === null && filters.maxListPriceAtoms === null) {
    return rows;
  }
  // Price bounds are applied HERE, in BigInt, not in SQL. See the field docs.
  return rows.filter((row) => {
    const atoms = safeAtoms(row.price_atoms);
    if (atoms === null) return false;
    if (filters.minListPriceAtoms !== null && atoms < filters.minListPriceAtoms) return false;
    if (filters.maxListPriceAtoms !== null && atoms > filters.maxListPriceAtoms) return false;
    return true;
  });
}

function safeAtoms(raw: string): bigint | null {
  return /^[0-9]+$/.test(raw) ? BigInt(raw) : null;
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

function repeatableStrings(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function firstString(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

function bad(error: string, message: string): { ok: false; problem: MarketplaceFilterProblem } {
  return { ok: false, problem: { error, message } };
}

function atomsParam(
  raw: unknown,
  name: string,
): { value: bigint | null } | { problem: MarketplaceFilterProblem } {
  const value = firstString(raw)?.trim();
  if (!value) return { value: null };
  if (!/^[0-9]+$/.test(value)) {
    return {
      problem: {
        error: "BadPriceFilter",
        message:
          `${name} must be a decimal integer number of atoms with no sign, ` +
          `decimal point, or exponent (got "${value}")`,
      },
    };
  }
  return { value: BigInt(value) };
}

function nonNegativeIntParam(
  raw: unknown,
  name: string,
): { value: number | null } | { problem: MarketplaceFilterProblem } {
  const value = firstString(raw)?.trim();
  if (!value) return { value: null };
  if (!/^[0-9]+$/.test(value)) {
    return {
      problem: {
        error: "BadTrackRecordFilter",
        message: `${name} must be a non-negative integer (got "${value}")`,
      },
    };
  }
  return { value: Number(value) };
}

function finiteNumberParam(
  raw: unknown,
  name: string,
): { value: number | null } | { problem: MarketplaceFilterProblem } {
  const value = firstString(raw)?.trim();
  if (!value) return { value: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return {
      problem: {
        error: "BadTrackRecordFilter",
        message: `${name} must be a finite number (got "${value}")`,
      },
    };
  }
  return { value: parsed };
}
