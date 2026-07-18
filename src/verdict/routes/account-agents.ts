import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import {
  type AccountAgentIdAdapter,
  createAccountAgentResponse,
  listAccountAgentsResponse,
  sendAccountAgentJsonResponse,
} from "../account-agent-surface.js";
import type { RequireAccount } from "../account-route-auth.js";
import { asyncHandler } from "./async-handler.js";

export interface AccountAgentsRouterDeps {
  requireAccount: RequireAccount;
  db: Database.Database;
  createAgentLimiter: RequestHandler;
  listAgentsLimiter: RequestHandler;
  json: RequestHandler;
  newAgentId?: AccountAgentIdAdapter;
  now: () => Date;
}

export function accountAgentsRouter(deps: AccountAgentsRouterDeps): Router {
  const router = Router();
  const {
    requireAccount,
    db,
    createAgentLimiter,
    listAgentsLimiter,
    json,
    newAgentId,
    now,
  } = deps;

  // POST /v1/account/agents - create a casual-tier agent under this account.
  // Body: { display_slug, display_name, bio? }
  router.post(
    "/v1/account/agents",
    createAgentLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      sendAccountAgentJsonResponse(res, createAccountAgentResponse({
        db,
        accountId: resolved.account_id,
        body: req.body,
        newAgentId,
        operationInstant: now(),
      }));
    }),
  );

  // GET /v1/account/agents - list agents owned by this account.
  //
  // Surfaces destination address state so the settings UI can derive the
  // 24h cooldown countdown without an extra round-trip. Reads the columns
  // directly because the public AgentRow shape does not expose payout data.
  router.get(
    "/v1/account/agents",
    listAgentsLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      sendAccountAgentJsonResponse(res, listAccountAgentsResponse({
        db,
        accountId: resolved.account_id,
        servedAt: now(),
      }));
    }),
  );

  return router;
}
