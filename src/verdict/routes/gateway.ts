import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import express from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
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
  gatewayHeartbeatResponse,
} from "../gateway-heartbeat-surface.js";
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
import { gatewayAttemptResponse } from "../gateway-attempt-surface.js";
import {
  acceptDelivery,
  disputeDelivery,
  deliveryActionMessage,
} from "../entitlement-delivery.js";
import { listSellableCallsResponse } from "../gateway-sellable-surface.js";
import {
  listSubscriberPurchasesResponse,
  SUBSCRIBER_AUTH_HEADER,
} from "../gateway-purchases-surface.js";
import type { CallTerms } from "../call-sale-terms.js";
import { asyncHandler } from "./async-handler.js";

export interface GatewayRouterDeps {
  db: Database.Database;
  fhenixGateway?: FhenixGatewayBroadcaster | null;
  now: () => Date;
  privyAuth?: PrivyAuthVerifier;
  requireAdmin: (req: Request, res: Response) => boolean;
  /** Flow 2 paid decrypt-access surface. null → the access routes 503. */
  entitlementAccess?: EntitlementAccessSurfaceDeps | null;
  /** Deployment-specific runtime-key PoP audience (MURMUR_POP_AUDIENCE). */
  popAudience?: string;
  /**
   * The deployment the public read surfaces are scoped to. Independent of the
   * grant runtime: a seal-only daemon still has a chain + contract, and must
   * still refuse to list another deployment's rows.
   */
  fhenixChain?: { chainId: number; sealedVerdictsAddress: string | null } | null;
  /** Deployment-wide fallback terms for pre-070 calls; null when unset. */
  legacyCallTerms?: CallTerms | null;
}

/** Delivery refusals map to the status that says what the caller should do. */
function statusForDelivery(code: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "bad_signature":
      return 401;
    case "unknown_ground":
      return 400;
    default:
      return 409;
  }
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
  // Heartbeats are operational presence, so their budget is independent of
  // per-key submission policy quotas. Keep it generous relative to the 60s
  // cadence while bounding accidental tight loops before PoP verification.
  const heartbeatIpLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    // The keyed limiter below owns the response headers. Suppressing these
    // avoids conflicting RateLimit values while still bounding arbitrary
    // Runtime-Key header churn before authentication.
    standardHeaders: false,
    legacyHeaders: false,
    message: { error: "rate_limited", code: "rate_limited", route: "gateway_heartbeat" },
  });
  const heartbeatLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 12,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => {
      const runtimeKey = req.header("X-Murmur-Runtime-Key");
      return runtimeKey
        ? createHash("sha256").update(runtimeKey).digest("hex")
        : ipKeyGenerator(req.ip ?? "unknown");
    },
    message: { error: "rate_limited", code: "rate_limited", route: "gateway_heartbeat" },
  });

  router.post(
    "/v2/gateway/heartbeat",
    heartbeatIpLimiter,
    heartbeatLimiter,
    json,
    asyncHandler(async (req, res) => {
      const result = await gatewayHeartbeatResponse({
        req,
        deps: {
          db: deps.db,
          now: deps.now,
          privyAuth: deps.privyAuth,
          popAudience: deps.popAudience,
        },
        bodyJson: req.body ?? {},
      });
      res.status(result.status).json(result.body);
    }),
  );

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

  // Public storefront. No auth: these are offers, and an offer nobody can see
  // is not one. Scoped to this daemon's deployment; `purchase_available`
  // reports whether the checkout below is actually mounted here.
  router.get(
    "/v2/gateway/calls/sellable",
    asyncHandler(async (req, res) => {
      const result = listSellableCallsResponse(
        {
          db: deps.db,
          chain: deps.fhenixChain ?? null,
          legacyTerms: deps.legacyCallTerms ?? null,
          purchaseAvailable: Boolean(deps.entitlementAccess),
          now: deps.now,
        },
        {
          limit: numericQuery(req.query.limit),
          cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
          venueSeriesIds: repeatableQuery(req.query.series),
          agentSlug:
            typeof req.query.agent_slug === "string" ? req.query.agent_slug : null,
        },
      );
      res.status(result.status).json(result.body);
    }),
  );

  // A wallet's own purchases. Granted rows are public (they mirror on-chain
  // grant events); the rest of the history needs a signature from the wallet.
  router.get(
    "/v2/gateway/entitlements",
    asyncHandler(async (req, res) => {
      const authHeader = req.header(SUBSCRIBER_AUTH_HEADER);
      const result = await listSubscriberPurchasesResponse(
        { db: deps.db, chain: deps.fhenixChain ?? null, now: deps.now },
        {
          subscriber: String(req.query.subscriber ?? ""),
          limit: numericQuery(req.query.limit),
          cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
          authHeader: typeof authHeader === "string" ? authHeader : undefined,
        },
      );
      res.status(result.status).json(result.body);
    }),
  );

  // The agent's own submission attempt, including the onchain_call_id the SDK
  // otherwise had no way to learn. Runtime-key auth only (see the surface).
  router.get(
    "/v2/gateway/attempts/:attempt_id",
    asyncHandler(async (req, res) => {
      const result = await gatewayAttemptResponse({
        req,
        deps: {
          db: deps.db,
          now: deps.now,
          privyAuth: deps.privyAuth,
          popAudience: deps.popAudience,
        },
        attemptId: String(req.params.attempt_id ?? ""),
      });
      res.status(result.status).json(result.body);
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
        authHeader: req.header(SUBSCRIBER_AUTH_HEADER),
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

  // ── Delivery: the buyer says whether they got what they paid for ─────────
  //
  // This is the gate on paying the provider. It is about DELIVERY and never
  // about accuracy: the dispute grounds are a closed list of delivery defects,
  // and a call that simply lost is not one of them. The refusal says so.
  //
  // Both routes are authorized by a signature over an ACTION-SPECIFIC message
  // — not by a session. The buyer is a wallet, possibly an autonomous agent
  // with no browser, and the signature binds the action, the deployment, the
  // entitlement and the signer so that nothing minted for one purpose can be
  // replayed for another.

  // The exact string to sign, so a client never has to reconstruct it.
  router.get(
    "/v2/gateway/entitlements/:id/delivery-message",
    asyncHandler(async (req, res) => {
      const action = String(req.query.action ?? "accept_delivery");
      if (action !== "accept_delivery" && action !== "dispute_delivery") {
        res.status(400).json({ error: "unknown action", code: "bad_request" });
        return;
      }
      const ground = req.query.ground ? String(req.query.ground) : undefined;
      const row = deps.db
        .prepare(
          `SELECT chain_id, contract_address, onchain_call_id, subscriber_address
             FROM entitlements WHERE id = ?`,
        )
        .get(Number(req.params.id ?? 0)) as
        | {
            chain_id: number;
            contract_address: string;
            onchain_call_id: string;
            subscriber_address: string;
          }
        | undefined;
      if (!row) {
        res.status(404).json({ error: "no such purchase", code: "not_found" });
        return;
      }
      res.status(200).json({
        message: deliveryActionMessage({
          action,
          audience: deps.popAudience ?? "murmur.verdict",
          entitlementId: Number(req.params.id ?? 0),
          chainId: row.chain_id,
          contractAddress: row.contract_address,
          onchainCallId: row.onchain_call_id,
          subscriberAddress: row.subscriber_address,
          ground: ground as never,
        }),
      });
    }),
  );

  router.post(
    "/v2/gateway/entitlements/:id/accept",
    json,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { signature?: unknown; subscriber_address?: unknown };
      const out = await acceptDelivery(
        { db: deps.db, now: deps.now },
        {
          entitlementId: Number(req.params.id ?? 0),
          subscriberAddress: String(body.subscriber_address ?? ""),
          signature: String(body.signature ?? "") as `0x${string}`,
          audience: deps.popAudience ?? "murmur.verdict",
        },
      );
      if (!out.ok) {
        res.status(statusForDelivery(out.code)).json({ error: out.message, code: out.code });
        return;
      }
      res.status(200).json({ state: out.state });
    }),
  );

  router.post(
    "/v2/gateway/entitlements/:id/dispute",
    json,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as {
        signature?: unknown;
        subscriber_address?: unknown;
        ground?: unknown;
        evidence?: unknown;
      };
      const out = await disputeDelivery(
        { db: deps.db, now: deps.now },
        {
          entitlementId: Number(req.params.id ?? 0),
          subscriberAddress: String(body.subscriber_address ?? ""),
          signature: String(body.signature ?? "") as `0x${string}`,
          audience: deps.popAudience ?? "murmur.verdict",
          ground: String(body.ground ?? ""),
          evidence: body.evidence == null ? null : String(body.evidence),
        },
      );
      if (!out.ok) {
        res.status(statusForDelivery(out.code)).json({ error: out.message, code: out.code });
        return;
      }
      res.status(200).json({ state: out.state });
    }),
  );

  return router;
}

/** `?limit=` as a number, or undefined so the surface applies its default. */
function numericQuery(raw: unknown): number | undefined {
  return typeof raw === "string" && /^[0-9]+$/.test(raw) ? Number(raw) : undefined;
}

/** `?series=a&series=b` and `?series=a` both parse; blanks and dupes dropped. */
function repeatableQuery(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}
