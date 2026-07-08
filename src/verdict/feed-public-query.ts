import {
  boundedIntegerQuery,
  firstQueryValue,
} from "./route-query.js";
import {
  EDGE_CLASSES,
  EdgeClassSchema,
  ERROR_CODES,
  FEED_STATUSES,
  FeedStatusSchema,
  RESOLUTION_CLASSES,
  ResolutionClassSchema,
  VerdictError,
  type EdgeClass,
  type FeedStatus,
  type ResolutionClass,
} from "./schema.js";

export interface FeedPublicListQueryInput {
  status?: unknown;
  venue?: unknown;
  agent_slug?: unknown;
  limit?: unknown;
  edge_class?: unknown;
  resolution_class?: unknown;
}

export interface FeedPublicListQuery {
  status?: FeedStatus;
  venue?: string;
  agentSlug?: string;
  limit: number;
  edgeClass: EdgeClass | null;
  resolutionClass: ResolutionClass | null;
}

export interface FeedPublicDetailQueryInput {
  include_packets?: unknown;
}

export interface FeedPublicDetailQuery {
  includePackets: boolean;
}

export function feedPublicListQuery(
  query: FeedPublicListQueryInput | undefined,
): FeedPublicListQuery {
  return {
    status: parseFeedStatus(query?.status),
    venue: optionalQueryString(query?.venue),
    agentSlug: optionalQueryString(query?.agent_slug),
    limit: boundedIntegerQuery(query?.limit, { fallback: 100, max: 500 }),
    edgeClass: parseEdgeClass(query?.edge_class),
    resolutionClass: parseResolutionClass(query?.resolution_class),
  };
}

export function feedPublicDetailQuery(
  query: FeedPublicDetailQueryInput | undefined,
): FeedPublicDetailQuery {
  return {
    includePackets: firstQueryValue(query?.include_packets) === "true",
  };
}

function parseFeedStatus(raw: unknown): FeedStatus | undefined {
  const value = optionalQueryString(raw);
  if (!value) return undefined;
  const parsed = FeedStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new VerdictError(
      `status must be one of ${FEED_STATUSES.join("|")}`,
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  return parsed.data;
}

function parseEdgeClass(raw: unknown): EdgeClass | null {
  const value = optionalQueryString(raw);
  if (!value) return null;
  const parsed = EdgeClassSchema.safeParse(value);
  if (!parsed.success) {
    throw new VerdictError(
      `edge_class must be one of ${EDGE_CLASSES.join("|")}`,
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  return parsed.data;
}

function parseResolutionClass(raw: unknown): ResolutionClass | null {
  const value = optionalQueryString(raw);
  if (!value) return null;
  const parsed = ResolutionClassSchema.safeParse(value);
  if (!parsed.success) {
    throw new VerdictError(
      `resolution_class must be one of ${RESOLUTION_CLASSES.join("|")}`,
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  return parsed.data;
}

function optionalQueryString(raw: unknown): string | undefined {
  const value = firstQueryValue(raw);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
