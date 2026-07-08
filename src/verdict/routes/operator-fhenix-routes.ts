import { Router } from "express";
import express from "express";

import {
  operatorFhenixBackfillCallResponse,
  operatorFhenixInvalidRevealResponse,
  operatorFhenixLifecycleResponse,
  operatorFhenixRevealResponse,
  sendOperatorFhenixJsonResponse,
  sendOperatorFhenixStatusJsonResponse,
} from "../operator-fhenix-surface.js";
import { parseFhenixLifecycleQuery } from "../operator-fhenix-lifecycle-query.js";
import { asyncHandler } from "./async-handler.js";
import type { OperatorControlRouterDeps } from "./operator-control-types.js";

export function operatorFhenixRoutes(deps: OperatorControlRouterDeps): Router {
  const router = Router();
  const json = express.json({ limit: "32kb" });

  router.post(
    "/v1/admin/fhenix/backfill/calls",
    express.text({ type: "application/json", limit: "32kb" }),
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      sendOperatorFhenixStatusJsonResponse(res, await operatorFhenixBackfillCallResponse({
        db: deps.db,
        agentSlug: req.header("X-Murmur-Agent-Slug"),
        rawBody: typeof req.body === "string" ? req.body : "",
        fhenixVerifier: deps.fhenixVerifier,
        events: deps.events,
        newSealedCallId: deps.newSealedCallId,
        now: deps.now,
      }));
    }),
  );

  router.post(
    "/v1/admin/fhenix/reveals",
    json,
    asyncHandler(async (req, res) => {
      if (!deps.requireAdminBearer(req, res)) return;
      sendOperatorFhenixStatusJsonResponse(res, await operatorFhenixRevealResponse({
        db: deps.db,
        verifier: deps.requireFhenixVerifier(),
        body: req.body,
        now: deps.now,
      }));
    }),
  );

  router.post(
    "/v1/admin/fhenix/invalid-reveals",
    json,
    asyncHandler(async (req, res) => {
      if (!deps.requireAdminBearer(req, res)) return;
      sendOperatorFhenixStatusJsonResponse(res, await operatorFhenixInvalidRevealResponse({
        db: deps.db,
        verifier: deps.requireFhenixVerifier(),
        body: req.body,
        now: deps.now,
      }));
    }),
  );

  router.get(
    "/v1/admin/fhenix/lifecycle",
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      sendOperatorFhenixJsonResponse(res, operatorFhenixLifecycleResponse({
        db: deps.db,
        query: parseFhenixLifecycleQuery(
          req.query,
          deps.fhenixLifecycleQueryDefaults,
        ),
        servedAt: deps.now(),
        verifierConfigured: Boolean(deps.fhenixVerifier),
      }));
    }),
  );

  return router;
}
