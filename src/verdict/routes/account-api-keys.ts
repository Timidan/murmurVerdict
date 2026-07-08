import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import {
  listAgentApiKeysResponse,
  mintAgentApiKeyResponse,
  rotateAccountApiKeyResponse,
  sendAccountApiKeyJsonResponse,
} from "../account-api-key-surface.js";
import { requireAccount, type AccountAuthVerifier } from "../account-route-auth.js";
import type { AccountIdAdapter } from "../auth/accounts.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountApiKeyRouterDeps {
  accountAuth?: AccountAuthVerifier;
  db: Database.Database;
  json: RequestHandler;
  listAgentsLimiter: RequestHandler;
  mintKeyLimiter: RequestHandler;
  newAccountId?: AccountIdAdapter;
  newApiKeyId?: () => string;
  newApiKeySecret?: () => string;
  now: () => Date;
  rotateKeyLimiter: RequestHandler;
}

export function accountApiKeyRouter(deps: AccountApiKeyRouterDeps): Router {
  const router = Router();
  const {
    accountAuth,
    db,
    json,
    listAgentsLimiter,
    mintKeyLimiter,
    newAccountId,
    newApiKeyId,
    newApiKeySecret,
    now,
    rotateKeyLimiter,
  } = deps;

  router.get(
    "/v1/account/agents/:slug/api-keys",
    listAgentsLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountApiKeyJsonResponse(res, listAgentApiKeysResponse({
        db,
        accountId: resolved.account_id,
        slug: String(req.params.slug ?? ""),
      }));
    }),
  );

  router.post(
    "/v1/account/agents/:slug/api-keys",
    mintKeyLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountApiKeyJsonResponse(res, mintAgentApiKeyResponse({
        db,
        accountId: resolved.account_id,
        slug: String(req.params.slug ?? ""),
        body: req.body,
        newApiKeyId,
        newApiKeySecret,
        now,
      }));
    }),
  );

  router.delete(
    "/v1/account/api-keys/:key_id",
    rotateKeyLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountApiKeyJsonResponse(res, rotateAccountApiKeyResponse({
        db,
        accountId: resolved.account_id,
        keyId: String(req.params.key_id ?? ""),
        now,
      }));
    }),
  );

  return router;
}
