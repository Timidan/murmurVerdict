import { Router, type Request } from "express";
import express from "express";
import type Database from "better-sqlite3";
import {
  dispatchAuth,
  type AuthIdentity as DispatchedAuthIdentity,
} from "../auth/dispatcher.js";
import type { PrivyAuthVerifier } from "../auth/privy.js";
import {
  createFeedContractResponse,
  type FeedContractIdAdapter,
  sendFeedContractJsonResponse,
} from "../feed-contract-surface.js";
import { ERROR_CODES, VerdictError } from "../schema.js";
import { asyncHandler } from "./async-handler.js";

export interface FeedContractsRouterDeps {
  db: Database.Database;
  newFeedId?: FeedContractIdAdapter;
  now: () => Date;
  privyAuth?: PrivyAuthVerifier;
}

export function feedContractsRouter(deps: FeedContractsRouterDeps): Router {
  const router = Router();
  const json = express.json({ limit: "32kb" });

  router.post(
    "/v1/feeds",
    json,
    asyncHandler(async (req, res) => {
      const auth = await requireAgentAuth(req, deps);
      sendFeedContractJsonResponse(res, createFeedContractResponse({
        db: deps.db,
        agentId: auth.agent_id,
        body: req.body,
        newFeedId: deps.newFeedId,
        now: deps.now,
      }));
    }),
  );

  return router;
}

async function requireAgentAuth(
  req: Request,
  deps: FeedContractsRouterDeps,
): Promise<DispatchedAuthIdentity & { agent_id: string }> {
  const authResult = await dispatchAuth(req, {
    db: deps.db,
    now: deps.now,
    privyAuth: deps.privyAuth,
  });
  if (!authResult) {
    throw new VerdictError(
      "auth required: provide Authorization: Bearer <privy> or X-Murmur-Api-Key",
      ERROR_CODES.agent_not_authorized,
      401,
    );
  }
  if (!authResult.agent_id) {
    throw new VerdictError(
      "X-Murmur-Agent-Slug header required: account owns no default agent",
      ERROR_CODES.agent_slug_required,
      400,
    );
  }
  return authResult as DispatchedAuthIdentity & { agent_id: string };
}
