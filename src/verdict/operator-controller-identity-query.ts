import {
  boundedIntegerQuery,
} from "./route-query.js";

export interface OperatorControllerIdentityQueryInput {
  limit?: unknown;
  due_soon_hours?: unknown;
}

export interface OperatorControllerIdentityQuery {
  limit: number;
  dueSoonHours: number;
}

export function parseControllerIdentityQuery(
  query: OperatorControllerIdentityQueryInput,
): OperatorControllerIdentityQuery {
  const limit = boundedIntegerQuery(query.limit, { fallback: 50, max: 200 });
  const dueSoonHours = boundedIntegerQuery(query.due_soon_hours, {
    fallback: 24,
    max: 30 * 24,
  });
  return { limit, dueSoonHours };
}
