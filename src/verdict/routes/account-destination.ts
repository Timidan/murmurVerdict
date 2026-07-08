import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import {
  sendAccountDestinationJsonResponse,
  setAccountDestinationAddressResponse,
} from "../account-destination-surface.js";
import { requireAccount, type AccountAuthVerifier } from "../account-route-auth.js";
import type { AccountIdAdapter } from "../auth/accounts.js";
import type { UsageEventIdAdapter } from "../usage-event.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountDestinationRouterDeps {
  accountAuth?: AccountAuthVerifier;
  db: Database.Database;
  destinationCooldownMs?: number;
  destAddrLimiter: RequestHandler;
  json: RequestHandler;
  newAccountId?: AccountIdAdapter;
  newUsageEventId?: UsageEventIdAdapter;
  now: () => Date;
}

export function accountDestinationRouter(deps: AccountDestinationRouterDeps): Router {
  const router = Router();
  const {
    accountAuth,
    db,
    destinationCooldownMs,
    destAddrLimiter,
    json,
    newAccountId,
    newUsageEventId,
    now,
  } = deps;

  router.patch(
    "/v1/account/agents/:slug/destination-address",
    destAddrLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req, db, accountAuth, {
        newAccountId,
        now,
      });
      sendAccountDestinationJsonResponse(res, setAccountDestinationAddressResponse({
        db,
        accountId: resolved.account_id,
        slug: String(req.params.slug ?? ""),
        body: req.body,
        ...(destinationCooldownMs !== undefined ? { destinationCooldownMs } : {}),
        newUsageEventId,
        now,
      }));
    }),
  );

  return router;
}
