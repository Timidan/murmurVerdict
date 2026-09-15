// ─── Account closure ────────────────────────────────────────────────────────
//
//   POST /v1/account/deactivate   { confirm: "close-my-account" }
//
// No reactivate endpoint; reopening goes through the operator.
// Exempt from the deactivation guard, so a repeat POST returns `already_deactivated: true`, not 403.

import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";

import { deactivateAccountSurface } from "../account-agent-lifecycle-surface.js";
import type { RequireAccount } from "../account-route-auth.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountDeactivateRouterDeps {
  requireAccount: RequireAccount;
  db: Database.Database;
  json: RequestHandler;
  limiter: RequestHandler;
  now: () => Date;
}

export function accountDeactivateRouter(
  deps: AccountDeactivateRouterDeps,
): Router {
  const router = Router();
  const { requireAccount, db, json, limiter, now } = deps;

  router.post(
    "/v1/account/deactivate",
    limiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const out = deactivateAccountSurface({
        db,
        accountId: resolved.account_id,
        body: req.body,
        now,
      });
      res.status(out.status).json(out.body);
    }),
  );

  return router;
}
