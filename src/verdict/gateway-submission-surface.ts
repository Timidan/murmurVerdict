import type Database from "better-sqlite3";
import type { Request } from "express";

import {
  dispatchAuth,
  type AuthIdentity,
  type DispatchAuthDeps,
} from "./auth/dispatcher.js";
import type { PrivyAuthVerifier } from "./auth/privy.js";
import type {
  FhenixGatewayBroadcaster,
  GatewayFeedPacketSubmitResult,
  GatewaySubmitResult,
} from "../integrations/fhenix-gateway.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

type GatewaySubmissionAdapter = Pick<
  FhenixGatewayBroadcaster,
  "submitFeedPacket" | "submitMurmurSealedCall" | "submitSealedCall"
>;

export interface GatewaySubmissionRequest {
  header(name: string): string | undefined;
  /** Present on real express requests; PoP-bound runtime keys fail closed
   *  without them. Optional so header-only smoke fakes keep compiling and
   *  exercise bearer-only keys. */
  method?: string;
  originalUrl?: string;
  /** Raw-body sha256 from the gateway router's express.json verify hook. */
  murmurRawBodySha256?: string;
}

export type GatewayAuthDispatcher = (
  req: GatewaySubmissionRequest,
  deps: DispatchAuthDeps,
) => Promise<AuthIdentity | null>;

export interface GatewaySubmissionSurfaceDeps {
  db: Database.Database;
  fhenixGateway?: GatewaySubmissionAdapter | null;
  now: () => Date;
  privyAuth?: PrivyAuthVerifier;
  dispatchAuth?: GatewayAuthDispatcher;
}

export type GatewaySubmissionResponse =
  | GatewaySubmitResult
  | GatewayFeedPacketSubmitResult;

export interface GatewaySubmissionJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendGatewaySubmissionJsonResponse(
  res: GatewaySubmissionJsonResponseTarget,
  result: GatewaySubmissionResponse,
): void {
  res.status(result.status).json(result.body);
}

export async function gatewaySealedCallSubmissionResponse(input: {
  req: GatewaySubmissionRequest;
  deps: GatewaySubmissionSurfaceDeps;
  bodyJson: unknown;
}): Promise<GatewaySubmitResult> {
  const gateway = requireGateway(input.deps.fhenixGateway);
  const authResult = await requireGatewayRuntimeAuth(input.req, input.deps);
  return gateway.submitSealedCall({
    authResult,
    bodyJson: input.bodyJson,
  });
}

export async function gatewayMurmurSealedCallSubmissionResponse(input: {
  req: GatewaySubmissionRequest;
  deps: GatewaySubmissionSurfaceDeps;
  bodyJson: unknown;
}): Promise<GatewaySubmitResult> {
  const gateway = requireGateway(input.deps.fhenixGateway);
  const authResult = await requireGatewayRuntimeAuth(input.req, input.deps);
  return gateway.submitMurmurSealedCall({
    authResult,
    bodyJson: input.bodyJson,
  });
}

export async function gatewayFeedPacketSubmissionResponse(input: {
  req: GatewaySubmissionRequest;
  deps: GatewaySubmissionSurfaceDeps;
  feedId: string;
  bodyJson: unknown;
}): Promise<GatewayFeedPacketSubmitResult> {
  const gateway = requireGateway(input.deps.fhenixGateway);
  const authResult = await requireGatewayRuntimeAuth(input.req, input.deps);
  return gateway.submitFeedPacket({
    authResult,
    feedId: input.feedId,
    bodyJson: input.bodyJson,
  });
}

function requireGateway(
  gateway: GatewaySubmissionAdapter | null | undefined,
): GatewaySubmissionAdapter {
  if (!gateway) {
    throw new VerdictError(
      "Fhenix Gateway broadcaster is not configured; set FHENIX_GATEWAY_ENABLED=true with relayer credentials",
      ERROR_CODES.oracle_unavailable,
      503,
    );
  }
  return gateway;
}

async function requireGatewayRuntimeAuth(
  req: GatewaySubmissionRequest,
  deps: GatewaySubmissionSurfaceDeps,
): Promise<AuthIdentity> {
  const auth = deps.dispatchAuth ?? defaultGatewayAuthDispatcher;
  const authResult = await auth(req, {
    db: deps.db,
    allowRuntimeKey: true,
    now: deps.now,
    privyAuth: deps.privyAuth,
  });
  if (!authResult) {
    throw new VerdictError(
      "gateway auth required: provide X-Murmur-Runtime-Key",
      ERROR_CODES.agent_not_authorized,
      401,
    );
  }
  return authResult;
}

function defaultGatewayAuthDispatcher(
  req: GatewaySubmissionRequest,
  deps: DispatchAuthDeps,
): Promise<AuthIdentity | null> {
  return dispatchAuth(req as Request, deps);
}
