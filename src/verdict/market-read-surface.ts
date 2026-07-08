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
} from "./leaderboard.js";
import {
  marketTaxonomyResponse,
} from "./market-taxonomy.js";
import {
  type MarketLeaderboardReadQuery,
  type MarketRegistryListQuery,
} from "./market-read-query.js";
import { enrichedMarketRegistryRow } from "./market-registry-public.js";
import {
  ERROR_CODES,
  MarketIdSchema,
  SCHEMA_VERSION,
  VerdictError,
} from "./schema.js";
import { nowIso } from "./time.js";

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

export function listMarketsSurface(input: MarketReadInput & {
  query: MarketRegistryListQuery;
}): MarketReadResult {
  let markets = marketsRepo.list(input.db, input.query.status);
  if (input.query.assetId) {
    markets = markets.filter((m) => m.asset_id === input.query.assetId);
  }
  const enriched = markets.map((market) =>
    enrichedMarketRegistryRow(market, { db: input.db }),
  );
  return {
    status: 200,
    body: {
      markets: enriched,
      taxonomy: marketTaxonomyResponse(),
      served_at: nowIso(input.servedAt),
    },
  };
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
