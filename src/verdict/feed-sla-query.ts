import { z } from "zod";

import {
  boundedIntegerQuery,
  firstQueryValue,
} from "./route-query.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

const FeedSlaIncidentStatusSchema = z.enum(["open", "fulfilled_late"]);

export interface FeedSlaQueryInput {
  feed_id?: unknown;
  status?: unknown;
  limit?: unknown;
}

export interface FeedSlaQuery {
  feed_id?: string;
  status?: "open" | "fulfilled_late";
  limit: number;
}

export function parseFeedSlaQuery(query: FeedSlaQueryInput): FeedSlaQuery {
  const rawStatus = firstQueryValue(query.status);
  const parsedStatus = rawStatus
    ? FeedSlaIncidentStatusSchema.safeParse(rawStatus)
    : null;
  if (rawStatus && !parsedStatus?.success) {
    throw new VerdictError(
      "invalid feed SLA incident status",
      ERROR_CODES.schema_invalid,
      400,
      { status: rawStatus },
    );
  }
  const feedId = firstQueryValue(query.feed_id);
  return {
    ...(feedId ? { feed_id: feedId } : {}),
    ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
    limit: boundedIntegerQuery(query.limit, { fallback: 100, max: 500 }),
  };
}
