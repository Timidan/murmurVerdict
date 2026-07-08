import type { RegistryStatus } from "./repos/market-registry-repo.js";
import { boundedIntegerQuery, firstQueryValue } from "./route-query.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

export type MarketReadTier = "main" | "provisional";

export interface MarketReadQueryInput {
  asset_id?: unknown;
  limit?: unknown;
  status?: unknown;
  tier?: unknown;
}

export interface MarketRegistryListQuery {
  assetId: string | null;
  status: RegistryStatus;
}

export interface MarketLeaderboardReadQuery {
  limit: number;
  tier?: MarketReadTier;
}

const ALLOWED_MARKET_STATUSES: ReadonlyArray<RegistryStatus> = [
  "draft",
  "listed",
  "frozen",
  "retired",
];

export function marketRegistryListQuery(
  query: MarketReadQueryInput | undefined,
): MarketRegistryListQuery {
  return {
    assetId: marketAssetIdFilter(query?.asset_id),
    status: marketRegistryStatus(query?.status),
  };
}

export function marketLeaderboardReadQuery(
  query: MarketReadQueryInput | undefined,
): MarketLeaderboardReadQuery {
  const tier = marketReadTierQuery(query?.tier);
  return {
    limit: boundedIntegerQuery(query?.limit, { fallback: 20, max: 100 }),
    ...(tier ? { tier } : {}),
  };
}

function marketRegistryStatus(raw: unknown): RegistryStatus {
  const rawStatus = firstQueryValue(raw);
  if (rawStatus === undefined) return "listed";
  if (!ALLOWED_MARKET_STATUSES.includes(rawStatus as RegistryStatus)) {
    throw new VerdictError(
      `status must be one of ${ALLOWED_MARKET_STATUSES.join("|")}`,
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  return rawStatus as RegistryStatus;
}

function marketAssetIdFilter(raw: unknown): string | null {
  const assetId = firstQueryValue(raw);
  return assetId && assetId.length > 0 ? assetId : null;
}

function marketReadTierQuery(raw: unknown): MarketReadTier | undefined {
  const tier = firstQueryValue(raw);
  return tier === "main" || tier === "provisional" ? tier : undefined;
}
