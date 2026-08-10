import { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";

import { listRefundDueResponse } from "../entitlement-refunds-surface.js";
import { asyncHandler } from "./async-handler.js";

// Operator-facing view of settled payments owed a refund. Refunds are a MANUAL
// duty — enabling paid grants requires acknowledging exactly that
// (MURMUR_ACK_MANUAL_REFUNDS) — and until this route existed, honouring them
// meant querying the database by hand.
export interface AdminEntitlementsRouterDeps {
  db: Database.Database;
  requireAdmin: (req: Request, res: Response) => boolean;
}

export function adminEntitlementsRouter(
  deps: AdminEntitlementsRouterDeps,
): Router {
  const router = Router();

  router.get(
    "/v1/admin/entitlements/refunds",
    asyncHandler(async (req, res) => {
      if (!deps.requireAdmin(req, res)) return;
      const raw = (req.query as Record<string, unknown>).limit;
      const out = listRefundDueResponse(deps.db, {
        limit:
          typeof raw === "string" && /^[0-9]+$/.test(raw) ? Number(raw) : undefined,
      });
      res.status(out.status).json(out.body);
    }),
  );

  return router;
}
