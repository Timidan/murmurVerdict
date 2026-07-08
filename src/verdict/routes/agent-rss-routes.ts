import { Router } from "express";

import {
  publicAgentRssResponse,
  sendPublicAgentRssResponse,
} from "../public-agent-rss-surface.js";
import { publicAgentRssQuery } from "../public-agent-query.js";
import { publicRssDashboardLinks } from "../public-rss-links.js";
import type { SyndicationRouterDeps } from "./syndication-types.js";

export function agentRssRouter(deps: SyndicationRouterDeps): Router {
  const router = Router();

  router.get("/v1/agents/:slug/calls.xml", (req, res) => {
    sendPublicAgentRssResponse(res, publicAgentRssResponse({
      db: deps.db,
      slug: String(req.params.slug ?? ""),
      query: publicAgentRssQuery(req.query),
      dashboardLinks: publicRssDashboardLinks({
        originHeader: req.header("origin"),
        refererHeader: req.header("referer"),
      }),
    }));
  });

  return router;
}
