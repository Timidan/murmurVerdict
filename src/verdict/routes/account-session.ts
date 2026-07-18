import { Router, type RequestHandler } from "express";
import {
  accountSessionResponse,
  sendAccountSessionJsonResponse,
} from "../account-session-surface.js";
import type { RequireAccount } from "../account-route-auth.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountSessionRouterDeps {
  requireAccount: RequireAccount;
  sessionLimiter: RequestHandler;
  json: RequestHandler;
}

export function accountSessionRouter(deps: AccountSessionRouterDeps): Router {
  const router = Router();
  const { requireAccount, sessionLimiter, json } = deps;

  // POST /v1/account/session - exchange Privy JWT for an internal session.
  // Returns { account_id, created } so the dashboard can branch on first-time
  // UX. Idempotent: repeat calls update last_seen_at and always succeed for a
  // valid token.
  router.post(
    "/v1/account/session",
    sessionLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, {
        message: "invalid or missing Privy bearer token",
      });
      sendAccountSessionJsonResponse(res, accountSessionResponse(resolved));
    }),
  );

  return router;
}
