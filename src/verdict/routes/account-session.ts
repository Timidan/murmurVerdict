import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import {
  accountSessionResponse,
  sendAccountSessionJsonResponse,
} from "../account-session-surface.js";
import { requireAccount, type AccountAuthVerifier } from "../account-route-auth.js";
import type { AccountIdAdapter } from "../auth/accounts.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountSessionRouterDeps {
  accountAuth?: AccountAuthVerifier;
  db: Database.Database;
  sessionLimiter: RequestHandler;
  json: RequestHandler;
  newAccountId?: AccountIdAdapter;
  now: () => Date;
}

export function accountSessionRouter(deps: AccountSessionRouterDeps): Router {
  const router = Router();
  const { accountAuth, db, sessionLimiter, json, newAccountId, now } = deps;

  // POST /v1/account/session - exchange Privy JWT for an internal session.
  // Returns { account_id, created } so the dashboard can branch on first-time
  // UX. Idempotent: repeat calls update last_seen_at and always succeed for a
  // valid token.
  router.post(
    "/v1/account/session",
    sessionLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        message: "invalid or missing Privy bearer token",
        newAccountId,
        now,
      });
      sendAccountSessionJsonResponse(res, accountSessionResponse(resolved));
    }),
  );

  return router;
}
