import express, { Router } from "express";

import {
  feedSlaSnapshotResponse,
  feedSlaTickResponse,
  sendFeedSlaJsonResponse,
} from "../feed-sla-surface.js";
import { parseFeedSlaQuery } from "../feed-sla-query.js";
import { asyncHandler } from "./async-handler.js";
import type { FeedAdminRouterDeps } from "./feed-admin-types.js";

export function feedAdminSlaRouter(deps: FeedAdminRouterDeps): Router {
  const router = Router();
  const json = express.json({ limit: "32kb" });

  router.get(
    "/v1/admin/feeds/sla",
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      sendFeedSlaJsonResponse(res, feedSlaSnapshotResponse({
        db: deps.db,
        query: parseFeedSlaQuery(req.query),
        servedAt: deps.now(),
      }));
    }),
  );

  router.post(
    "/v1/admin/feeds/sla/tick",
    json,
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      sendFeedSlaJsonResponse(res, feedSlaTickResponse({
        db: deps.db,
        newIncidentId: deps.newFeedSlaIncidentId,
        now: deps.now,
        body: req.body,
      }));
    }),
  );

  return router;
}
