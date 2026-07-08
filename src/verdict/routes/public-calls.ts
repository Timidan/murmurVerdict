import { Router } from "express";
import type Database from "better-sqlite3";
import { sendRetiredRoute } from "../retired-route-response.js";
import {
  publicCallDetailResponse,
  sendPublicCallJsonResponse,
} from "../public-call-surface.js";

export interface PublicCallRouterDeps {
  db: Database.Database;
}

export function publicCallRouter(deps: PublicCallRouterDeps): Router {
  const router = Router();

  router.post("/v1/calls", (_req, res) => {
    sendRetiredRoute(res, {
      message:
        "/v1/calls is retired. Submit via /v2/gateway/calls with a Runtime Key and already-created CoFHE encrypted inputs.",
      replacement: "/v2/gateway/calls",
    });
  });

  router.post("/v2/calls", (_req, res) => {
    sendRetiredRoute(res, {
      message:
        "/v2/calls is retired as an agent submission path. Submit via /v2/gateway/calls with a Runtime Key.",
      replacement: "/v2/gateway/calls",
    });
  });

  router.post("/v1/calls/:call_id/reveal", (_req, res) => {
    sendRetiredRoute(res, {
      message:
        "/v1/calls/:call_id/reveal is retired. Fhenix reveals are ingested from verified contract events via /v1/admin/fhenix/reveals.",
    });
  });

  router.get("/v1/calls/:call_id/envelope", (_req, res) => {
    sendRetiredRoute(res, {
      message:
        "/v1/calls/:call_id/envelope is retired. Sealed Fhenix call metadata is available on /v1/calls/:call_id.",
    });
  });

  // Call/reveal/resolution rows are the canonical evidence trail. Pending
  // verdict fields stay private; public Fhenix Reveal details appear once
  // Reveal Ingestion has attached a revealed/invalid terminal row.
  router.get("/v1/calls/:call_id", (req, res) => {
    sendPublicCallJsonResponse(res, publicCallDetailResponse({
      db: deps.db,
      callId: String(req.params.call_id ?? ""),
    }));
  });

  return router;
}
