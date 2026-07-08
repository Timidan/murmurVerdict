import { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import type { AgentSecurityEventIdAdapter } from "../agent-security-event.js";
import {
  deleteRefSenderResponse,
  refTopSendersResponse,
  sendDeleteRefSenderResponse,
  sendRefAttributionJsonResponse,
} from "../ref-attribution.js";
import { adminRefTopSendersQuery } from "../ref-attribution-query.js";

export interface RefManagementRouterDeps {
  db: Database.Database;
  adminEnabled: boolean;
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  now: () => Date;
  requireAdminHeader: (req: Request, res: Response) => boolean;
}

export function refManagementRouter(deps: RefManagementRouterDeps): Router {
  const router = Router();

  router.get("/v1/refs", (req, res) => {
    if (deps.adminEnabled && !deps.requireAdminHeader(req, res)) {
      return;
    }
    sendRefAttributionJsonResponse(res, refTopSendersResponse(deps.db, {
      servedAt: deps.now(),
      query: adminRefTopSendersQuery(req.query),
    }));
  });

  // Admin-only delete of a sender's ref bucket, with audit locality kept next
  // to the destructive write.
  router.delete("/v1/refs/:ref", (req, res) => {
    if (!deps.requireAdminHeader(req, res)) return;
    const result = deleteRefSenderResponse({
      db: deps.db,
      ref: req.params.ref,
      actor: "admin_token",
      newAgentSecurityEventId: deps.newAgentSecurityEventId,
      now: deps.now,
    });
    sendDeleteRefSenderResponse(res, result);
  });

  return router;
}
