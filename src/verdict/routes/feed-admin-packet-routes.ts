import express, { Router } from "express";

import {
  feedPacketBackfillResponse,
  sendFeedPacketAdminJsonResponse,
} from "../feed-packet-admin-surface.js";
import { asyncHandler } from "./async-handler.js";
import type { FeedAdminRouterDeps } from "./feed-admin-types.js";

export function feedAdminPacketRouter(deps: FeedAdminRouterDeps): Router {
  const router = Router();
  const json = express.json({ limit: "32kb" });

  router.post(
    "/v1/admin/fhenix/backfill/feeds/:feed_id/packets",
    json,
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      sendFeedPacketAdminJsonResponse(res, feedPacketBackfillResponse({
        db: deps.db,
        feedId: String(req.params.feed_id ?? ""),
        body: req.body,
        newPacketId: deps.newFeedPacketId,
        now: deps.now,
      }));
    }),
  );

  return router;
}
