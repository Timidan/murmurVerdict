import { Router } from "express";

import {
  publicAgentRssResponse,
  sendPublicAgentRssResponse,
} from "../public-agent-rss-surface.js";
import { publicAgentRssQuery } from "../public-agent-query.js";
import { publicRssDashboardLinks } from "../public-rss-links.js";
import { publicApiUrlForRequest } from "../public-origin.js";
import type { SyndicationRouterDeps } from "./syndication-types.js";

export function agentRssRouter(deps: SyndicationRouterDeps): Router {
  const router = Router();

  router.get("/v1/agents/:slug/calls.xml", (req, res) => {
    sendPublicAgentRssResponse(res, publicAgentRssResponse({
      db: deps.db,
      slug: String(req.params.slug ?? ""),
      query: publicAgentRssQuery(req.query),
      // Configured dashboard origin, else the origin this request was served
      // on. NEVER the Origin/Referer headers — the response is shared-cached
      // without Vary, so a caller-controlled origin would poison it.
      dashboardLinks: publicRssDashboardLinks(
        deps.publicOrigin.dashboardUrl ??
          publicApiUrlForRequest(deps.publicOrigin, req),
      ),
    }));
  });

  return router;
}
