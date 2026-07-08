import type { FhenixRevealStatus } from "./repos/fhenix-sealed-calls-repo.js";
import {
  FhenixRevealStatusSchema,
} from "./operator-control-plane.js";
import {
  boundedIntegerQuery,
  firstQueryValue,
} from "./route-query.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

export const DEFAULT_FHENIX_REVEAL_GRACE_SEC = 3600;

export interface OperatorFhenixLifecycleQueryDefaults {
  fhenixRevealGraceSec: number;
}

export interface OperatorFhenixLifecycleQueryInput {
  status?: unknown;
  limit?: unknown;
  grace_sec?: unknown;
}

export interface OperatorFhenixLifecycleQuery {
  status?: FhenixRevealStatus;
  limit: number;
  graceSeconds: number;
}

export function normalizeFhenixRevealGraceSec(raw: unknown): number {
  const parsed = Number(raw ?? DEFAULT_FHENIX_REVEAL_GRACE_SEC);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(30 * 24 * 60 * 60, Math.floor(parsed)))
    : DEFAULT_FHENIX_REVEAL_GRACE_SEC;
}

export function parseFhenixLifecycleQuery(
  query: OperatorFhenixLifecycleQueryInput,
  defaults: OperatorFhenixLifecycleQueryDefaults = {
    fhenixRevealGraceSec: DEFAULT_FHENIX_REVEAL_GRACE_SEC,
  },
): OperatorFhenixLifecycleQuery {
  const rawStatus = firstQueryValue(query.status);
  const parsedStatus = rawStatus
    ? FhenixRevealStatusSchema.safeParse(rawStatus)
    : null;
  if (rawStatus && !parsedStatus?.success) {
    throw new VerdictError(
      "invalid Fhenix reveal status filter",
      ERROR_CODES.schema_invalid,
      400,
      { status: rawStatus },
    );
  }
  const limit = boundedIntegerQuery(query.limit, { fallback: 50, max: 200 });
  const graceSeconds = normalizeFhenixRevealGraceSec(
    firstQueryValue(query.grace_sec) ?? defaults.fhenixRevealGraceSec,
  );
  return {
    ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
    limit,
    graceSeconds,
  };
}
