// GET /v1/account/activity — account-wide agent activity history (Privy
// auth). Query: limit, before + before_id (keyset cursor from `next`).

import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";

import { listAccountActivityResponse } from "../account-activity-surface.js";
import type { RequireAccount } from "../account-route-auth.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountActivityRouterDeps {
  requireAccount: RequireAccount;
  db: Database.Database;
  limiter: RequestHandler;
}

export function accountActivityRouter(deps: AccountActivityRouterDeps): Router {
  const router = Router();
  const { requireAccount, db, limiter } = deps;

  router.get(
    "/v1/account/activity",
    limiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const limitRaw = Number(req.query.limit);
      const result = listAccountActivityResponse({
        db,
        accountId: resolved.account_id,
        limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
        before: typeof req.query.before === "string" ? req.query.before : null,
        before_id:
          typeof req.query.before_id === "string" ? req.query.before_id : null,
      });
      res.status(result.status).json(result.body);
    }),
  );

  return router;
}
