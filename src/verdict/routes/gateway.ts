import { createHash } from "node:crypto";
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
import {
  entitlementAccessResponse,
  entitlementStatusResponse,
  type EntitlementAccessSurfaceDeps,
} from "../entitlement-access-surface.js";
import { asyncHandler } from "./async-handler.js";

export interface GatewayRouterDeps {
  db: Database.Database;
  fhenixGateway?: FhenixGatewayBroadcaster | null;
  now: () => Date;
  privyAuth?: PrivyAuthVerifier;
  requireAdmin: (req: Request, res: Response) => boolean;
  /** Flow 2 paid decrypt-access surface. null → the access routes 503. */
  entitlementAccess?: EntitlementAccessSurfaceDeps | null;
}

export function gatewayRouter(deps: GatewayRouterDeps): Router {
  const router = Router();
  // The verify hook hashes the RAW body bytes for runtime-key PoP — hashing a
  // re-serialized req.body would not match what the agent actually signed.
  const json = express.json({
    limit: "32kb",
    verify: (req, _res, buf) => {
      (req as Request & { murmurRawBodySha256?: string }).murmurRawBodySha256 =
        createHash("sha256").update(buf).digest("hex");
    },
  });

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

  // Flow 2 — paid private decrypt-grant (grant-only v1). The subscriber pays
  // (x402/nanopay) to receive EARLY private decrypt access to an agent's sealed
  // call, before the public reveal. The subscriber is the VERIFIED payer wallet.
  // NO plaintext / proxy-decrypt here — the client unseals locally (tools/).
  router.post(
    "/v2/gateway/calls/:callId/access",
    json,
    asyncHandler(async (req, res) => {
      if (!deps.entitlementAccess) {
        res.status(503).json({ error: "PaidAccessDisabled" });
        return;
      }
      const paymentHeader = req.headers["payment-signature"];
      if (paymentHeader !== undefined && typeof paymentHeader !== "string") {
        res.status(400).json({ error: "MalformedPayment" });
        return;
      }
      const result = await entitlementAccessResponse({
        deps: deps.entitlementAccess,
        onchainCallId: String(req.params.callId ?? ""),
        paymentHeader: paymentHeader ?? undefined,
      });
      res.status(result.status);
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      }
      res.json(result.body);
    }),
  );

  router.get(
    "/v2/gateway/calls/:callId/access/status",
    asyncHandler(async (req, res) => {
      if (!deps.entitlementAccess) {
        res.status(503).json({ error: "PaidAccessDisabled" });
        return;
      }
      const result = await entitlementStatusResponse({
        deps: deps.entitlementAccess,
        onchainCallId: String(req.params.callId ?? ""),
        subscriberAddress: String(req.query.subscriber ?? ""),
      });
      res.status(result.status).json(result.body);
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
