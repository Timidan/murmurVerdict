import { agentsRepo } from "../verdict/repos/agents-repo.js";
import { publicMurmurAgentProfile } from "../verdict/murmur-agent-public-profile.js";
import {
  SCHEMA_VERSION,
} from "../verdict/schema.js";
import { nowIso } from "../verdict/time.js";

export function publicAgent(row: ReturnType<typeof agentsRepo.bySlug>) {
  return publicMurmurAgentProfile(row);
}

export interface OpenServLaunchpadJsonOptions {
  servedAt: Date;
}

export function okJson(
  kind: string,
  body: Record<string, unknown>,
  opts: OpenServLaunchpadJsonOptions,
): string {
  return JSON.stringify({
    kind,
    schema_version: SCHEMA_VERSION,
    served_at: nowIso(opts.servedAt),
    ...body,
  });
}

export function jsonError(
  httpStatus: number,
  code: string,
  message: string,
  context?: Record<string, unknown>,
): string {
  return JSON.stringify({
    kind: "murmur_openserv_error",
    schema_version: SCHEMA_VERSION,
    ok: false,
    httpStatus,
    code,
    message,
    ...(context ? { context } : {}),
  });
}
