import { Router } from "express";
import express from "express";

import {
  operatorAlertSnapshotResponse,
  operatorAlertTickResponse,
  sendOperatorAlertJsonResponse,
} from "../operator-alert-surface.js";
import {
  parseOperatorAlertQuery,
} from "../operator-alert-query.js";
import { asyncHandler } from "./async-handler.js";
import type { OperatorControlRouterDeps } from "./operator-control-types.js";

export function operatorAlertRoutes(deps: OperatorControlRouterDeps): Router {
  const router = Router();
  const json = express.json({ limit: "32kb" });

  router.get(
    "/v1/admin/alerts",
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      const query = parseOperatorAlertQuery(req.query);
      sendOperatorAlertJsonResponse(res, operatorAlertSnapshotResponse({
        db: deps.db,
        query,
        sink: deps.operatorAlertSink ?? undefined,
        servedAt: deps.now(),
      }));
    }),
  );

  router.post(
    "/v1/admin/alerts/tick",
    json,
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      sendOperatorAlertJsonResponse(res, await operatorAlertTickResponse({
        db: deps.db,
        body: req.body,
        now: deps.now,
        liveCanaries: deps.liveCanaries,
        newAlertId: deps.newOperatorAlertId,
        sink: deps.operatorAlertSink ?? undefined,
      }));
    }),
  );

  return router;
}
