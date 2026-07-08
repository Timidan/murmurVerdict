import { createHash } from "node:crypto";

import type { RequestHandler } from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";

const ONE_MINUTE_MS = 60 * 1000;

export interface AccountRateLimitRequest {
  ip?: string;
  header(name: string): string | undefined;
}

export interface AccountRouteLimiters {
  sessionLimiter: RequestHandler;
  createAgentLimiter: RequestHandler;
  listAgentsLimiter: RequestHandler;
  mintKeyLimiter: RequestHandler;
  rotateKeyLimiter: RequestHandler;
  destAddrLimiter: RequestHandler;
  funnelEventLimiter: RequestHandler;
  /**
   * FOLLOW-UP 1 — outer webhook subscription limiter. IP-only, mounted
   * BEFORE the dispatcher-auth middleware so the auth path itself is
   * bounded by anonymous spam (30/hr per IP, generous because the inner
   * limiter tightens). Pairs with subscriptionAccountLimiter below.
   */
  webhookSubscriptionIpLimiter: RequestHandler;
  /**
   * FOLLOW-UP 1 — inner webhook subscription limiter. Keyed by verified
   * account_id (req.verdictAuth.account_id set by requireWebhookAuth in
   * routes/webhooks.ts), mounted AFTER auth. Tight (10/hr per account).
   * Replaces the Fix-4 single token-aware limiter that was vulnerable
   * to bearer-rotation bypass.
   */
  webhookSubscriptionAccountLimiter: RequestHandler;
}

// All /v1/account/* routes mount route-level throttles before auth or handler
// work. IP-only limits cover unauthenticated bursts; token-aware limits keep a
// leaked Privy bearer from draining quota for every caller behind the same NAT.
// The default MemoryStore matches today's single-process daemon. Multi-replica
// deployment should replace this with a shared store.

/**
 * Build a limiter key from the client IP plus a short bearer-token hash.
 *
 * The cleartext token never enters the rate-limiter store. When no Bearer is
 * present, account routes fall back to the IPv6-safe IP key so anonymous probes
 * still share a bucket.
 */
export function accountRateLimitKey(req: AccountRateLimitRequest): string {
  const authz = req.header("Authorization") ?? req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authz);
  const ip = ipOnlyRateLimitKey(req);
  if (!match || !match[1]) return ip;
  const tokenHash = createHash("sha256")
    .update(match[1])
    .digest("hex")
    .slice(0, 16);
  return `${ip}:${tokenHash}`;
}

function ipOnlyRateLimitKey(req: AccountRateLimitRequest): string {
  return ipKeyGenerator(req.ip ?? "unknown");
}

/**
 * FOLLOW-UP 1 — webhook subscription limiter key generator. Reads the
 * verified account_id that requireWebhookAuth stashed on req; falls
 * back to IP only if auth somehow didn't populate it (safety net —
 * the auth middleware should have rejected the request first).
 */
function webhookAccountRateLimitKey(
  req: AccountRateLimitRequest & {
    verdictAuth?: { account_id?: string };
  },
): string {
  const id = req.verdictAuth?.account_id;
  if (id) return `acct:${id}`;
  return ipOnlyRateLimitKey(req);
}

function makeAccountLimiter(
  max: number,
  windowMs: number,
  perToken: boolean,
  routeLabel: string,
): RequestHandler {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: perToken ? accountRateLimitKey : ipOnlyRateLimitKey,
    message: { error: "rate_limited", code: "rate_limited", route: routeLabel },
  });
}

export function accountRouteLimiters(): AccountRouteLimiters {
  return {
    sessionLimiter: makeAccountLimiter(30, ONE_MINUTE_MS, false, "session"),
    createAgentLimiter: makeAccountLimiter(10, ONE_MINUTE_MS, false, "create_agent"),
    listAgentsLimiter: makeAccountLimiter(60, ONE_MINUTE_MS, false, "list_agents"),
    mintKeyLimiter: makeAccountLimiter(10, ONE_MINUTE_MS, true, "mint_api_key"),
    rotateKeyLimiter: makeAccountLimiter(20, ONE_MINUTE_MS, true, "rotate_api_key"),
    destAddrLimiter: makeAccountLimiter(5, ONE_MINUTE_MS, true, "destination_address"),
    funnelEventLimiter: makeAccountLimiter(60, ONE_MINUTE_MS, true, "funnel_event"),
    // FOLLOW-UP 1 — two-stage webhook subscription limiter.
    //  • Outer: 30 reqs/hr per IP, mounted BEFORE auth. Bounds the auth
    //    path itself against anonymous spam.
    //  • Inner: 10 reqs/hr keyed by verified account_id, mounted AFTER
    //    auth. The verified key closes the bearer-rotation bypass that
    //    the old Fix-4 token-aware limiter had.
    webhookSubscriptionIpLimiter: makeAccountLimiter(
      30,
      60 * ONE_MINUTE_MS,
      false,
      "webhook_subscription_ip",
    ),
    webhookSubscriptionAccountLimiter: rateLimit({
      windowMs: 60 * ONE_MINUTE_MS,
      limit: 10,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      keyGenerator: webhookAccountRateLimitKey,
      message: {
        error: "rate_limited",
        code: "rate_limited",
        route: "webhook_subscription",
      },
    }),
  };
}
