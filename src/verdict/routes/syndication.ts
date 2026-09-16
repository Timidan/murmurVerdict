import { Router } from "express";

import { agentRssRouter } from "./agent-rss-routes.js";
import { sharePageRouter } from "./share-page-routes.js";
import { syndicationMediaRouter } from "./syndication-media-routes.js";
import { syndicationStreamRouter } from "./syndication-stream-routes.js";
import type { SyndicationRouterDeps } from "./syndication-types.js";

export type { SyndicationRouterDeps } from "./syndication-types.js";

export function syndicationRouter(deps: SyndicationRouterDeps): Router {
  const router = Router();

  router.use(agentRssRouter(deps));
  router.use(syndicationMediaRouter(deps));
  router.use(sharePageRouter(deps));
  router.use(syndicationStreamRouter(deps));

  return router;
}
