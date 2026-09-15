import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import {
  emitAccountFunnelEventResponse,
  sendAccountFunnelEmptyResponse,
} from "../account-funnel-surface.js";
import type { RequireAccount } from "../account-route-auth.js";
import type { UsageEventIdAdapter } from "../usage-event.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountFunnelEventsRouterDeps {
  requireAccount: RequireAccount;
  db: Database.Database;
  funnelEventLimiter: RequestHandler;
  json: RequestHandler;
  newUsageEventId?: UsageEventIdAdapter;
  now: () => Date;
}

export function accountFunnelEventsRouter(
  deps: AccountFunnelEventsRouterDeps,
): Router {
  const router = Router();
  const {
    requireAccount,
    db,
    funnelEventLimiter,
    json,
    newUsageEventId,
    now,
  } = deps;

  // POST /v1/account/events - allowlisted onboarding funnel events, one per UX step.
  // Account-scoped (agent_id=null): most of the funnel happens before an agent exists.
  // Privy bearer auth; the client swallows 401s.
  router.post(
    "/v1/account/events",
    funnelEventLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      sendAccountFunnelEmptyResponse(res, emitAccountFunnelEventResponse({
        db,
        accountId: resolved.account_id,
        body: req.body,
        newUsageEventId,
        operationInstant: now(),
      }));
    }),
  );

  return router;
}
