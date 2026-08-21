import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import {
  accountSessionResponse,
  sendAccountSessionJsonResponse,
} from "../account-session-surface.js";
import { accountDeactivationState } from "../account-agent-lifecycle-surface.js";
import type { RequireAccount } from "../account-route-auth.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountSessionRouterDeps {
  /** Raw Privy auth. Used by GET only, which a closed account may still call. */
  requireAccount: RequireAccount;
  /**
   * Privy auth plus the deactivation gate. Used by POST, which touches
   * last_seen_at and is therefore a write like any other account route.
   */
  requireActiveAccount: RequireAccount;
  sessionLimiter: RequestHandler;
  json: RequestHandler;
  db: Database.Database;
}

export function accountSessionRouter(deps: AccountSessionRouterDeps): Router {
  const router = Router();
  const { requireAccount, requireActiveAccount, sessionLimiter, json, db } = deps;

  // POST /v1/account/session - exchange Privy JWT for an internal session.
  // Returns { account_id, created } so the dashboard can branch on first-time
  // UX. Idempotent: repeat calls update last_seen_at and always succeed for a
  // valid token.
  router.post(
    "/v1/account/session",
    sessionLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireActiveAccount(req, {
        message: "invalid or missing Privy bearer token",
      });
      sendAccountSessionJsonResponse(res, accountSessionResponse(resolved));
    }),
  );

  // GET /v1/account/session — the ONE account route a closed account may still
  // call.
  //
  // Every other account route refuses a deactivated account, which is correct
  // and also leaves the dashboard with nothing to render: a client that only
  // ever gets 403 cannot tell "your account is closed" from "the server is
  // broken". This route answers that one question, and only that question. It
  // reads state, writes nothing, and is therefore safe to keep open.
  router.get(
    "/v1/account/session",
    sessionLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, {
        message: "invalid or missing Privy bearer token",
      });
      const base = accountSessionResponse(resolved);
      res.status(base.status).json({
        ...base.body,
        ...accountDeactivationState(db, resolved.account_id),
      });
    }),
  );

  return router;
}
