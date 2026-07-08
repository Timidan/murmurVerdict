import { Router } from "express";
import type Database from "better-sqlite3";
import type { VerdictEventBus } from "../events.js";
import {
  publicLeaderboardCsvQuery,
  publicLeaderboardQuery,
} from "../public-ranking-query.js";
import {
  publicLeaderboardCsvResponse,
  publicLeaderboardMarkdownResponse,
  publicLeaderboardResponse,
  publicStatsResponse,
  publicTodayFeedResponse,
  sendPublicRankingBodyResponse,
  sendPublicRankingJsonResponse,
} from "../public-ranking-surface.js";

export interface PublicRankingRouterDeps {
  db: Database.Database;
  events?: VerdictEventBus;
  now: () => Date;
}

export function publicRankingRouter(deps: PublicRankingRouterDeps): Router {
  const router = Router();

  router.get("/v1/leaderboard", (req, res) => {
    sendPublicRankingJsonResponse(res, publicLeaderboardResponse({
      db: deps.db,
      servedAt: deps.now(),
      events: deps.events,
      query: publicLeaderboardQuery(req.query),
    }));
  });

  router.get("/v1/feed/today", (_req, res) => {
    sendPublicRankingJsonResponse(res, publicTodayFeedResponse({
      db: deps.db,
      servedAt: deps.now(),
      events: deps.events,
    }));
  });

  router.get("/v1/stats", (_req, res) => {
    sendPublicRankingJsonResponse(res, publicStatsResponse({
      db: deps.db,
      servedAt: deps.now(),
      events: deps.events,
    }));
  });

  router.get("/v1/snapshot.md", (_req, res) => {
    sendPublicRankingBodyResponse(res, publicLeaderboardMarkdownResponse({
      db: deps.db,
      servedAt: deps.now(),
      events: deps.events,
    }));
  });

  router.get("/v1/leaderboard.csv", (req, res) => {
    sendPublicRankingBodyResponse(res, publicLeaderboardCsvResponse({
      db: deps.db,
      query: publicLeaderboardCsvQuery(req.query),
    }));
  });

  return router;
}
