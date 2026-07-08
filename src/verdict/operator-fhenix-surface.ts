import type Database from "better-sqlite3";
import type { FhenixEventVerifier } from "../integrations/fhenix-events.js";

import {
  FhenixInvalidRevealBodySchema,
  FhenixRevealBodySchema,
} from "./fhenix-common.js";
import {
  attachInvalidFhenixReveal,
  attachValidFhenixReveal,
} from "./fhenix-reveal-ingestion.js";
import {
  fhenixLifecycleSnapshot,
} from "./operator-control-plane.js";
import type { VerdictEventBus } from "./events.js";
import type { OperatorFhenixLifecycleQuery } from "./operator-fhenix-lifecycle-query.js";
import { agentsRepo } from "./repos/agents-repo.js";
import {
  ERROR_CODES,
  SCHEMA_VERSION,
  VerdictError,
} from "./schema.js";
import { acceptSealedCallMetadata } from "./sealed-call-intake.js";
import type { SealedCallIdAdapter } from "./sealed-call-acceptance.js";

export interface OperatorFhenixClock {
  now: () => Date;
}

export interface OperatorFhenixReadInstant {
  servedAt: Date;
}

export interface OperatorFhenixAdapters {
  newSealedCallId?: SealedCallIdAdapter;
}

export interface OperatorFhenixStatusJsonResponse {
  status: number;
  body: unknown;
}

export interface OperatorFhenixStatusJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export interface OperatorFhenixJsonResponseTarget {
  json(body: unknown): unknown;
}

export function sendOperatorFhenixStatusJsonResponse(
  res: OperatorFhenixStatusJsonResponseTarget,
  result: OperatorFhenixStatusJsonResponse,
): void {
  res.status(result.status).json(result.body);
}

export function sendOperatorFhenixJsonResponse(
  res: OperatorFhenixJsonResponseTarget,
  result: unknown,
): void {
  res.json(result);
}

export async function operatorFhenixBackfillCallResponse(input: {
  db: Database.Database;
  agentSlug: string | undefined;
  rawBody: string;
  fhenixVerifier: FhenixEventVerifier | null;
  events?: Pick<VerdictEventBus, "emit">;
} & OperatorFhenixClock & OperatorFhenixAdapters) {
  const slug = input.agentSlug;
  if (!slug) {
    throw new VerdictError(
      "X-Murmur-Agent-Slug header required for admin Fhenix backfill",
      ERROR_CODES.agent_slug_required,
      400,
    );
  }
  const agent = agentsRepo.bySlug(input.db, slug);
  if (!agent) {
    throw new VerdictError("unknown agent slug", ERROR_CODES.unknown_agent, 404);
  }

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(input.rawBody || "{}");
  } catch {
    throw new VerdictError(
      "request body is not valid JSON",
      ERROR_CODES.schema_invalid,
      400,
    );
  }

  const result = await acceptSealedCallMetadata({
    db: input.db,
    authResult: {
      tier: "casual",
      agent_id: agent.agent_id,
      agent_kind: agent.kind,
    },
    bodyJson,
    fhenixVerifier: input.fhenixVerifier,
    newCallId: input.newSealedCallId,
    now: input.now,
  });
  if (result.event) input.events?.emit(result.event);
  return result;
}

export function operatorFhenixLifecycleResponse(input: {
  db: Database.Database;
  query: OperatorFhenixLifecycleQuery;
  verifierConfigured: boolean;
} & OperatorFhenixReadInstant) {
  return {
    schema_version: SCHEMA_VERSION,
    ...fhenixLifecycleSnapshot(input.db, {
      ...input.query,
      servedAt: input.servedAt,
      verifier_configured: input.verifierConfigured,
    }),
  };
}

export async function operatorFhenixRevealResponse(input: {
  db: Database.Database;
  verifier: FhenixEventVerifier;
  body: unknown;
} & OperatorFhenixClock) {
  const parsed = FhenixRevealBodySchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throw new VerdictError(
      "fhenix reveal failed schema validation",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.format() },
    );
  }
  return attachValidFhenixReveal({
    db: input.db,
    verifier: input.verifier,
    now: input.now,
  }, parsed.data);
}

export async function operatorFhenixInvalidRevealResponse(input: {
  db: Database.Database;
  verifier: FhenixEventVerifier;
  body: unknown;
} & OperatorFhenixClock) {
  const parsed = FhenixInvalidRevealBodySchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throw new VerdictError(
      "fhenix invalid reveal failed schema validation",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.format() },
    );
  }
  return attachInvalidFhenixReveal({
    db: input.db,
    verifier: input.verifier,
    now: input.now,
  }, parsed.data);
}
