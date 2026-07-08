import { Router } from "express";

import { operatorAlertRoutes } from "./operator-alert-routes.js";
import { operatorFhenixRoutes } from "./operator-fhenix-routes.js";
import { operatorMonitoringRoutes } from "./operator-monitoring-routes.js";
import type { OperatorControlRouterDeps } from "./operator-control-types.js";

export type { OperatorControlRouterDeps } from "./operator-control-types.js";

export function operatorControlRouter(deps: OperatorControlRouterDeps): Router {
  const router = Router();
  router.use(operatorFhenixRoutes(deps));
  router.use(operatorMonitoringRoutes(deps));
  router.use(operatorAlertRoutes(deps));
  return router;
}
