// ─── Operator payout journal ────────────────────────────────────────────────
//
//   POST /v1/admin/payouts
//
// Providers are paid manually (the rail settles to one seller address); the operator records
// the transfer here, and owners read it at GET /v1/account/agents/:slug/payouts.
// Admin-token auth only: a Privy session must never write what an owner is shown as owed.

import { Router, type Request, type Response } from "express";
import express from "express";
import type Database from "better-sqlite3";

import { recordProviderPayout } from "../provider-payout-journal.js";
import { asyncHandler } from "./async-handler.js";

export interface AdminPayoutsRouterDeps {
  db: Database.Database;
  requireAdmin: (req: Request, res: Response) => boolean;
  now: () => Date;
}

export function adminPayoutsRouter(deps: AdminPayoutsRouterDeps): Router {
  const router = Router();
  const json = express.json({ limit: "8kb" });

  router.post(
    "/v1/admin/payouts",
    json,
    asyncHandler(async (req, res) => {
      // requireAdmin writes its own failure response and returns false.
      if (!deps.requireAdmin(req, res)) return;
      const out = recordProviderPayout({
        db: deps.db,
        body: req.body,
        now: deps.now,
      });
      res.status(out.status).json(out.body);
    }),
  );

  return router;
}
