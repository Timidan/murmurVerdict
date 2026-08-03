import { Router } from "express";
import type Database from "better-sqlite3";
import {
  marketCallsReadQuery,
  marketLeaderboardReadQuery,
  marketRegistryListQuery,
} from "../market-read-query.js";
import {
  agentMarketGridSurface,
  crossFamilyLeaderboardSurface,
  familiesSurface,
  familyLeaderboardSurface,
  listMarketsWithVenueSurface,
  marketCallsSurface,
  marketDetailSurface,
  marketLeaderboardSurface,
  marketsGridSurface,
  marketTaxonomySurface,
  sendMarketReadJsonResponse,
} from "../market-read-surface.js";
import {
  PolymarketVenueSnapshotProvider,
  VENUE_ADAPTER_ID,
  type MarketVenueSnapshotAdapter,
} from "../../markets/polymarket-gamma/venue-snapshot.js";
import { parseMarketConfigJson } from "../market-adapter-config.js";
import { asyncHandler } from "./async-handler.js";

export interface MarketReadRouterDeps {
  db: Database.Database;
  now: () => Date;
  /** Venue live-snapshot Adapter override (smokes inject a stub client). */
  venue?: MarketVenueSnapshotAdapter;
  /**
   * Gamma kill switch (MURMUR_POLYMARKET_GAMMA_ENABLED). Defaults ON. When
   * false the venue read surface serves the static Gamma-down skeleton and
   * NEVER constructs/calls the live snapshot provider — no Gamma egress.
   */
  polymarketGammaEnabled?: boolean;
}

export function marketReadRouter(deps: MarketReadRouterDeps): Router {
  const router = Router();
  // Router-scoped so the ~60s snapshot cache survives across requests. An
  // explicit `deps.venue` (smoke stub) always wins; otherwise the Gamma kill
  // switch decides between the live provider and the egress-free skeleton
  // adapter. Default ON so unset envs keep live venue odds.
  const gammaEnabled = deps.polymarketGammaEnabled ?? true;
  const venue = deps.venue ??
    (gammaEnabled
      ? new PolymarketVenueSnapshotProvider({ nowMs: () => deps.now().getTime() })
      : disabledVenueSnapshotAdapter());

  router.get(
    "/v1/markets",
    asyncHandler(async (req, res) => {
      sendMarketReadJsonResponse(res, await listMarketsWithVenueSurface({
        db: deps.db,
        query: marketRegistryListQuery(req.query),
        servedAt: deps.now(),
        venue,
      }));
    }),
  );

  router.get(
    "/v1/markets/taxonomy",
    asyncHandler(async (_req, res) => {
      sendMarketReadJsonResponse(res, marketTaxonomySurface({
        servedAt: deps.now(),
      }));
    }),
  );

  // Registered BEFORE /v1/markets/:market_id — Express matches in registration
  // order and the `:market_id` pattern would otherwise capture "grid".
  router.get(
    "/v1/markets/grid",
    asyncHandler(async (req, res) => {
      sendMarketReadJsonResponse(res, marketsGridSurface({
        db: deps.db,
        query: marketLeaderboardReadQuery(req.query),
        servedAt: deps.now(),
      }));
    }),
  );

  router.get(
    "/v1/markets/:market_id/leaderboard",
    asyncHandler(async (req, res) => {
      sendMarketReadJsonResponse(res, marketLeaderboardSurface({
        db: deps.db,
        marketId: String(req.params.market_id ?? ""),
        query: marketLeaderboardReadQuery(req.query),
        servedAt: deps.now(),
      }));
    }),
  );

  router.get(
    "/v1/markets/:market_id/calls",
    asyncHandler(async (req, res) => {
      sendMarketReadJsonResponse(res, marketCallsSurface({
        db: deps.db,
        marketId: String(req.params.market_id ?? ""),
        query: marketCallsReadQuery(req.query),
        servedAt: deps.now(),
      }));
    }),
  );

  // Registered AFTER /v1/markets/taxonomy — Express matches in registration
  // order and this pattern would otherwise capture the taxonomy path.
  router.get(
    "/v1/markets/:market_id",
    asyncHandler(async (req, res) => {
      sendMarketReadJsonResponse(res, await marketDetailSurface({
        db: deps.db,
        marketId: String(req.params.market_id ?? ""),
        servedAt: deps.now(),
        venue,
      }));
    }),
  );

  router.get(
    "/v1/agents/:slug/grid",
    asyncHandler(async (req, res) => {
      sendMarketReadJsonResponse(res, agentMarketGridSurface({
        db: deps.db,
        slug: String(req.params.slug ?? ""),
        servedAt: deps.now(),
      }));
    }),
  );

  router.get(
    "/v1/families/:family/leaderboard",
    asyncHandler(async (req, res) => {
      sendMarketReadJsonResponse(res, familyLeaderboardSurface({
        db: deps.db,
        family: String(req.params.family ?? ""),
        query: marketLeaderboardReadQuery(req.query),
        servedAt: deps.now(),
      }));
    }),
  );

  router.get(
    "/v1/families",
    asyncHandler(async (_req, res) => {
      sendMarketReadJsonResponse(res, familiesSurface({
        db: deps.db,
        servedAt: deps.now(),
      }));
    }),
  );

  router.get(
    "/v1/leaderboard/general",
    asyncHandler(async (req, res) => {
      sendMarketReadJsonResponse(res, crossFamilyLeaderboardSurface({
        db: deps.db,
        query: marketLeaderboardReadQuery(req.query),
        servedAt: deps.now(),
      }));
    }),
  );

  router.get(
    "/v1/leaderboard/cross-family",
    asyncHandler(async (req, res) => {
      sendMarketReadJsonResponse(res, crossFamilyLeaderboardSurface({
        db: deps.db,
        query: marketLeaderboardReadQuery(req.query),
        servedAt: deps.now(),
      }));
    }),
  );

  return router;
}

/**
 * Egress-free venue adapter used when the Gamma kill switch is OFF. Returns
 * the SAME shape the live provider serves during a Gamma outage: `end_date`
 * and `url` from the stored market config, every live field
 * (prices/volume/liquidity/fetched_at) null. Native (non-venue) markets get
 * `undefined` exactly as the live provider does, so no consumer sees a shape
 * change. Constructs no PolymarketGammaClient and makes no network call.
 */
function disabledVenueSnapshotAdapter(): MarketVenueSnapshotAdapter {
  return {
    async venueForMarket(market) {
      if (market.adapter_id !== VENUE_ADAPTER_ID) {
        return undefined;
      }
      const config = parseMarketConfigJson(market.config_json);
      return {
        prices: null,
        volume: null,
        liquidity: null,
        end_date: typeof config.endDate === "string" ? config.endDate : null,
        url: typeof config.gamma_url === "string" ? config.gamma_url : null,
        fetched_at: null,
      };
    },
  };
}
