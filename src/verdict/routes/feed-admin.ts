import { Router } from "express";

import { feedAdminPacketRouter } from "./feed-admin-packet-routes.js";
import { feedAdminSlaRouter } from "./feed-admin-sla-routes.js";
import type { FeedAdminRouterDeps } from "./feed-admin-types.js";

export type { FeedAdminRouterDeps } from "./feed-admin-types.js";

export function feedAdminRouter(deps: FeedAdminRouterDeps): Router {
  const router = Router();

  router.use(feedAdminPacketRouter(deps));
  router.use(feedAdminSlaRouter(deps));

  return router;
}
