import type { Agent as OpenServAgent } from "@openserv-labs/sdk";

import { buildLaunchpadOpenServCapabilities } from "./openserv-launchpad-capabilities.js";
import type { StartLaunchpadOpenServParams } from "./openserv-launchpad-types.js";

let singleton: OpenServAgent | null = null;

export class OpenServLaunchpadConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "OpenServLaunchpadConfigError";
    this.key = key;
  }
}

export async function startLaunchpadOpenServAgent(
  params: StartLaunchpadOpenServParams,
): Promise<OpenServAgent | null> {
  const env = params.env ?? process.env;
  const logger = params.logger ?? console;
  const enabled = params.enabled ?? enabledFromEnv(env.OPENSERV_LAUNCHPAD_ENABLED);
  if (!enabled) {
    throw new OpenServLaunchpadConfigError(
      "OPENSERV_LAUNCHPAD_ENABLED",
      "OpenServ Launchpad is required and cannot be disabled",
    );
  }
  if (singleton) return singleton;

  const apiKey = params.apiKey ?? env.OPENSERV_API_KEY?.trim();
  const authToken = params.authToken ?? env.OPENSERV_AUTH_TOKEN?.trim();
  if (!apiKey) {
    throw new OpenServLaunchpadConfigError(
      "OPENSERV_API_KEY",
      "OpenServ Launchpad requires OPENSERV_API_KEY",
    );
  }
  const port = parsePort(
    params.port ?? env.OPENSERV_LAUNCHPAD_PORT,
    7378,
    "OPENSERV_LAUNCHPAD_PORT",
  );

  const { Agent } = await import("@openserv-labs/sdk");
  const agent = new Agent({
    apiKey,
    authToken,
    port,
    systemPrompt:
      params.systemPrompt ??
      [
        "You are Murmur's OpenServ Launchpad agent.",
        "Help users discover public Murmur markets, agent scorecards, rankings, public calls, and dashboard links.",
        "You do not submit verdicts, touch private Fhenix data, score calls, resolve markets, or deliver subscriber feeds.",
      ].join(" "),
  });

  const capabilities = buildLaunchpadOpenServCapabilities({ ...params, env });
  for (const capability of capabilities) {
    agent.addCapability(capability);
  }

  await agent.start();
  singleton = agent;
  logger.log(
    `[openserv-launchpad] agent listening on port ${port} with ${capabilities.length} public launchpad capabilities`,
  );
  return agent;
}

export async function stopLaunchpadOpenServAgent(): Promise<void> {
  const agent = singleton;
  if (!agent) return;
  singleton = null;
  await agent.stop();
}

function enabledFromEnv(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new OpenServLaunchpadConfigError(
    "OPENSERV_LAUNCHPAD_ENABLED",
    "must be one of true, false, 1, 0, yes, or no",
  );
}

function parsePort(
  raw: number | string | undefined,
  fallback: number,
  key: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(raw.trim());
  if (Number.isInteger(value) && value >= 0 && value <= 65_535) {
    return value;
  }
  throw new OpenServLaunchpadConfigError(
    key,
    "must be an integer from 0 to 65535",
  );
}
