import {
  GatewayAttemptStatusSchema,
} from "./operator-control-plane.js";
import type { FhenixGatewayTxStatus } from "./repos/fhenix-gateway-attempt-lifecycle.js";
import {
  boundedIntegerQuery,
  firstQueryValue,
} from "./route-query.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

export interface OperatorGatewayQueryInput {
  status?: unknown;
  limit?: unknown;
  stuck_after_sec?: unknown;
}

export interface OperatorGatewayQuery {
  status?: FhenixGatewayTxStatus;
  limit: number;
  stuckAfterMs?: number;
}

export function parseGatewayOperatorQuery(
  query: OperatorGatewayQueryInput,
): OperatorGatewayQuery {
  const rawStatus = firstQueryValue(query.status);
  const parsedStatus = rawStatus
    ? GatewayAttemptStatusSchema.safeParse(rawStatus)
    : null;
  if (rawStatus && !parsedStatus?.success) {
    throw new VerdictError(
      "invalid gateway attempt status filter",
      ERROR_CODES.schema_invalid,
      400,
      { status: rawStatus },
    );
  }
  const limit = boundedIntegerQuery(query.limit, { fallback: 50, max: 200 });
  const rawStuckSec = firstQueryValue(query.stuck_after_sec);
  const stuckAfterMs = rawStuckSec
    ? Math.max(60_000, Math.floor(Number(rawStuckSec) * 1_000))
    : undefined;
  if (rawStuckSec && !Number.isFinite(stuckAfterMs)) {
    throw new VerdictError(
      "invalid stuck_after_sec",
      ERROR_CODES.schema_invalid,
      400,
      { stuck_after_sec: rawStuckSec },
    );
  }
  return {
    ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
    limit,
    ...(stuckAfterMs ? { stuckAfterMs } : {}),
  };
}
