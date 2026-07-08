import {
  boundedIntegerQuery,
  firstQueryValue,
} from "./route-query.js";
import type { LeaderboardTier } from "./schema.js";

export interface PublicRankingQueryInput {
  tier?: unknown;
  limit?: unknown;
}

export interface PublicLeaderboardReadQuery {
  tier?: LeaderboardTier;
  limit: number;
}

export interface PublicLeaderboardCsvReadQuery {
  limit: number;
}

export function publicLeaderboardQuery(
  query: PublicRankingQueryInput | undefined,
): PublicLeaderboardReadQuery {
  const tier = publicLeaderboardTier(query?.tier);
  return {
    ...(tier ? { tier } : {}),
    limit: publicLeaderboardLimit(query?.limit),
  };
}

export function publicLeaderboardCsvQuery(
  query: PublicRankingQueryInput | undefined,
): PublicLeaderboardCsvReadQuery {
  return {
    limit: publicLeaderboardLimit(query?.limit),
  };
}

function publicLeaderboardTier(raw: unknown): LeaderboardTier | undefined {
  const tier = firstQueryValue(raw);
  return tier === "main" || tier === "provisional" ? tier : undefined;
}

function publicLeaderboardLimit(raw: unknown): number {
  return boundedIntegerQuery(raw, { fallback: 200, max: 500 });
}
