// ─── Operator payout journal ────────────────────────────────────────────────
//
//   POST /v1/admin/payouts
//
// Paying a provider is a manual step — the payment rail settles every sale to
// murmur's single seller address — so this route is how the operator writes
// down that the transfer happened. The owner reads the same rows back at
// GET /v1/account/agents/:slug/payouts and can check them against what accrued.
//
// Admin-token auth, exactly like /v1/admin/entitlements/refunds: this moves the
// number an agent owner is shown as owed, and a Privy session must never be
// able to write it.

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
