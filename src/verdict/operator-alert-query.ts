import { z } from "zod";

import type {
  OperatorAlertDeliveryStatus,
  OperatorAlertStatus,
} from "./repos/operator-alerts-repo.js";
import {
  boundedIntegerQuery,
  firstQueryValue,
} from "./route-query.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

const OperatorAlertStatusSchema = z.enum(["open", "resolved"]);
const OperatorAlertDeliveryStatusSchema = z.enum(["pending", "delivered", "failed"]);

export interface OperatorAlertQueryInput {
  status?: unknown;
  source?: unknown;
  delivery_status?: unknown;
  limit?: unknown;
}

export interface OperatorAlertQuery {
  status?: OperatorAlertStatus;
  source?: string;
  delivery_status?: OperatorAlertDeliveryStatus;
  limit: number;
}

export function parseOperatorAlertQuery(
  query: OperatorAlertQueryInput,
): OperatorAlertQuery {
  const rawStatus = firstQueryValue(query.status);
  const parsedStatus = rawStatus
    ? OperatorAlertStatusSchema.safeParse(rawStatus)
    : null;
  if (rawStatus && !parsedStatus?.success) {
    throw new VerdictError(
      "invalid operator alert status",
      ERROR_CODES.schema_invalid,
      400,
      { status: rawStatus },
    );
  }
  const rawDelivery = firstQueryValue(query.delivery_status);
  const parsedDelivery = rawDelivery
    ? OperatorAlertDeliveryStatusSchema.safeParse(rawDelivery)
    : null;
  if (rawDelivery && !parsedDelivery?.success) {
    throw new VerdictError(
      "invalid operator alert delivery_status",
      ERROR_CODES.schema_invalid,
      400,
      { delivery_status: rawDelivery },
    );
  }
  const source = firstQueryValue(query.source);
  return {
    ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
    ...(source ? { source } : {}),
    ...(parsedDelivery?.success ? { delivery_status: parsedDelivery.data } : {}),
    limit: boundedIntegerQuery(query.limit, { fallback: 100, max: 500 }),
  };
}
