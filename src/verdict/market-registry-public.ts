import type Database from "better-sqlite3";

import {
  marketsRepo,
  oraclesRepo,
  type MarketRow,
  type OracleRow,
  type RegistryStatus,
} from "./repos/market-registry-repo.js";
import type { OracleKind } from "./market-registry-schema.js";
import { adapterIdentityForMarket } from "./markets.js";
import {
  marketTaxonomyForMarket,
  type MarketTaxonomyAssignment,
} from "./market-taxonomy.js";
import {
  parseMarketConfigJson,
} from "./market-adapter-config.js";
import { publicPolymarketGammaMarketConfigSummary } from "../markets/polymarket-gamma/config.js";
import type { ResolutionClass } from "./schema.js";

export interface PublicMarketRegistryRow {
  market_id: string;
  asset_id: string;
  market_kind: string;
  horizon_seconds: number;
  scoring_kind: string;
  market_config_version: number;
  status: RegistryStatus;
  void_band: string;
  round_cadence_seconds: number | null;
  notes: string | null;
  created_at: string;
  adapter_id: string;
  market_family: string;
  market_taxonomy: MarketTaxonomyAssignment;
  oracles?: PublicMarketOracleSummary;
  config: Record<string, unknown>;
}

export type EnrichedMarketRegistryRow = Omit<
  MarketRow,
  "adapter_id" | "market_family"
> & {
  adapter_id: string;
  market_family: string;
  market_taxonomy: MarketTaxonomyAssignment;
  oracles?: PublicMarketOracleSummary;
};

export type PublicMarketOracleHealth = "ok" | "warn" | "fail";

export interface PublicMarketOracleRef {
  role: "primary" | "fallback";
  oracle_id: string;
  status: RegistryStatus | "missing";
  kind: OracleKind | null;
  adapter: string | null;
  chain: string | null;
  asset_id: string | null;
  asset_match: boolean | null;
}

export interface PublicMarketOracleSummary {
  health: PublicMarketOracleHealth;
  primary: PublicMarketOracleRef;
  fallback: PublicMarketOracleRef | null;
}

export interface PublicMarketSearchOptions {
  status?: RegistryStatus;
  query?: string | null;
  adapter_id?: string;
  market_family?: string;
  resolution_class?: ResolutionClass;
  limit?: number;
}

export function publicMarketRegistryRow(
  market: MarketRow,
  opts: { db?: Database.Database } = {},
): PublicMarketRegistryRow {
  const identity = adapterIdentityForMarket(market);
  return {
    market_id: market.market_id,
    asset_id: market.asset_id,
    market_kind: market.market_kind,
    horizon_seconds: market.horizon_seconds,
    scoring_kind: market.scoring_kind,
    market_config_version: market.market_config_version,
    status: market.status,
    void_band: market.void_band,
    round_cadence_seconds: market.round_cadence_seconds,
    notes: market.notes,
    created_at: market.created_at,
    ...identity,
    market_taxonomy: marketTaxonomyForMarket(market),
    ...(opts.db ? { oracles: publicMarketOracleSummary(opts.db, market) } : {}),
    config: publicMarketConfigSummary(market.config_json, {
      adapter_id: identity.adapter_id,
    }),
  };
}

export function enrichedMarketRegistryRow(
  market: MarketRow,
  opts: { db?: Database.Database } = {},
): EnrichedMarketRegistryRow {
  const identity = adapterIdentityForMarket(market);
  return {
    ...market,
    ...identity,
    market_taxonomy: marketTaxonomyForMarket(market),
    ...(opts.db ? { oracles: publicMarketOracleSummary(opts.db, market) } : {}),
  };
}

export function publicMarketOracleSummary(
  db: Database.Database,
  market: MarketRow,
): PublicMarketOracleSummary {
  const primary = publicMarketOracleRef(
    oraclesRepo.get(db, market.primary_oracle_id),
    market,
    "primary",
    market.primary_oracle_id,
  );
  const fallback = market.fallback_oracle_id
    ? publicMarketOracleRef(
        oraclesRepo.get(db, market.fallback_oracle_id),
        market,
        "fallback",
        market.fallback_oracle_id,
      )
    : null;
  const refs = fallback ? [primary, fallback] : [primary];
  const health = refs.some((ref) => ref.status === "missing" || ref.asset_match === false)
    ? "fail"
    : refs.some((ref) => ref.status !== "listed")
      ? "warn"
      : "ok";
  return { health, primary, fallback };
}

function publicMarketOracleRef(
  row: OracleRow | null,
  market: MarketRow,
  role: "primary" | "fallback",
  oracle_id: string,
): PublicMarketOracleRef {
  if (!row) {
    return {
      role,
      oracle_id,
      status: "missing",
      kind: null,
      adapter: null,
      chain: null,
      asset_id: null,
      asset_match: null,
    };
  }
  return {
    role,
    oracle_id,
    status: row.status,
    kind: row.kind,
    adapter: row.adapter,
    chain: row.chain,
    asset_id: row.asset_id,
    asset_match: row.asset_id === market.asset_id,
  };
}

export function searchPublicMarkets(
  db: Database.Database,
  opts: PublicMarketSearchOptions = {},
): PublicMarketRegistryRow[] {
  const status = opts.status ?? "listed";
  const query = opts.query?.trim().toLowerCase();
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 25)));
  return marketsRepo
    .list(db, status)
    .map((market) => publicMarketRegistryRow(market, { db }))
    .filter((market) => {
      if (opts.adapter_id && market.adapter_id !== opts.adapter_id) return false;
      if (opts.market_family && market.market_family !== opts.market_family) {
        return false;
      }
      if (
        opts.resolution_class &&
        market.market_taxonomy.resolution_class !== opts.resolution_class
      ) {
        return false;
      }
      if (!query) return true;
      return JSON.stringify(market).toLowerCase().includes(query);
    })
    .slice(0, limit);
}

export function publicMarketConfigSummary(
  configJson: string,
  opts: { adapter_id?: string } = {},
): Record<string, unknown> {
  const record = parseMarketConfigJson(configJson);
  if (opts.adapter_id === "polymarket-gamma") {
    return publicPolymarketGammaMarketConfigSummary(record);
  }
  return {
    ...(typeof record.conditionId === "string" ? { conditionId: record.conditionId } : {}),
    ...(typeof record.slug === "string" ? { slug: record.slug } : {}),
    ...(Array.isArray(record.outcomes) ? { outcomes: record.outcomes } : {}),
    ...(typeof record.endDate === "string" ? { endDate: record.endDate } : {}),
    ...(typeof record.gamma_url === "string" ? { gamma_url: record.gamma_url } : {}),
  };
}
