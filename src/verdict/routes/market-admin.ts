import { Router, type Request, type Response } from "express";
import express from "express";
import type Database from "better-sqlite3";
import type { AgentSecurityEventIdAdapter } from "../agent-security-event.js";
import {
  registerPolymarketMarketFromAdminBody,
  type PolymarketMarketRegistrationGammaAdapter,
  sendPolymarketMarketRegistrationJsonResponse,
} from "../polymarket-market-registration.js";
import { asyncHandler } from "./async-handler.js";

export interface MarketAdminRouterDeps {
  db: Database.Database;
  gammaLookup?: PolymarketMarketRegistrationGammaAdapter;
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  now: () => Date;
  requireAdminHeader: (req: Request, res: Response) => boolean;
}

export function marketAdminRouter(deps: MarketAdminRouterDeps): Router {
  const router = Router();

  router.post(
    "/v1/admin/markets/polymarket",
    express.json(),
    asyncHandler(async (req, res) => {
      if (!deps.requireAdminHeader(req, res)) return;
      const result = await registerPolymarketMarketFromAdminBody({
        db: deps.db,
        body: req.body,
        gammaLookup: deps.gammaLookup,
        newAgentSecurityEventId: deps.newAgentSecurityEventId,
        now: deps.now,
      });
      sendPolymarketMarketRegistrationJsonResponse(res, result);
    }),
  );

  return router;
}
