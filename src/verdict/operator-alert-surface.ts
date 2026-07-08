import type Database from "better-sqlite3";
import { z } from "zod";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";

import {
  operatorAlertsSnapshot,
  runOperatorAlertTick,
  type OperatorAlertIdAdapter,
  type OperatorAlertSinkConfig,
} from "./operator-alerts.js";
import type { OperatorAlertQuery } from "./operator-alert-query.js";
import {
  ERROR_CODES,
  SCHEMA_VERSION,
  VerdictError,
} from "./schema.js";

export const OperatorAlertTickBodySchema = z.object({
  gateway_stuck_after_sec: z.number().int().min(60).max(24 * 60 * 60).optional(),
  fhenix_reveal_grace_sec: z.number().int().min(0).max(7 * 24 * 60 * 60).optional(),
  identity_due_soon_hours: z.number().int().min(1).max(30 * 24).optional(),
}).strict();

export interface OperatorAlertSurfaceClock {
  now: () => Date;
}

export interface OperatorAlertSurfaceReadInstant {
  servedAt: Date;
}

export interface OperatorAlertSurfaceAdapters {
  newAlertId?: OperatorAlertIdAdapter;
}

export interface OperatorAlertJsonResponseTarget {
  json(body: unknown): unknown;
}

export function sendOperatorAlertJsonResponse(
  res: OperatorAlertJsonResponseTarget,
  result: unknown,
): void {
  res.json(result);
}

export function operatorAlertSnapshotResponse(input: {
  db: Database.Database;
  query: OperatorAlertQuery;
  sink?: OperatorAlertSinkConfig;
} & OperatorAlertSurfaceReadInstant) {
  return {
    schema_version: SCHEMA_VERSION,
    ...operatorAlertsSnapshot(input.db, {
      ...input.query,
      sink: input.sink,
      servedAt: input.servedAt,
    }),
  };
}

export async function operatorAlertTickResponse(input: {
  db: Database.Database;
  body: unknown;
  liveCanaries?: LiveCanaryProvider | null;
  sink?: OperatorAlertSinkConfig;
} & OperatorAlertSurfaceClock & OperatorAlertSurfaceAdapters) {
  const parsed = OperatorAlertTickBodySchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throw new VerdictError(
      "operator alert tick failed schema validation",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.format() },
    );
  }
  const result = await runOperatorAlertTick({
    db: input.db,
    now: input.now,
    liveCanaries: input.liveCanaries,
    gatewayStuckAfterMs: parsed.data.gateway_stuck_after_sec
      ? parsed.data.gateway_stuck_after_sec * 1_000
      : undefined,
    fhenixRevealGraceSec: parsed.data.fhenix_reveal_grace_sec,
    identityDueSoonHours: parsed.data.identity_due_soon_hours,
    newAlertId: input.newAlertId,
    sink: input.sink,
  });
  return {
    schema_version: SCHEMA_VERSION,
    ...result,
  };
}
