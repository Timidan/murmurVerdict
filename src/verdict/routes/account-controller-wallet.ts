import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import {
  bindControllerWalletResponse,
  controllerWalletChallengeResponse,
  controllerWalletReattestationChallengeResponse,
  reattestControllerWalletResponse,
  sendAccountControllerWalletJsonResponse,
} from "../account-controller-wallet-surface.js";
import type {
  AccountIdAdapter,
  ControllerWalletReattestationIdAdapter,
} from "../auth/accounts.js";
import { requireAccount, type AccountAuthVerifier } from "../account-route-auth.js";
import type { ControllerWalletAuthorizationNonceAdapter } from "../controller-wallet-authorization.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountControllerWalletRouterDeps {
  accountAuth?: AccountAuthVerifier;
  db: Database.Database;
  destAddrLimiter: RequestHandler;
  json: RequestHandler;
  newAccountId?: AccountIdAdapter;
  newAuthorizationNonce?: ControllerWalletAuthorizationNonceAdapter;
  newReattestationId?: ControllerWalletReattestationIdAdapter;
  now: () => Date;
}

export function accountControllerWalletRouter(
  deps: AccountControllerWalletRouterDeps,
): Router {
  const router = Router();
  const {
    accountAuth,
    db,
    destAddrLimiter,
    json,
    newAccountId,
    newAuthorizationNonce,
    newReattestationId,
    now,
  } = deps;

  router.post(
    "/v1/account/agents/:slug/wallet/challenge",
    destAddrLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountControllerWalletJsonResponse(res, controllerWalletChallengeResponse({
        db,
        accountId: resolved.account_id,
        slug: String(req.params.slug ?? ""),
        body: req.body,
        now,
      }));
    }),
  );

  router.patch(
    "/v1/account/agents/:slug/wallet",
    destAddrLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountControllerWalletJsonResponse(res, await bindControllerWalletResponse({
        db,
        accountId: resolved.account_id,
        slug: String(req.params.slug ?? ""),
        body: req.body,
        now,
      }));
    }),
  );

  router.post(
    "/v1/account/agents/:slug/wallet/reattest/challenge",
    destAddrLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountControllerWalletJsonResponse(res, controllerWalletReattestationChallengeResponse({
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
    "/v1/account/agents/:slug/wallet/reattest",
    destAddrLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountControllerWalletJsonResponse(res, await reattestControllerWalletResponse({
        db,
        accountId: resolved.account_id,
        slug: String(req.params.slug ?? ""),
        body: req.body,
        newReattestationId,
        now,
      }));
    }),
  );

  return router;
}
