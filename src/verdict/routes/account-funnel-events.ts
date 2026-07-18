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

  // POST /v1/account/events - thin allowlisted funnel-event emit (Phase 7d).
  //
  // Account-scoped audit trail for the Maya onboarding loop. The dashboard
  // fires one event per UX step (landing.viewed -> compete.clicked -> ... ->
  // destination.set) so we can measure where casual-tier signups drop off.
  //
  // Why account-scoped (agent_id=null) instead of agent-scoped: most of the
  // funnel happens BEFORE the user has an agent. The handful of post-create
  // events (api_key.minted, destination.set) could carry agent_id in their
  // attributes_json; we keep that as a payload field rather than the
  // usage_events.agent_id column because the column ON DELETE SET NULLs
  // (agent deletion should not wipe funnel history).
  //
  // Auth: same Privy bearer posture as the other /v1/account/* writes. A
  // 401 is silently swallowed by useFunnelEmit on the client so missed
  // emits never bubble into the UI.
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
