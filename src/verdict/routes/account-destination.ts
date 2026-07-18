import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import {
  sendAccountDestinationJsonResponse,
  setAccountDestinationAddressResponse,
} from "../account-destination-surface.js";
import type { RequireAccount } from "../account-route-auth.js";
import type { UsageEventIdAdapter } from "../usage-event.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountDestinationRouterDeps {
  requireAccount: RequireAccount;
  db: Database.Database;
  destinationCooldownMs?: number;
  destAddrLimiter: RequestHandler;
  json: RequestHandler;
  newUsageEventId?: UsageEventIdAdapter;
  now: () => Date;
}

export function accountDestinationRouter(deps: AccountDestinationRouterDeps): Router {
  const router = Router();
  const {
    requireAccount,
    db,
    destinationCooldownMs,
    destAddrLimiter,
    json,
    newUsageEventId,
    now,
  } = deps;

  router.patch(
    "/v1/account/agents/:slug/destination-address",
    destAddrLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      sendAccountDestinationJsonResponse(res, setAccountDestinationAddressResponse({
        db,
        accountId: resolved.account_id,
        slug: String(req.params.slug ?? ""),
        body: req.body,
        ...(destinationCooldownMs !== undefined ? { destinationCooldownMs } : {}),
        newUsageEventId,
        operationInstant: now(),
      }));
    }),
  );

  return router;
}
