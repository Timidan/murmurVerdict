import { z } from "zod";
import type Database from "better-sqlite3";

export interface StartLaunchpadOpenServParams {
  db: Database.Database;
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  logger?: {
    log: (message?: unknown, ...optionalParams: unknown[]) => void;
    warn: (message?: unknown, ...optionalParams: unknown[]) => void;
  };
  port?: number;
  apiKey?: string;
  authToken?: string;
  systemPrompt?: string;
  dashboardUrl?: string;
  publicApiUrl?: string;
  launchpadProjectId?: string;
  launchpadProjectUrl?: string;
  launchpadStage?: string;
  now: () => Date;
}

type CapabilityRun = (params: { args: Record<string, unknown> }) => string | Promise<string>;

export interface LaunchpadCapability {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  run: CapabilityRun;
}
