import type Database from "better-sqlite3";

import type { VerdictEventBus } from "../events.js";
import type { MurmurPublicOrigin } from "../public-origin.js";

export interface SyndicationRouterDeps {
  db: Database.Database;
  events?: VerdictEventBus;
  now: () => Date;
  publicOrigin: MurmurPublicOrigin;
}
