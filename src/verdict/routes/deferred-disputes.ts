import { Router } from "express";
import { sendRetiredRoute } from "../retired-route-response.js";

export function deferredDisputeRouter(): Router {
  const router = Router();

  router.post("/v1/disputes", (_req, res) => {
    sendRetiredRoute(res, {
      message:
        "Disputes are deferred. The sealed Fhenix path will verify public outcomes and reveal transcripts.",
    });
  });

  router.post("/v1/disputes/:dispute_id/resolve", (_req, res) => {
    sendRetiredRoute(res, {
      message:
        "Disputes are deferred. The sealed Fhenix path will verify public outcomes and reveal transcripts.",
    });
  });

  return router;
}
