import { Router } from "express";

import { openPublicEventStream } from "../public-event-stream-surface.js";
import type { SyndicationRouterDeps } from "./syndication-types.js";

export function syndicationStreamRouter(deps: SyndicationRouterDeps): Router {
  const router = Router();

  router.get("/v1/stream", (req, res) => {
    openPublicEventStream(req, res, {
      db: deps.db,
      events: deps.events,
      now: deps.now,
    });
  });

  return router;
}
