import type Database from "better-sqlite3";
import { z } from "zod";

import { usageRepo } from "./repos/usage-events-repo.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";
import { makeUsageEvent, type UsageEventIdAdapter } from "./usage-event.js";

// Funnel-only allowlist. The full Usage Event vocabulary includes
// resolver-side events that account callers must not be able to forge.
const FunnelEventKindSchema = z.enum([
  "landing.viewed",
  "compete.clicked",
  "privy.modal_opened",
  "privy.signed_in",
  "agent.created",
  "api_key.minted",
  "destination.set",
  "call.first_submitted",
  "call.first_resolved",
  "call.tenth_submitted",
]);

const FunnelEventSchema = z.object({
  kind: FunnelEventKindSchema,
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export interface AccountFunnelEmptyResponse {
  status: 204;
}

export interface AccountFunnelEmptyResponseTarget {
  status(code: number): { end(): unknown };
}

export interface AccountFunnelSurfaceBase {
  db: Database.Database;
  accountId: string;
}

export interface AccountFunnelWriteClock {
  operationInstant: Date;
}

export interface AccountFunnelEvidenceAdapters {
  newUsageEventId?: UsageEventIdAdapter;
}

export function sendAccountFunnelEmptyResponse(
  res: AccountFunnelEmptyResponseTarget,
  result: AccountFunnelEmptyResponse,
): void {
  res.status(result.status).end();
}

export function emitAccountFunnelEventResponse(
  input: AccountFunnelSurfaceBase
    & AccountFunnelWriteClock
    & AccountFunnelEvidenceAdapters
    & {
      body: unknown;
    },
): {
  status: 204;
} {
  const parsed = FunnelEventSchema.safeParse(input.body);
  if (!parsed.success) {
    throw new VerdictError(
      "invalid request",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.issues },
    );
  }

  const attributes = {
    ...(parsed.data.attributes ?? {}),
    account_id: input.accountId,
  };
  usageRepo.emit(
    input.db,
    makeUsageEvent({
      agent_id: null,
      kind: parsed.data.kind,
      attributes,
      newUsageEventId: input.newUsageEventId,
      occurredAt: input.operationInstant,
    }),
  );
  return { status: 204 };
}
