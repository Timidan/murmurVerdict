import type { Request, Response } from "express";
import type Database from "better-sqlite3";

import type { FhenixEventVerifier } from "../../integrations/fhenix-events.js";
import type { LiveCanaryProvider } from "../../integrations/live-canaries.js";
import type { VerdictEventBus } from "../events.js";
import type { OperatorAlertSinkConfig } from "../operator-alerts.js";
import type { OperatorAlertIdAdapter } from "../operator-alerts.js";
import type { OperatorFhenixLifecycleQueryDefaults } from "../operator-fhenix-lifecycle-query.js";
import type { SealedCallIdAdapter } from "../sealed-call-acceptance.js";

export interface OperatorControlRouterDeps {
  db: Database.Database;
  events?: VerdictEventBus;
  fhenixVerifier: FhenixEventVerifier | null;
  fhenixLifecycleQueryDefaults?: OperatorFhenixLifecycleQueryDefaults;
  liveCanaries?: LiveCanaryProvider | null;
  newOperatorAlertId?: OperatorAlertIdAdapter;
  newSealedCallId?: SealedCallIdAdapter;
  now: () => Date;
  operatorAlertSink?: OperatorAlertSinkConfig | null;
  requireAdmin: (req: Request, res: Response) => boolean;
  requireAdminBearer: (req: Request, res: Response) => boolean;
  requireFhenixVerifier: () => FhenixEventVerifier;
}
