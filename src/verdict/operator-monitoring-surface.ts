import type Database from "better-sqlite3";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";

import {
  controllerIdentitySnapshot,
} from "./operator-control-plane.js";
import type { OperatorControllerIdentityQuery } from "./operator-controller-identity-query.js";
import { SCHEMA_VERSION } from "./schema.js";

export interface OperatorMonitoringClock {
  now: () => Date;
}

export interface OperatorMonitoringReadInstant {
  servedAt: Date;
}

export interface OperatorMonitoringError {
  code: string;
  message: string;
}

export type OperatorMonitoringResult<T> =
  | { status: 200; body: T }
  | { status: 503; body: OperatorMonitoringError };

export interface OperatorMonitoringResultJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export interface OperatorMonitoringJsonResponseTarget {
  json(body: unknown): unknown;
}

export function sendOperatorMonitoringResultJsonResponse(
  res: OperatorMonitoringResultJsonResponseTarget,
  result: OperatorMonitoringResult<unknown>,
): void {
  res.status(result.status).json(result.body);
}

export function sendOperatorMonitoringJsonResponse(
  res: OperatorMonitoringJsonResponseTarget,
  result: unknown,
): void {
  res.json(result);
}

export function operatorCanarySnapshotResponse(
  liveCanaries?: LiveCanaryProvider | null,
): OperatorMonitoringResult<ReturnType<LiveCanaryProvider["snapshot"]>> {
  if (!liveCanaries) return canariesDisabled();
  return {
    status: 200,
    body: liveCanaries.snapshot(),
  };
}

export async function operatorCanaryTickResponse(
  liveCanaries?: LiveCanaryProvider | null,
): Promise<OperatorMonitoringResult<Awaited<ReturnType<LiveCanaryProvider["runNow"]>>>> {
  if (!liveCanaries) return canariesDisabled();
  return {
    status: 200,
    body: await liveCanaries.runNow(),
  };
}

export function operatorControllerIdentityResponse(input: {
  db: Database.Database;
  query: OperatorControllerIdentityQuery;
} & OperatorMonitoringReadInstant) {
  return {
    schema_version: SCHEMA_VERSION,
    ...controllerIdentitySnapshot(input.db, {
      ...input.query,
      servedAt: input.servedAt,
    }),
  };
}

function canariesDisabled(): { status: 503; body: OperatorMonitoringError } {
  return {
    status: 503,
    body: {
      code: "canaries_disabled",
      message: "Live canary runner is not configured",
    },
  };
}
