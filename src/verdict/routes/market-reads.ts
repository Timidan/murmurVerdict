import { Router } from "express";
import type Database from "better-sqlite3";
import {
  marketLeaderboardReadQuery,
  marketRegistryListQuery,
} from "../market-read-query.js";
import {
  agentMarketGridSurface,
  crossFamilyLeaderboardSurface,
  familiesSurface,
  familyLeaderboardSurface,
  listMarketsSurface,
  marketLeaderboardSurface,
  marketTaxonomySurface,
  sendMarketReadJsonResponse,
} from "../market-read-surface.js";
import { asyncHandler } from "./async-handler.js";

export interface MarketReadRouterDeps {
  db: Database.Database;
  now: () => Date;
}

export function marketReadRouter(deps: MarketReadRouterDeps): Router {
  const router = Router();

  router.get(
    "/v1/markets",
    asyncHandler(async (req, res) => {
      sendMarketReadJsonResponse(res, listMarketsSurface({
        db: deps.db,
        query: marketRegistryListQuery(req.query),
        servedAt: deps.now(),
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
