// ─── Account closure ────────────────────────────────────────────────────────
//
//   POST /v1/account/deactivate   { confirm: "close-my-account" }
//
// One route, one direction. There is deliberately no reactivate endpoint: an
// account that can reopen itself is a pause, and this is not a pause. Reopening
// goes through the operator, with a person on the other end of it.
//
// The route itself is exempt from the deactivation guard the rest of the
// account router carries — a second POST from a client that never saw the
// first response returns `already_deactivated: true` instead of 403, which is
// what an idempotent close should do.

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
