import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import {
  listAccountRuntimeKeysResponse,
  mintAccountRuntimeKeyResponse,
  revokeAccountRuntimeKeyResponse,
  runtimeKeyChallengeResponse,
  sendAccountRuntimeKeyJsonResponse,
} from "../account-runtime-key-surface.js";
import { requireAccount, type AccountAuthVerifier } from "../account-route-auth.js";
import type { AccountIdAdapter } from "../auth/accounts.js";
import type { ControllerWalletAuthorizationNonceAdapter } from "../controller-wallet-authorization.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountRuntimeKeyRouterDeps {
  accountAuth?: AccountAuthVerifier;
  db: Database.Database;
  json: RequestHandler;
  listAgentsLimiter: RequestHandler;
  mintKeyLimiter: RequestHandler;
  newAccountId?: AccountIdAdapter;
  newAuthorizationNonce?: ControllerWalletAuthorizationNonceAdapter;
  newRuntimeKeyId?: () => string;
  newRuntimeKeySecret?: () => string;
  now: () => Date;
  rotateKeyLimiter: RequestHandler;
}

export function accountRuntimeKeyRouter(deps: AccountRuntimeKeyRouterDeps): Router {
  const router = Router();
  const {
    accountAuth,
    db,
    json,
    listAgentsLimiter,
    mintKeyLimiter,
    newAccountId,
    newAuthorizationNonce,
    newRuntimeKeyId,
    newRuntimeKeySecret,
    now,
    rotateKeyLimiter,
  } = deps;

  router.get(
    "/v1/account/agents/:slug/runtime-keys",
    listAgentsLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountRuntimeKeyJsonResponse(res, listAccountRuntimeKeysResponse({
        db,
        accountId: resolved.account_id,
        slug: String(req.params.slug ?? ""),
      }));
    }),
  );

  router.post(
    "/v1/account/agents/:slug/runtime-keys/challenge",
    mintKeyLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountRuntimeKeyJsonResponse(res, runtimeKeyChallengeResponse({
        db,
        accountId: resolved.account_id,
        slug: String(req.params.slug ?? ""),
        body: req.body,
        newAuthorizationNonce,
        now,
      }));
    }),
  );

  router.post(
    "/v1/account/agents/:slug/runtime-keys",
    mintKeyLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountRuntimeKeyJsonResponse(res, await mintAccountRuntimeKeyResponse({
        db,
        accountId: resolved.account_id,
        slug: String(req.params.slug ?? ""),
        body: req.body,
        newRuntimeKeyId,
        newRuntimeKeySecret,
        now,
      }));
    }),
  );

  router.delete(
    "/v1/account/runtime-keys/:key_id",
    rotateKeyLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountRuntimeKeyJsonResponse(res, revokeAccountRuntimeKeyResponse({
        db,
        accountId: resolved.account_id,
        keyId: String(req.params.key_id ?? ""),
        body: req.body,
        now,
      }));
    }),
  );

  return router;
}
