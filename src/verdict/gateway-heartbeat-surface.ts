import type Database from "better-sqlite3";
import type { Request } from "express";
import { z } from "zod";

import { AgentSlugSchema, ERROR_CODES, VerdictError } from "./schema.js";
import {
  dispatchAuth,
  type AuthIdentity,
  type DispatchAuthDeps,
} from "./auth/dispatcher.js";
import { isRuntimeKeyActive, recordRuntimeKeyHeartbeat } from "./auth/runtime-keys.js";
import { requireRuntimeKeyIdentity } from "./auth/runtime-authorization.js";
import { POP_HEADER_NONCE } from "./auth/runtime-key-pop.js";
import type { PrivyAuthVerifier } from "./auth/privy.js";
import {
  HEARTBEAT_INTERVAL_SECONDS,
  HEARTBEAT_STALE_AFTER_SECONDS,
} from "./runtime-key-connection.js";
import type { GatewaySubmissionRequest } from "./gateway-submission-surface.js";
import { agentCredentialsDisabledAt } from "./auth/accounts.js";

const HeartbeatBodySchema = z.object({ agent_slug: AgentSlugSchema }).strict();

export interface GatewayHeartbeatSurfaceDeps {
  db: Database.Database;
  now: () => Date;
  privyAuth?: PrivyAuthVerifier;
  dispatchAuth?: (
    req: GatewaySubmissionRequest,
    deps: DispatchAuthDeps,
  ) => Promise<AuthIdentity | null>;
  popAudience?: string;
}

export interface GatewayHeartbeatResponse {
  status: 200;
  body: {
    pong: true;
    nonce: string;
    agent_slug: string;
    runtime_key_id: string;
    server_time: string;
    heartbeat_interval_seconds: 60;
    stale_after_seconds: 180;
  };
}

/** A signed runtime process check. It records no submission or chain work. */
export async function gatewayHeartbeatResponse(input: {
  req: GatewaySubmissionRequest;
  deps: GatewayHeartbeatSurfaceDeps;
  bodyJson: unknown;
}): Promise<GatewayHeartbeatResponse> {
  const parsed = HeartbeatBodySchema.safeParse(input.bodyJson);
  if (!parsed.success) {
    throw new VerdictError(
      "heartbeat body must be exactly { agent_slug }",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.format() },
    );
  }
  const auth = await (input.deps.dispatchAuth ?? defaultGatewayAuthDispatcher)(input.req, {
    db: input.deps.db,
    allowRuntimeKey: true,
    now: input.deps.now,
    privyAuth: input.deps.privyAuth,
    popAudience: input.deps.popAudience,
  });
  if (!auth) {
    throw new VerdictError(
      "heartbeat requires X-Murmur-Runtime-Key auth",
      ERROR_CODES.agent_not_authorized,
      401,
    );
  }
  const identity = requireRuntimeKeyIdentity(
    auth,
    "heartbeat requires X-Murmur-Runtime-Key auth",
  );
  if (!identity.runtime_key.signature_verified) {
    throw new VerdictError(
      "heartbeat requires a PoP-verified Runtime Key",
      ERROR_CODES.runtime_key_signature_invalid,
      401,
    );
  }
  const agent = input.deps.db.prepare(
    "SELECT display_slug FROM agents WHERE agent_id = ?",
  ).get(identity.agent_id) as { display_slug: string } | undefined;
  if (!agent || agent.display_slug !== parsed.data.agent_slug) {
    throw new VerdictError(
      "heartbeat agent_slug does not match Runtime Key identity",
      ERROR_CODES.agent_not_owned_by_account,
      403,
    );
  }

  const observedAt = input.deps.now();
  // dispatchAuth has an async suspension point. Recheck authorization and
  // update together, so a revocation/kill-switch landing while it waited
  // cannot leave a newly written presence timestamp behind.
  const recorded = input.deps.db.transaction(() => {
    if (agentCredentialsDisabledAt(input.deps.db, identity.account_id)) return false;
    if (!isRuntimeKeyActive(input.deps.db, {
      runtime_key_id: identity.runtime_key.runtime_key_id,
      checkedAt: observedAt,
    })) return false;
    return recordRuntimeKeyHeartbeat(input.deps.db, {
      runtime_key_id: identity.runtime_key.runtime_key_id,
      account_id: identity.account_id,
      agent_id: identity.agent_id,
      observedAt,
    });
  }).immediate();
  if (!recorded) {
    throw new VerdictError(
      "Runtime Key is no longer authorized",
      ERROR_CODES.agent_not_authorized,
      401,
    );
  }
  return {
    status: 200,
    body: {
      pong: true,
      nonce: input.req.header(POP_HEADER_NONCE)!,
      agent_slug: agent.display_slug,
      runtime_key_id: identity.runtime_key.runtime_key_id,
      server_time: observedAt.toISOString().replace(/\.\d+Z$/, "Z"),
      heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
      stale_after_seconds: HEARTBEAT_STALE_AFTER_SECONDS,
    },
  };
}

function defaultGatewayAuthDispatcher(
  req: GatewaySubmissionRequest,
  deps: DispatchAuthDeps,
): Promise<AuthIdentity | null> {
  return dispatchAuth(req as Request, deps);
}
