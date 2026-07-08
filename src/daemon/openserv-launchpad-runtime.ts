import type Database from "better-sqlite3";

import type { StartLaunchpadOpenServParams } from "../integrations/openserv-launchpad.js";
import type { OpenServLaunchpadRuntimeConfig } from "./daemon-config.js";

interface OpenServLaunchpadAgentRuntime {
  stop(): Promise<void>;
}

type StartOpenServLaunchpadAgent = (
  params: StartLaunchpadOpenServParams,
) => Promise<OpenServLaunchpadAgentRuntime | null>;

export interface DaemonOpenServLaunchpadRuntime {
  stop(): Promise<void>;
}

export interface DaemonOpenServLaunchpadRuntimeDeps {
  db: Database.Database;
  config: OpenServLaunchpadRuntimeConfig;
  logger?: Pick<Console, "log" | "warn">;
  now: () => Date;
  skip?: boolean;
  startAgent?: StartOpenServLaunchpadAgent;
}

export async function startDaemonOpenServLaunchpad(
  deps: DaemonOpenServLaunchpadRuntimeDeps,
): Promise<DaemonOpenServLaunchpadRuntime | null> {
  const { config, db, logger = console, skip = false } = deps;
  if (skip || !config.enabled) return null;

  try {
    const startAgent = deps.startAgent ?? loadStartOpenServLaunchpadAgent;
    const agent = await startAgent({
      db,
      enabled: true,
      env: {},
      port: config.port,
      logger,
      apiKey: config.apiKey ?? undefined,
      authToken: config.authToken ?? undefined,
      dashboardUrl: config.dashboardUrl,
      publicApiUrl: config.publicApiUrl,
      launchpadStage: config.launchpadStage,
      launchpadProjectId: config.launchpadProjectId ?? undefined,
      launchpadProjectUrl: config.launchpadProjectUrl ?? undefined,
      now: deps.now,
    });
    if (!agent) return null;
    let stopped = false;
    return {
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        await agent.stop();
      },
    };
  } catch (err) {
    logger.warn("[daemon] OpenServ Launchpad agent failed to start:", err);
    return null;
  }
}

async function loadStartOpenServLaunchpadAgent(
  params: StartLaunchpadOpenServParams,
): Promise<OpenServLaunchpadAgentRuntime | null> {
  const { startLaunchpadOpenServAgent } = await import(
    "../integrations/openserv-launchpad.js"
  );
  return startLaunchpadOpenServAgent(params);
}
