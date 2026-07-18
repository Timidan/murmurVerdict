// ─── POST /v1/privy/webhooks — inbound Privy transfer receiver ───────────────
//
// Receives Privy's signed `user.transferred_account` webhook (fired by a
// dashboard "Login method transfer", which also DELETES the source Privy
// user) and reparents Murmur ownership from the source DID's account to the
// destination DID's account.
//
// This route is UNAUTHENTICATED by design — authenticity comes entirely from
// the svix signature, verified inside `deps.verifier.verify`. It therefore
// bypasses the bearer/account auth every other write route requires, and is
// mounted BEFORE the general verdict/account routers so its raw-body parser
// governs only this path (the account router installs a JSON parser that would
// otherwise consume the body before the signature can be checked against the
// exact bytes Privy signed).
//
// Decoupling: the reparent implementation is injected as `deps.reparent` so
// this router is testable with a fake and stays independent of the reparent
// core module's construction.
//
// Status matrix:
//   verifier disabled (secret unset)        → 503  (no body processing)
//   body not a Buffer                       → 400
//   missing/blank svix header               → 400
//   verify() throws (bad signature / stale) → 400
//   event.type === "other"                  → 204  (verified, not a transfer)
//   transfer + reparent ok                  → 200  (json summary)
//   transfer + reparent throws              → 500  (logged; Privy will retry)

import type Database from "better-sqlite3";
import { Router } from "express";
import express from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";

import type { PrivyWebhookVerifier } from "../auth/privy-webhook-verify.js";

/**
 * Reparent function contract. Kept structural (not an import of the reparent
 * core) so this router can be exercised with a fake and does not couple to
 * that module. The real `reparentAccount` satisfies this shape.
 */
export type ReparentFn = (
  db: Database.Database,
  args: { fromPrivyUserId: string; toPrivyUserId: string },
) => {
  status: string;
  from_account_id: string | null;
  to_account_id: string | null;
  moved: Record<string, number>;
};

export interface PrivyWebhookRouterDeps {
  db: Database.Database;
  verifier: PrivyWebhookVerifier;
  reparent: ReparentFn;
  logger?: Pick<Console, "error">;
}

export function privyWebhookRouter(deps: PrivyWebhookRouterDeps): Router {
  const router = Router();
  const { db, verifier, reparent } = deps;
  const logger = deps.logger ?? console;

  // Unauthenticated IP limiter, mounted BEFORE the raw parser so anonymous
  // probes are bounded before any body is buffered. The window/limit are
  // deliberately generous: Privy retries a failed delivery with backoff and a
  // single transfer can redeliver a handful of times, so a legitimate sender
  // must never be throttled. This only exists to cap abusive flooding.
  const ipLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1000,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
    message: {
      error: "rate_limited",
      code: "rate_limited",
      route: "privy_webhook",
    },
  });

  // Route-scoped raw parser: keep the exact signed bytes so the svix HMAC
  // verifies against them. Bounded to 64kb — transfer payloads are tiny.
  const raw = express.raw({ type: "application/json", limit: "64kb" });

  router.post(
    "/v1/privy/webhooks",
    ipLimiter,
    // Fail-closed gate BEFORE the body parser: when the receiver is not
    // configured, answer 503 without processing (or buffering) any body.
    (req, res, next) => {
      if (!verifier.enabled()) {
        res.status(503).json({
          error: "privy_webhook_disabled",
          code: "privy_webhook_disabled",
        });
        return;
      }
      next();
    },
    raw,
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "invalid_body", code: "invalid_body" });
        return;
      }

      const svixId = req.header("svix-id");
      const svixTimestamp = req.header("svix-timestamp");
      const svixSignature = req.header("svix-signature");
      if (
        typeof svixId !== "string" ||
        svixId.length === 0 ||
        typeof svixTimestamp !== "string" ||
        svixTimestamp.length === 0 ||
        typeof svixSignature !== "string" ||
        svixSignature.length === 0
      ) {
        res.status(400).json({
          error: "missing_svix_headers",
          code: "missing_svix_headers",
        });
        return;
      }

      const rawBody = req.body.toString("utf8");

      let event;
      try {
        event = await verifier.verify(rawBody, {
          svixId,
          svixTimestamp,
          svixSignature,
        });
      } catch {
        // Bad signature / stale timestamp / degenerate transfer payload. Do
        // not leak which check failed.
        res.status(400).json({
          error: "invalid_signature",
          code: "invalid_signature",
        });
        return;
      }

      if (event.type === "other") {
        // Verified, but not a transfer — acknowledge so Privy stops retrying.
        res.status(204).end();
        return;
      }

      try {
        const result = reparent(db, {
          fromPrivyUserId: event.fromPrivyUserId,
          toPrivyUserId: event.toPrivyUserId,
        });
        res.status(200).json({
          ok: true,
          status: result.status,
          from_account_id: result.from_account_id,
          to_account_id: result.to_account_id,
          moved: result.moved,
        });
      } catch (err) {
        // Return 500 (not a swallow) so Privy redelivers — reparent is
        // idempotent, so a retry after a transient DB fault is safe.
        logger.error("[murmur][privy-webhook] reparent failed:", err);
        res.status(500).json({
          error: "reparent_failed",
          code: "reparent_failed",
        });
      }
    },
  );

  return router;
}
