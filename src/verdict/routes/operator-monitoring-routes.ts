import { Router } from "express";
import express from "express";

import {
  operatorCanarySnapshotResponse,
  operatorCanaryTickResponse,
  operatorControllerIdentityResponse,
  sendOperatorMonitoringJsonResponse,
  sendOperatorMonitoringResultJsonResponse,
} from "../operator-monitoring-surface.js";
import { parseControllerIdentityQuery } from "../operator-controller-identity-query.js";
import { asyncHandler } from "./async-handler.js";
import type { OperatorControlRouterDeps } from "./operator-control-types.js";

export function operatorMonitoringRoutes(deps: OperatorControlRouterDeps): Router {
  const router = Router();
  const json = express.json({ limit: "32kb" });

  router.get(
    "/v1/admin/canaries",
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      sendOperatorMonitoringResultJsonResponse(
        res,
        operatorCanarySnapshotResponse(deps.liveCanaries),
      );
    }),
  );

  router.post(
    "/v1/admin/canaries/tick",
    json,
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      sendOperatorMonitoringResultJsonResponse(
        res,
        await operatorCanaryTickResponse(deps.liveCanaries),
      );
    }),
  );

  router.get(
    "/v1/admin/identity/controllers",
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      sendOperatorMonitoringJsonResponse(res, operatorControllerIdentityResponse({
        db: deps.db,
        query: parseControllerIdentityQuery(req.query),
        servedAt: deps.now(),
      }));
    }),
  );

  return router;
}
