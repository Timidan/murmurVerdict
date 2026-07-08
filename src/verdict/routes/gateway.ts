import { Router, type Request, type Response } from "express";
import express from "express";
import type Database from "better-sqlite3";
import type { FhenixGatewayBroadcaster } from "../../integrations/fhenix-gateway.js";
import type { PrivyAuthVerifier } from "../auth/privy.js";
import {
  gatewayFeedPacketSubmissionResponse,
  gatewayMurmurSealedCallSubmissionResponse,
  gatewaySealedCallSubmissionResponse,
  sendGatewaySubmissionJsonResponse,
} from "../gateway-submission-surface.js";
import {
  operatorGatewayRetryResponse,
  operatorGatewaySnapshotResponse,
  operatorGatewayTickResponse,
  sendOperatorGatewayJsonResponse,
  sendOperatorGatewayStatusJsonResponse,
} from "../operator-gateway-surface.js";
import { parseGatewayOperatorQuery } from "../operator-gateway-query.js";
import { asyncHandler } from "./async-handler.js";

export interface GatewayRouterDeps {
  db: Database.Database;
  fhenixGateway?: FhenixGatewayBroadcaster | null;
  now: () => Date;
  privyAuth?: PrivyAuthVerifier;
  requireAdmin: (req: Request, res: Response) => boolean;
}

export function gatewayRouter(deps: GatewayRouterDeps): Router {
  const router = Router();
  const json = express.json({ limit: "32kb" });

  // Canonical Gateway paths. The daemon never receives verdict/feed plaintext
  // while pending; it accepts CoFHE encrypted inputs, enforces Gateway policy,
  // and relays the Fhenix submit tx itself.
  router.post(
    "/v2/gateway/calls/seal",
    json,
    asyncHandler(async (req, res) => {
      const result = await gatewayMurmurSealedCallSubmissionResponse({
        req,
        deps,
        bodyJson: req.body ?? {},
      });
      sendGatewaySubmissionJsonResponse(res, result);
    }),
  );

  router.post(
    "/v2/gateway/calls",
    json,
    asyncHandler(async (req, res) => {
      const result = await gatewaySealedCallSubmissionResponse({
        req,
        deps,
        bodyJson: req.body ?? {},
      });
      sendGatewaySubmissionJsonResponse(res, result);
    }),
  );

  router.post(
    "/v2/gateway/feeds/:feed_id/packets",
    json,
    asyncHandler(async (req, res) => {
      const result = await gatewayFeedPacketSubmissionResponse({
        req,
        deps,
        feedId: String(req.params.feed_id ?? ""),
        bodyJson: req.body ?? {},
      });
      sendGatewaySubmissionJsonResponse(res, result);
    }),
  );

  router.get(
    "/v1/admin/fhenix/gateway",
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      const query = parseGatewayOperatorQuery(req.query);
      sendOperatorGatewayJsonResponse(res, operatorGatewaySnapshotResponse({
        db: deps.db,
        gateway: deps.fhenixGateway,
        query,
        servedAt: deps.now(),
      }));
    }),
  );

  router.post(
    "/v1/admin/fhenix/gateway/tick",
    json,
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      const result = await operatorGatewayTickResponse({
        gateway: deps.fhenixGateway,
        query: parseGatewayOperatorQuery(req.query),
        now: deps.now,
      });
      sendOperatorGatewayStatusJsonResponse(res, result);
    }),
  );

  router.post(
    "/v1/admin/fhenix/gateway/attempts/:attempt_id/retry",
    json,
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      const result = await operatorGatewayRetryResponse({
        gateway: deps.fhenixGateway,
        attemptId: String(req.params.attempt_id ?? ""),
        now: deps.now,
      });
      sendOperatorGatewayStatusJsonResponse(res, result);
    }),
  );

  return router;
}
