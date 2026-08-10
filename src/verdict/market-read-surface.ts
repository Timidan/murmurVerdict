import type Database from "better-sqlite3";
import {
  agentsRepo,
} from "./repos/agents-repo.js";
import {
  marketsRepo,
} from "./repos/market-registry-repo.js";
import {
  getAgentMarketGrid,
  getCrossFamilyLeaderboard,
  getLeaderboardForFamily,
  getLeaderboardForMarket,
  getLeaderboardForMarkets,
} from "./leaderboard.js";
import {
  marketTaxonomyResponse,
} from "./market-taxonomy.js";
import {
  type MarketCallsReadQuery,
  type MarketLeaderboardReadQuery,
  type MarketRegistryListQuery,
} from "./market-read-query.js";
import {
  enrichedMarketRegistryRow,
  type EnrichedMarketRegistryRow,
} from "./market-registry-public.js";
import {
  listPublicMarketCallProjections,
} from "./sealed-call-public-projection.js";
import {
  ERROR_CODES,
  MarketIdSchema,
  SCHEMA_VERSION,
  VerdictError,
} from "./schema.js";
import { nowIso } from "./time.js";
import type {
  MarketVenueSnapshot,
  MarketVenueSnapshotAdapter,
} from "../markets/polymarket-gamma/venue-snapshot.js";

export interface MarketReadInput {
  db: Database.Database;
  servedAt: Date;
}

export interface MarketReadProjectionInput {
  servedAt: Date;
}

export interface MarketReadResult {
  status: number;
  body: unknown;
}

export interface MarketReadJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendMarketReadJsonResponse(
  res: MarketReadJsonResponseTarget,
  result: MarketReadResult,
): void {
  res.status(result.status).json(result.body);
}

const missingMarketBody = {
  code: "market_not_found",
  message: "market not found",
} as const;

/**
 * The market's immutable schedule snapshot, as the public read surface states
 * it. Milliseconds, exactly as stored — the dashboard renders them in the
 * viewer's own timezone, and rounding to seconds here would put a window
 * boundary a fraction on the wrong side of a countdown.
 *
 * Present only on markets that were bound to a series. A market with no clock
 * has no submission window at all, which is a different thing from a window
 * that has passed, so the key is absent rather than null-filled.
 */
export interface MarketClockSnapshot {
  series_id: string;
  /** Arming closes; the venue window has not opened yet. */
  arm_close_at_ms: number;
  submission_open_at_ms: number;
  early_access_cutoff_at_ms: number;
  /** Submissions stop. The venue's own price window starts here. */
  submission_close_at_ms: number;
  /** The venue determines the outcome. */
  resolution_at_ms: number;
  /** Murmur unseals. Strictly later than resolution by the series embargo. */
  public_reveal_at_ms: number;
}

export type VenueEnrichedMarketRegistryRow = EnrichedMarketRegistryRow & {
  venue?: MarketVenueSnapshot;
  clock?: MarketClockSnapshot;
};

interface MarketClockDbRow extends MarketClockSnapshot {
  market_id: string;
}

/**
 * SQLite's compiled-in parameter ceiling is 999 on older builds. A page can
 * exceed it (every frozen market is a valid read), so the id list is chunked
 * rather than assumed small.
 */
const CLOCK_ID_CHUNK = 900;

/**
 * Stamp each row's schedule snapshot on, keyed to the ids on THIS page.
 *
 * It used to `SELECT … FROM market_clocks` with no WHERE clause, on the
 * reasoning that the table is small. It is insert-only — one row per market
 * ever scheduled, never deleted — so "small" is a statement about today, and
 * the cost lands on every list and detail request, growing forever. Bounding
 * the read by the page's own ids costs nothing (`market_id` is the table's
 * PRIMARY KEY, so each probe is an index seek) and stops the query scaling
 * with archive size instead of page size.
 *
 * Markets with no snapshot come back untouched (no `clock` key), which is every
 * market discovery froze before listing.
 */
function attachClockSnapshots<T extends { market_id: string }>(
  db: Database.Database,
  rows: T[],
): Array<T & { clock?: MarketClockSnapshot }> {
  if (rows.length === 0) return rows;
  const ids = [...new Set(rows.map((row) => row.market_id))];
  const byMarket = new Map<string, MarketClockSnapshot>();
  for (let i = 0; i < ids.length; i += CLOCK_ID_CHUNK) {
    const chunk = ids.slice(i, i + CLOCK_ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const clocks = db
      .prepare(
        `SELECT market_id, series_id, arm_close_at_ms, submission_open_at_ms,
                early_access_cutoff_at_ms, submission_close_at_ms,
                resolution_at_ms, public_reveal_at_ms
           FROM market_clocks
          WHERE market_id IN (${placeholders})`,
      )
      .all(...chunk) as MarketClockDbRow[];
    for (const { market_id, ...clock } of clocks) byMarket.set(market_id, clock);
  }
  return rows.map((row) => {
    const clock = byMarket.get(row.market_id);
    return clock ? { ...row, clock } : row;
  });
}

function enrichedMarketRows(input: MarketReadInput & {
  query: MarketRegistryListQuery;
}): Array<EnrichedMarketRegistryRow & { clock?: MarketClockSnapshot }> {
  let markets = marketsRepo.list(input.db, input.query.status);
  if (input.query.assetId) {
    markets = markets.filter((m) => m.asset_id === input.query.assetId);
  }
  return attachClockSnapshots(
    input.db,
    markets.map((market) => enrichedMarketRegistryRow(market, { db: input.db })),
  );
}

/**
 * Stamp the venue live snapshot onto venue-adapter rows. Native rows come
 * back untouched (no `venue` key). The Adapter is budget-bounded and
 * fail-soft by contract, so list/detail reads never block or fail on
 * upstream venue trouble.
 */
async function attachVenueSnapshots(
  rows: Array<EnrichedMarketRegistryRow & { clock?: MarketClockSnapshot }>,
  venue: MarketVenueSnapshotAdapter | undefined,
): Promise<VenueEnrichedMarketRegistryRow[]> {
  if (!venue) return rows;
  return Promise.all(
    rows.map(async (row) => {
      const snapshot = await venue.venueForMarket(row);
      return snapshot ? { ...row, venue: snapshot } : row;
    }),
  );
}

export function listMarketsSurface(input: MarketReadInput & {
  query: MarketRegistryListQuery;
}): MarketReadResult {
  return {
    status: 200,
    body: {
      markets: enrichedMarketRows(input),
      taxonomy: marketTaxonomyResponse(),
      served_at: nowIso(input.servedAt),
    },
  };
}

/** `/v1/markets` — the list surface plus venue live snapshots. */
export async function listMarketsWithVenueSurface(input: MarketReadInput & {
  query: MarketRegistryListQuery;
  venue?: MarketVenueSnapshotAdapter;
}): Promise<MarketReadResult> {
  const markets = await attachVenueSnapshots(
    enrichedMarketRows(input),
    input.venue,
  );
  return {
    status: 200,
    body: {
      markets,
      taxonomy: marketTaxonomyResponse(),
      served_at: nowIso(input.servedAt),
    },
  };
}

/** `GET /v1/markets/:market_id` — one row, same shape as the list rows. */
export async function marketDetailSurface(input: MarketReadInput & {
  marketId: string;
  venue?: MarketVenueSnapshotAdapter;
}): Promise<MarketReadResult> {
  const market_id = parseMarketIdParam(input.marketId);
  const market = marketsRepo.get(input.db, market_id);
  if (!market) {
    return { status: 404, body: missingMarketBody };
  }
  const [row] = await attachVenueSnapshots(
    attachClockSnapshots(input.db, [
      enrichedMarketRegistryRow(market, { db: input.db }),
    ]),
    input.venue,
  );
  return {
    status: 200,
    body: {
      market: row,
      served_at: nowIso(input.servedAt),
    },
  };
}

/** `GET /v1/markets/:market_id/calls` — recent calls, newest first. */
export function marketCallsSurface(input: MarketReadInput & {
  marketId: string;
  query: MarketCallsReadQuery;
}): MarketReadResult {
  const market_id = parseMarketIdParam(input.marketId);
  const market = marketsRepo.get(input.db, market_id);
  if (!market) {
    return { status: 404, body: missingMarketBody };
  }
  const calls = listPublicMarketCallProjections({
    db: input.db,
    market_id: market.market_id,
    limit: input.query.limit,
  });
  return {
    status: 200,
    body: {
      market_id: market.market_id,
      calls,
      served_at: nowIso(input.servedAt),
    },
  };
}

function parseMarketIdParam(marketId: string): string {
  const parsed = MarketIdSchema.safeParse(marketId);
  if (!parsed.success) {
    throw new VerdictError(
      "invalid market_id",
      ERROR_CODES.schema_invalid,
      400,
      { market_id: marketId },
    );
  }
  return parsed.data;
}

export function marketTaxonomySurface(
  input: MarketReadProjectionInput,
): MarketReadResult {
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      served_at: nowIso(input.servedAt),
      taxonomy: marketTaxonomyResponse(),
    },
  };
}

export function marketLeaderboardSurface(input: MarketReadInput & {
  marketId: string;
  query: MarketLeaderboardReadQuery;
}): MarketReadResult {
  const parsed = MarketIdSchema.safeParse(input.marketId);
  if (!parsed.success) {
    throw new VerdictError(
      "invalid market_id",
      ERROR_CODES.schema_invalid,
      400,
      { market_id: input.marketId },
    );
  }
  const market_id = parsed.data;

  const market = marketsRepo.get(input.db, market_id);
  if (!market) {
    return {
      status: 404,
      body: { error: "unknown_market" },
    };
  }

  const agents = getLeaderboardForMarket(input.db, {
    market_id,
    ...input.query,
  });
  return {
    status: 200,
    body: {
      market_id,
      agents,
      served_at: nowIso(input.servedAt),
    },
  };
}

/**
 * `GET /v1/markets/grid` — batched per-market top rows for the markets grid.
 * ONE facts read across every market replaces the grid's former N per-market
 * `/leaderboard` round-trips. `limit` caps rows PER MARKET (the grid uses 3).
 * Only markets with scoring calls appear; the grid defaults absent markets to
 * an empty top-3.
 */
export function marketsGridSurface(input: MarketReadInput & {
  query: MarketLeaderboardReadQuery;
}): MarketReadResult {
  return {
    status: 200,
    body: {
      markets: getLeaderboardForMarkets(input.db, {
        limitPerMarket: input.query.limit,
        ...(input.query.tier ? { tier: input.query.tier } : {}),
      }),
      served_at: nowIso(input.servedAt),
    },
  };
}

export function agentMarketGridSurface(input: MarketReadInput & {
  slug: string;
}): MarketReadResult {
  const agent = agentsRepo.bySlug(input.db, input.slug);
  if (!agent) {
    return {
      status: 404,
      body: { error: "unknown_agent" },
    };
  }
  const grid = getAgentMarketGrid(input.db, agent.agent_id);
  return {
    status: 200,
    body: {
      agent: {
        agent_id: agent.agent_id,
        display_slug: agent.display_slug,
        display_name: agent.display_name,
        kind: agent.kind,
      },
      grid,
      served_at: nowIso(input.servedAt),
    },
  };
}

export function familyLeaderboardSurface(input: MarketReadInput & {
  family: string;
  query: MarketLeaderboardReadQuery;
}): MarketReadResult {
  if (!input.family.match(/^[a-z0-9-]{2,64}$/)) {
    throw new VerdictError(
      "invalid family — lowercase-alphanumeric-and-dashes, 2-64 chars",
      ERROR_CODES.schema_invalid,
      400,
      { family: input.family },
    );
  }
  const agents = getLeaderboardForFamily(input.db, {
    market_family: input.family,
    ...input.query,
  });
  return {
    status: 200,
    body: {
      market_family: input.family,
      agents,
      served_at: nowIso(input.servedAt),
    },
  };
}

export function familiesSurface(input: MarketReadInput): MarketReadResult {
  const rows = input.db
    .prepare(
      `SELECT s.market_family AS family,
              COUNT(*) AS submissions,
              SUM(CASE WHEN r.outcome IS NOT NULL THEN 1 ELSE 0 END) AS resolved
         FROM submissions s
         LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
        WHERE s.market_family IS NOT NULL
     GROUP BY s.market_family
     ORDER BY submissions DESC`,
    )
    .all() as Array<{
    family: string;
    submissions: number;
    resolved: number;
  }>;
  return {
    status: 200,
    body: {
      families: rows.map((r) => ({
        market_family: r.family,
        submissions: r.submissions,
        resolved: r.resolved,
      })),
      served_at: nowIso(input.servedAt),
    },
  };
}

export function crossFamilyLeaderboardSurface(input: MarketReadInput & {
  query: MarketLeaderboardReadQuery;
}): MarketReadResult {
  const agents = getCrossFamilyLeaderboard(input.db, input.query);
  return {
    status: 200,
    body: { agents, served_at: nowIso(input.servedAt) },
  };
}
