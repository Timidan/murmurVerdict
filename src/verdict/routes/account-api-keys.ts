import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import {
  listAgentApiKeysResponse,
  mintAgentApiKeyResponse,
  rotateAccountApiKeyResponse,
  sendAccountApiKeyJsonResponse,
} from "../account-api-key-surface.js";
import type { RequireAccount } from "../account-route-auth.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountApiKeyRouterDeps {
  requireAccount: RequireAccount;
  db: Database.Database;
  json: RequestHandler;
  listAgentsLimiter: RequestHandler;
  mintKeyLimiter: RequestHandler;
  newApiKeyId?: () => string;
  newApiKeySecret?: () => string;
  now: () => Date;
  rotateKeyLimiter: RequestHandler;
}

export function accountApiKeyRouter(deps: AccountApiKeyRouterDeps): Router {
  const router = Router();
  const {
    requireAccount,
    db,
    json,
    listAgentsLimiter,
    mintKeyLimiter,
    newApiKeyId,
    newApiKeySecret,
    now,
    rotateKeyLimiter,
  } = deps;

  router.get(
    "/v1/account/agents/:slug/api-keys",
    listAgentsLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
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
      const resolved = await requireAccount(req);
      sendAccountApiKeyJsonResponse(res, mintAgentApiKeyResponse({
        db,
        accountId: resolved.account_id,
        slug: String(req.params.slug ?? ""),
        body: req.body,
        newApiKeyId,
        newApiKeySecret,
        operationInstant: now(),
      }));
    }),
  );

  router.delete(
    "/v1/account/api-keys/:key_id",
    rotateKeyLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      sendAccountApiKeyJsonResponse(res, rotateAccountApiKeyResponse({
        db,
        accountId: resolved.account_id,
        keyId: String(req.params.key_id ?? ""),
        operationInstant: now(),
      }));
    }),
  );

  return router;
}
