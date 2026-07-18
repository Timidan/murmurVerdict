import { Router, type Request, type RequestHandler } from "express";
import express from "express";
import type Database from "better-sqlite3";
import {
  type WebhookDnsLookup,
  type WebhookUrlPolicy,
} from "../webhook-url.js";
import {
  WEBHOOK_SECRET_HEADER,
  deleteWebhookSubscription,
  loadWebhookSubscription,
  registerWebhookSubscription,
  sendDeleteWebhookSubscriptionResponse,
  sendWebhookSubscriptionJsonResponse,
} from "../webhook-subscription.js";
import { type PrivyAuthVerifier } from "../auth/privy.js";
import {
  authenticateWebhookAccount,
  type WebhookAuthIdentity,
} from "../auth/webhook-account-auth.js";
import { ERROR_CODES, VerdictError } from "../schema.js";
import { asyncHandler } from "./async-handler.js";

export type { WebhookAuthIdentity };

interface WebhookAuthedRequest extends Request {
  verdictAuth?: WebhookAuthIdentity;
}

export interface WebhookRouterDeps {
  db: Database.Database;
  now: () => Date;
  secretEquals: (
    provided: string | undefined | null,
    expected: string | undefined | null,
  ) => boolean;
  newSubscriptionId?: () => string;
  newSubscriptionSecret?: () => string;
  urlPolicy: WebhookUrlPolicy;
  urlDnsLookup?: WebhookDnsLookup;
  /**
   * FOLLOW-UP 1 — Privy auth verifier. When provided, POST /v1/webhooks
   * accepts a verified Privy bearer for authentication. When undefined,
   * Bearer auth is disabled but `X-Murmur-Api-Key` is still honored;
   * requests carrying neither valid credential are rejected with 401.
   * Runtime keys are always rejected for this route (webhook config is
   * a human-owner action, not a bot credential).
   */
  privyAuth?: PrivyAuthVerifier;
  /**
   * FOLLOW-UP 1 — outer IP-keyed limiter mounted BEFORE auth so the
   * auth path itself can't be DoS'd by anonymous spam. Generous (30/hr)
   * since the next limiter tightens to account scope.
   */
  subscriptionIpLimiter?: RequestHandler;
  /**
   * FOLLOW-UP 1 — inner limiter keyed by verified account_id, mounted
   * AFTER auth so it sees req.verdictAuth.account_id. Tight (10/hr).
   * Replaces the single Fix-4 IP-only limiter once auth is wired.
   */
  subscriptionAccountLimiter?: RequestHandler;
}

export function webhookRouter(deps: WebhookRouterDeps): Router {
  const router = Router();

  // FOLLOW-UP 1 — verify the caller before any body parse / DB read.
  // We deliberately use a local account-only helper instead of the
  // shared dispatcher: the shared dispatcher resolves
  // `X-Murmur-Agent-Slug` at auth time with a 404/403 split that leaks
  // slug existence. Webhook creation carries the slug in the body and
  // owns its own uniform-403 ownership check; auth here only proves
  // the account.
  const requireWebhookAuth: RequestHandler = asyncHandler(
    async (req: WebhookAuthedRequest, _res, next) => {
      const authResult = await authenticateWebhookAccount(req, {
        db: deps.db,
        privyAuth: deps.privyAuth,
      });
      if (!authResult) {
        throw new VerdictError(
          "auth required: provide Authorization: Bearer <privy> or X-Murmur-Api-Key",
          ERROR_CODES.agent_not_authorized,
          401,
        );
      }
      req.verdictAuth = authResult;
      next();
    },
  );

  // Discord / Telegram / Zapier / OpenServ workflows / custom servers can
  // subscribe to call.accepted + call.resolved events for one agent or all
  // agents. Each delivery is signed HMAC-SHA256(secret, body).
  router.post(
    "/v1/webhooks",
    ...(deps.subscriptionIpLimiter ? [deps.subscriptionIpLimiter] : []),
    requireWebhookAuth,
    ...(deps.subscriptionAccountLimiter ? [deps.subscriptionAccountLimiter] : []),
    express.json({ limit: "2kb" }),
    asyncHandler(async (req: WebhookAuthedRequest, res) => {
      const auth = req.verdictAuth!;
      const result = await registerWebhookSubscription({
        db: deps.db,
        body: req.body,
        now: deps.now,
        newSubscriptionId: deps.newSubscriptionId,
        newSubscriptionSecret: deps.newSubscriptionSecret,
        urlPolicy: deps.urlPolicy,
        urlDnsLookup: deps.urlDnsLookup,
        auth: { account_id: auth.account_id },
      });
      sendWebhookSubscriptionJsonResponse(res, result);
    }),
  );

  router.get("/v1/webhooks/:id", (req, res) => {
    const id = String(req.params.id ?? "");
    const result = loadWebhookSubscription({ db: deps.db, id });
    sendWebhookSubscriptionJsonResponse(res, result);
  });

  router.delete("/v1/webhooks/:id", (req, res) => {
    const id = String(req.params.id ?? "");
    const result = deleteWebhookSubscription({
      db: deps.db,
      id,
      providedSecret: req.header(WEBHOOK_SECRET_HEADER),
      secretEquals: deps.secretEquals,
    });
    sendDeleteWebhookSubscriptionResponse(res, result);
  });

  return router;
}
