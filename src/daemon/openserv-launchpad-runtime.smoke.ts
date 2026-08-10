import assert from "node:assert/strict";
import type Database from "better-sqlite3";

import type { StartLaunchpadOpenServParams } from "../integrations/openserv-launchpad.js";
import {
  startDaemonOpenServLaunchpad,
  type DaemonOpenServLaunchpadRuntimeDeps,
} from "./openserv-launchpad-runtime.js";

const db = {} as Database.Database;
const warnings: unknown[][] = [];
const logs: unknown[][] = [];
const logger = {
  log: (...args: unknown[]) => logs.push(args),
  warn: (...args: unknown[]) => warnings.push(args),
};
const now = () => new Date("2026-06-12T10:00:00Z");

const priorApiKey = process.env.OPENSERV_API_KEY;
process.env.OPENSERV_API_KEY = "ambient-api-key";

try {
  const baseConfig: DaemonOpenServLaunchpadRuntimeDeps["config"] = {
    enabled: true,
    port: 7378,
    apiKey: "configured-api-key",
    authToken: null,
    dashboardUrl: "https://configured-dashboard.example",
    publicApiUrl: "https://configured-api.example",
    launchpadStage: "configured-stage",
    launchpadProjectId: null,
    launchpadProjectUrl: null,
  };

  const skipped = await startDaemonOpenServLaunchpad({
    db,
    config: baseConfig,
    logger,
    now,
    skip: true,
  });
  assert.equal(skipped, null);
  assert.equal(warnings.length, 0);

  let disabledStartCalls = 0;
  const disabled = await startDaemonOpenServLaunchpad({
    db,
    config: { ...baseConfig, enabled: false, apiKey: null },
    logger,
    now,
    startAgent: async () => {
      disabledStartCalls += 1;
      return null;
    },
  });
  assert.equal(disabled, null);
  assert.equal(disabledStartCalls, 0);

  const startCalls: StartLaunchpadOpenServParams[] = [];
  let stopCalls = 0;
  const runtime = await startDaemonOpenServLaunchpad({
    db,
    config: {
      ...baseConfig,
      apiKey: "configured-api-key",
      authToken: "configured-auth-token",
      launchpadProjectId: "configured-project",
      launchpadProjectUrl: "https://configured.openserv.example",
    },
    logger,
    now,
    startAgent: async (params) => {
      startCalls.push(params);
      return {
        stop: async () => {
          stopCalls += 1;
        },
      };
    },
  });
  assert(runtime);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0]?.db, db);
  assert.deepEqual(startCalls[0]?.env, {});
  assert.equal(startCalls[0]?.logger, logger);
  assert.equal(startCalls[0]?.enabled, true);
  assert.equal(startCalls[0]?.apiKey, "configured-api-key");
  assert.equal(startCalls[0]?.authToken, "configured-auth-token");
  assert.equal(startCalls[0]?.dashboardUrl, "https://configured-dashboard.example");
  assert.equal(startCalls[0]?.publicApiUrl, "https://configured-api.example");
  assert.equal(startCalls[0]?.launchpadStage, "configured-stage");
  assert.equal(startCalls[0]?.launchpadProjectId, "configured-project");
  assert.equal(startCalls[0]?.now, now);
  assert.equal(
    startCalls[0]?.launchpadProjectUrl,
    "https://configured.openserv.example",
  );
  await runtime.stop();
  await runtime.stop();
  assert.equal(stopCalls, 1);
  assert.equal(warnings.length, 0);
  assert.equal(logs.length, 0);

  await assert.rejects(
    () =>
      startDaemonOpenServLaunchpad({
        db,
        config: baseConfig,
        logger,
        now,
        startAgent: async () => null,
      }),
    /OpenServ Launchpad agent did not start/,
  );
  assert.equal(warnings.length, 1);

  console.log("openserv-launchpad-runtime smoke ok");
} finally {
  if (priorApiKey === undefined) delete process.env.OPENSERV_API_KEY;
  else process.env.OPENSERV_API_KEY = priorApiKey;
}
