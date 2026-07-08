import express, { Router } from "express";

import {
  recordRefClickResponse,
  refAgentDiscoverersResponse,
  refTopSendersResponse,
  sendRecordRefClickResponse,
  sendRefAttributionJsonResponse,
} from "../ref-attribution.js";
import {
  publicRefTopSendersQuery,
  refAgentDiscoverersQuery,
} from "../ref-attribution-query.js";
import type { SyndicationRouterDeps } from "./syndication-types.js";

export function refAttributionRouter(deps: SyndicationRouterDeps): Router {
  const router = Router();

  router.post(
    "/v1/refs/:ref/click",
    express.json({ limit: "1kb" }),
    (req, res) => {
      const result = recordRefClickResponse({
        db: deps.db,
        ref: req.params.ref,
        agentSlug: (req.body ?? {})?.agent_slug,
        now: deps.now,
      });
      sendRecordRefClickResponse(res, result);
    },
  );

  router.get("/v1/refs/top", (req, res) => {
    sendRefAttributionJsonResponse(res, refTopSendersResponse(deps.db, {
      servedAt: deps.now(),
      query: publicRefTopSendersQuery(req.query),
    }));
  });

  router.get("/v1/agents/:slug/discoverers", (req, res) => {
    sendRefAttributionJsonResponse(res, refAgentDiscoverersResponse(deps.db, {
      slug: req.params.slug,
      query: refAgentDiscoverersQuery(req.query),
    }));
  });

  return router;
}
