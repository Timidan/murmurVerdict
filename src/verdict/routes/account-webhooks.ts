// ─── Owner-scoped webhook management ────────────────────────────────────────
//
//   GET    /v1/account/webhooks       — every subscription on agents you own
//   DELETE /v1/account/webhooks/:id   — remove one, by ownership
//
// Creation still lives on POST /v1/webhooks, which already authenticates the
// account and hands back the HMAC secret exactly once. These two routes exist
// because after that dialog closes there was no way to see or remove what you
// had created: the read was by-id only and the delete required the secret.

import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";

import {
  deleteAccountWebhook,
  listAccountWebhooks,
} from "../account-webhooks-surface.js";
import type { RequireAccount } from "../account-route-auth.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountWebhooksRouterDeps {
  requireAccount: RequireAccount;
  db: Database.Database;
  listLimiter: RequestHandler;
  writeLimiter: RequestHandler;
}

export function accountWebhooksRouter(
  deps: AccountWebhooksRouterDeps,
): Router {
  const router = Router();
  const { requireAccount, db, listLimiter, writeLimiter } = deps;

  router.get(
    "/v1/account/webhooks",
    listLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const out = listAccountWebhooks({ db, accountId: resolved.account_id });
      res.status(out.status).json(out.body);
    }),
  );

  router.delete(
    "/v1/account/webhooks/:id",
    writeLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const out = deleteAccountWebhook({
        db,
        accountId: resolved.account_id,
        id: String((req as unknown as { params: { id?: string } }).params.id ?? ""),
      });
      res.status(out.status).json(out.body);
    }),
  );

  return router;
}
