import type Database from "better-sqlite3";
import type { FhenixGatewayBroadcaster } from "../integrations/fhenix-gateway.js";

import {
  unconfiguredGatewaySnapshot,
} from "./operator-control-plane.js";
import type { OperatorGatewayQuery } from "./operator-gateway-query.js";
import {
  SCHEMA_VERSION,
} from "./schema.js";
import { nowIso } from "./time.js";

export interface OperatorGatewayClock {
  now: () => Date;
}

export interface OperatorGatewayReadInstant {
  servedAt: Date;
}

export interface OperatorGatewayError {
  code: "gateway_disabled";
  message: string;
}

type OperatorGatewayAdapter = Pick<
  FhenixGatewayBroadcaster,
  "operatorSnapshot" | "retryAttemptNow" | "tick"
>;

export type OperatorGatewayResult<T> =
  | { status: 200; body: T }
  | { status: 503; body: OperatorGatewayError };

export interface OperatorGatewayJsonResponseTarget {
  json(body: unknown): unknown;
}

export interface OperatorGatewayStatusJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendOperatorGatewayJsonResponse(
  res: OperatorGatewayJsonResponseTarget,
  result: unknown,
): void {
  res.json(result);
}

export function sendOperatorGatewayStatusJsonResponse(
  res: OperatorGatewayStatusJsonResponseTarget,
  result: { status: number; body: unknown },
): void {
  res.status(result.status).json(result.body);
}

export function operatorGatewaySnapshotResponse(input: {
  db: Database.Database;
  gateway?: OperatorGatewayAdapter | null;
  query: OperatorGatewayQuery;
} & OperatorGatewayReadInstant) {
  const snapshot = input.gateway
    ? input.gateway.operatorSnapshot({
        ...input.query,
        servedAt: input.servedAt,
      })
    : unconfiguredGatewaySnapshot(input.db, {
        servedAt: input.servedAt,
        status: input.query.status,
        limit: input.query.limit,
        stuckAfterMs: input.query.stuckAfterMs,
      });
  return {
    schema_version: SCHEMA_VERSION,
    ...snapshot,
  };
}

export async function operatorGatewayTickResponse(input: {
  gateway?: OperatorGatewayAdapter | null;
  query: OperatorGatewayQuery;
} & OperatorGatewayClock): Promise<OperatorGatewayResult<{
  schema_version: typeof SCHEMA_VERSION;
  served_at: string;
  result: Awaited<ReturnType<OperatorGatewayAdapter["tick"]>>;
  gateway: {
    schema_version: typeof SCHEMA_VERSION;
  } & ReturnType<OperatorGatewayAdapter["operatorSnapshot"]>;
}>> {
  if (!input.gateway) return gatewayDisabled();
  const result = await input.gateway.tick();
  const servedAt = input.now();
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      served_at: nowIso(servedAt),
      result,
      gateway: {
        schema_version: SCHEMA_VERSION,
        ...input.gateway.operatorSnapshot({
          ...input.query,
          servedAt,
        }),
      },
    },
  };
}

export async function operatorGatewayRetryResponse(input: {
  gateway?: OperatorGatewayAdapter | null;
  attemptId: string;
} & OperatorGatewayClock): Promise<
  | { status: Awaited<ReturnType<OperatorGatewayAdapter["retryAttemptNow"]>>["status"]; body: {
      schema_version: typeof SCHEMA_VERSION;
      served_at: string;
    } & Awaited<ReturnType<OperatorGatewayAdapter["retryAttemptNow"]>>["body"] }
  | { status: 503; body: OperatorGatewayError }
> {
  if (!input.gateway) return gatewayDisabled();
  const result = await input.gateway.retryAttemptNow(input.attemptId);
  const servedAt = input.now();
  return {
    status: result.status,
    body: {
      schema_version: SCHEMA_VERSION,
      served_at: nowIso(servedAt),
      ...result.body,
    },
  };
}

function gatewayDisabled(): { status: 503; body: OperatorGatewayError } {
  return {
    status: 503,
    body: {
      code: "gateway_disabled",
      message: "Fhenix Gateway broadcaster is not configured",
    },
  };
}
