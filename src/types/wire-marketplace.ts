// Shared REST wire types — the two PUBLIC marketplace surfaces.
//
// Browser-safe; see wire-agent.ts for the rules. Producer guards in
// src/verdict/wire-contract-guards.ts pin these against the daemon's
// authoritative types.
//
// TWO PRICES EXIST HERE AND THEY MAY LEGITIMATELY DISAGREE. The type names are
// the whole defence, so nothing downstream may collapse them into "price":
//
//   current_terms — GET /v1/marketplace/listings. The agent's STANDING listing:
//                   what the NEXT call they seal in this series would cost. The
//                   owner reprices it whenever they like.
//   locked_terms  — GET /v2/gateway/calls/sellable. The snapshot frozen onto an
//                   ALREADY-SEALED call: what a buyer actually pays for THAT
//                   call, whatever the standing listing has since become.
//
// A UI that shows a `current_terms` beside a buy affordance for a call sealed
// at a different `locked_terms` is quoting a price the checkout will not honour.
// See src/verdict/marketplace-listings-query.ts for why the daemon never joins
// the two.

import type { WireLeaderboardTier } from "./wire-leaderboard.js";

/* ── GET /v1/marketplace/listings ─────────────────────────────────────────── */

/**
 * A venue series, returned ONCE per response rather than copied onto every
 * listing. A series with no sellers still appears: an empty aisle is
 * information, and hiding it would make a supported venue look unsupported.
 */
export interface WireMarketplaceSeries {
  venue_series_id: string;
  venue: string;
  series_slug: string;
  series_title: string;
  venue_category: string | null;
}

/**
 * The agent's ALL-TIME, GLOBAL record — the same one /v1/leaderboard publishes.
 *
 * It is NOT per-series and nothing rendering it may imply that it is: an agent
 * selling three series carries one record across all of them. A seller who has
 * never had a call resolve carries the honest nulls (`tier`, `rank`, both
 * scores, `win_rate`) with a factual `resolved_calls: 0` — that is an UNSCORED
 * agent, not a missing one, and it must render rather than be filtered away.
 */
export interface WireMarketplaceTrackRecord {
  tier: WireLeaderboardTier | null;
  rank: number | null;
  verdict_score: number | null;
  /** The lower bound. Quality filters read THIS, never the raw score. */
  verdict_score_lb: number | null;
  resolved_calls: number;
  win_rate: number | null;
  marketplace_eligible: boolean;
}

/** The STANDING listing. Never a sealed call's frozen snapshot. */
export interface WireMarketplaceCurrentTerms {
  /** Atomic units as a decimal string — routinely past Number.MAX_SAFE_INTEGER. */
  price_atoms: string;
  currency: string;
  pricing_version: string;
  /** The owner's ceiling; null means "as many as murmur can serve". */
  max_subscribers_per_call: number | null;
  updated_at: string;
}

export interface WireMarketplaceListing {
  venue_series_id: string;
  current_terms: WireMarketplaceCurrentTerms;
}

export interface WireMarketplaceAgent {
  agent_id: string;
  display_slug: string;
  display_name: string;
  track_record: WireMarketplaceTrackRecord;
  listings: WireMarketplaceListing[];
}

/**
 * The catalog. `series` and `agents` are independent dimensions on purpose —
 * joining them client-side is what produces the browse matrix, and it is the
 * only way a column with zero sellers survives to be drawn.
 */
export interface WireMarketplaceListings {
  schema_version: number;
  served_at: string;
  series: WireMarketplaceSeries[];
  agents: WireMarketplaceAgent[];
}

/* ── GET /v2/gateway/calls/sellable ───────────────────────────────────────── */

/**
 * What a buyer can do with a listed row, right now, on THIS daemon.
 *
 * `checkout_unavailable` dominates `full`: when nothing can be bought at all,
 * the reason a buyer needs is the missing checkout, not the seat count.
 */
export type WireInventoryStatus = "available" | "full" | "checkout_unavailable";

/** The frozen terms THIS call is sold under. Authoritative for what checkout charges. */
export interface WireLockedTerms {
  price_atoms: string;
  currency: string;
  pricing_version: string;
}

export interface WireSellableCall {
  onchain_call_id: string;
  agent: { slug: string; display_name: string };
  /** The seller's durable id, so a client can join to the catalog surface. */
  agent_id: string;
  market: { market_id: string; question: string | null };
  /** null for a market registered before/outside series linking. */
  venue_series_id: string | null;
  locked_terms: WireLockedTerms;
  /** Owner's ceiling clamped by what the series can deliver; null if neither. */
  seats_cap: number | null;
  /** Seats RESERVED, not seats sold — a reservation holds a seat from checkout. */
  seats_reserved: number;
  /**
   * Seats a new buyer could still take. Null means "not limited here", NOT
   * "none left" — a client must never render null as zero.
   */
  seats_remaining: number | null;
  inventory_status: WireInventoryStatus;
  sale_closes_at: string;
  reveal_open_at: string;
}

/**
 * Per-call inventory. An EMPTY `calls` array is the normal resting state, not
 * an error: markets roll on a five-minute clock and most of that clock has
 * nothing sealed inside it. The catalog above stands whether or not this is
 * empty, which is exactly why the two are fetched separately.
 */
export interface WireSellableCalls {
  schema_version: number;
  chain_id: number;
  contract_address: string;
  /**
   * Whether the buy flow exists on THIS daemon. False means every listed row is
   * informational: checkout answers 503. Distinct from an empty `calls` array
   * and from a failed request, and a UI must say which of the three it hit.
   */
  purchase_available: boolean;
  legacy_terms_available: boolean;
  /** Open calls sealed before per-provider pricing, counted but not listed. */
  excluded_legacy_unpriced: number;
  note: string | null;
  calls: WireSellableCall[];
  next_cursor: string | null;
  page: { limit: number; returned: number };
}
