// ─── Public marketplace catalog ─────────────────────────────────────────────
//
//   GET /v1/marketplace/listings
//
// Public and unauthenticated: an offer nobody can see is not an offer.
// Authentication belongs at checkout, where money changes hands, not at
// discovery.
//
// The response is NORMALIZED — series metadata is returned once in its own
// array rather than copied onto every listing. A shape that inlined the series
// title and category would grow by a property per market as venues are added,
// and would tempt a client to key on the copied title instead of the durable
// `venue_series_id`.
//
// Every price on this surface is a `current_terms` — the agent's STANDING
// listing, i.e. what the next sealed call would cost. It is not, and must
// never be presented as, the `locked_terms` a buyer pays for a call already
// sealed. See `marketplace-listings-query.ts` and `call-sale-terms.ts`.

import type Database from "better-sqlite3";

import { getLeaderboardRowsForAgentIds } from "./leaderboard.js";
import {
  queryMarketplaceListingCells,
  queryMarketplaceSeries,
  type MarketplaceListingCell,
  type MarketplaceListingFilters,
  type MarketplaceSeriesRow,
} from "./marketplace-listings-query.js";
import { SCHEMA_VERSION, type LeaderboardTier } from "./schema.js";
import { nowIso } from "./time.js";

export interface MarketplaceListingsDeps {
  db: Database.Database;
  now: () => Date;
}

/**
 * The agent's ALL-TIME, GLOBAL record — the same one `/v1/leaderboard`
 * publishes, read through the batched leaderboard seam so there is exactly one
 * scoring path.
 *
 * It is NOT per-series, and nothing here may imply that it is. An agent
 * selling three series carries one record across all of them; a per-series
 * reputation would need per-series scoring, which does not exist.
 */
export interface MarketplaceTrackRecord {
  /** null when the agent has no leaderboard row at all — see `unscored`. */
  tier: LeaderboardTier | null;
  rank: number | null;
  verdict_score: number | null;
  verdict_score_lb: number | null;
  resolved_calls: number;
  win_rate: number | null;
  marketplace_eligible: boolean;
}

export interface MarketplaceCurrentTerms {
  price_atoms: string;
  currency: string;
  pricing_version: string;
  max_subscribers_per_call: number | null;
  updated_at: string;
}

export interface MarketplaceListing {
  venue_series_id: string;
  /** The STANDING price. Never a sealed call's locked snapshot. */
  current_terms: MarketplaceCurrentTerms;
}

export interface MarketplaceAgent {
  agent_id: string;
  display_slug: string;
  display_name: string;
  track_record: MarketplaceTrackRecord;
  listings: MarketplaceListing[];
}

export interface MarketplaceListingsBody {
  schema_version: typeof SCHEMA_VERSION;
  served_at: string;
  series: MarketplaceSeriesRow[];
  agents: MarketplaceAgent[];
}

export interface MarketplaceListingsResponse {
  status: number;
  body: MarketplaceListingsBody | { error: string; message: string };
}

/**
 * A seller with no leaderboard row has never submitted a call.
 *
 * That is provable rather than assumed: the global board covers every kind a
 * listing can belong to (`agent`, `attested`), so within the listable set
 * absence from the board and "no scoring facts" are the same condition. The
 * factual zero is reported as zero; everything that would require a score is
 * null. Marketplace eligibility is false because it requires a minimum
 * resolved-call count this agent provably does not meet.
 */
const UNSCORED: MarketplaceTrackRecord = {
  tier: null,
  rank: null,
  verdict_score: null,
  verdict_score_lb: null,
  resolved_calls: 0,
  win_rate: null,
  marketplace_eligible: false,
};

export function marketplaceListingsResponse(
  deps: MarketplaceListingsDeps,
  filters: MarketplaceListingFilters,
): MarketplaceListingsResponse {
  const series = queryMarketplaceSeries(deps.db, filters.series);
  const cells = queryMarketplaceListingCells(deps.db, filters);

  // ONE leaderboard pass for every seller on the page. Asking per agent would
  // recompute the whole global board once per agent.
  const agentIds = [...new Set(cells.map((cell) => cell.agent_id))];
  const records = getLeaderboardRowsForAgentIds(deps.db, agentIds);

  const agents: MarketplaceAgent[] = [];
  let openAgent: MarketplaceAgent | null = null;
  let openAgentId: string | null = null;
  let keepOpenAgent = false;
  // The query already orders by (lower(display_slug), agent_id, venue,
  // series_slug), so cells for one agent are contiguous and the response
  // ordering is the SQL's, not a re-sort that could disagree with it.
  for (const cell of cells) {
    if (openAgentId !== cell.agent_id) {
      const row = records.get(cell.agent_id);
      const track: MarketplaceTrackRecord = row
        ? {
            tier: row.tier,
            rank: row.rank,
            verdict_score: row.verdict_score,
            verdict_score_lb: row.verdict_score_lb,
            resolved_calls: row.resolved_calls,
            win_rate: row.win_rate,
            marketplace_eligible: row.marketplace_eligible,
          }
        : UNSCORED;
      openAgent = {
        agent_id: cell.agent_id,
        display_slug: cell.display_slug,
        display_name: cell.display_name,
        track_record: track,
        listings: [],
      };
      openAgentId = cell.agent_id;
      keepOpenAgent = meetsTrackFloors(track, filters);
      if (keepOpenAgent) agents.push(openAgent);
    }
    if (keepOpenAgent && openAgent) openAgent.listings.push(toListing(cell));
  }

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      served_at: nowIso(deps.now()),
      series,
      agents,
    },
  };
}

/**
 * Track-record floors are per AGENT, not per listing.
 *
 * `min_score_floor` is checked against `verdict_score_lb`, the 95% lower
 * bound, never the raw score: a caller filtering on quality wants 200 stable
 * calls, not 20 lucky ones. An unscored seller has no lower bound and is
 * therefore excluded by a floor — absent a score, it cannot be shown to clear
 * one. Without the filter they are listed, with nulls.
 */
function meetsTrackFloors(
  track: MarketplaceTrackRecord,
  filters: MarketplaceListingFilters,
): boolean {
  if (filters.minResolvedCalls !== null && track.resolved_calls < filters.minResolvedCalls) {
    return false;
  }
  if (filters.minScoreFloor !== null) {
    if (track.verdict_score_lb === null) return false;
    if (track.verdict_score_lb < filters.minScoreFloor) return false;
  }
  return true;
}

function toListing(cell: MarketplaceListingCell): MarketplaceListing {
  return {
    venue_series_id: cell.venue_series_id,
    current_terms: {
      price_atoms: cell.price_atoms,
      currency: cell.currency,
      pricing_version: cell.pricing_version,
      max_subscribers_per_call: cell.max_subscribers_per_call,
      updated_at: cell.updated_at,
    },
  };
}
