import { Router } from "express";
import type Database from "better-sqlite3";
import {
  feedAvailabilitySurface,
  listPublicFeedsSurface,
  publicFeedSurface,
  sendFeedPublicJsonResponse,
} from "../feed-public-surface.js";
import {
  feedPublicDetailQuery,
  feedPublicListQuery,
} from "../feed-public-query.js";
import { sendRetiredRoute } from "../retired-route-response.js";
import { asyncHandler } from "./async-handler.js";

export interface FeedPublicRouterDeps {
  db: Database.Database;
  now: () => Date;
}

export function feedPublicRouter(deps: FeedPublicRouterDeps): Router {
  const router = Router();

  router.get(
    "/v1/feeds",
    asyncHandler(async (req, res) => {
      sendFeedPublicJsonResponse(res, listPublicFeedsSurface({
        db: deps.db,
        servedAt: deps.now(),
        query: feedPublicListQuery(req.query),
      }));
    }),
  );

  router.get(
    "/v1/feeds/:feed_id",
    asyncHandler(async (req, res) => {
      sendFeedPublicJsonResponse(res, publicFeedSurface({
        db: deps.db,
        feedId: String(req.params.feed_id ?? ""),
        servedAt: deps.now(),
        query: feedPublicDetailQuery(req.query),
      }));
    }),
  );

  router.get(
    "/v1/feeds/:feed_id/availability",
    asyncHandler(async (req, res) => {
      sendFeedPublicJsonResponse(res, feedAvailabilitySurface({
        db: deps.db,
        feedId: String(req.params.feed_id ?? ""),
        servedAt: deps.now(),
      }));
    }),
  );

  router.post(
    "/v1/feeds/:feed_id/packets",
    asyncHandler(async (_req, res) => {
      sendRetiredRoute(res, {
        message:
          "/v1/feeds/:feed_id/packets is retired as an agent feed path. Submit via /v2/gateway/feeds/:feed_id/packets with a Runtime Key.",
        replacement: "/v2/gateway/feeds/:feed_id/packets",
      });
    }),
  );

  return router;
}
