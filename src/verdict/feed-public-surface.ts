import type Database from "better-sqlite3";

import {
  buildFeedAvailabilityProof,
} from "./feed-availability.js";
import type {
  FeedPublicDetailQuery,
  FeedPublicListQuery,
} from "./feed-public-query.js";
import {
  publicFeed,
  publicFeedPacket,
  type PublicFeed,
} from "./feed-presenters.js";
import {
  agentsRepo,
} from "./repos/agents-repo.js";
import {
  feedContractsRepo,
  feedPacketsRepo,
} from "./repos/feed-availability-repo.js";
import {
  COMMERCIAL_TEMPLATES,
  EDGE_CLASSES,
  ERROR_CODES,
  RESOLUTION_CLASSES,
  SCHEMA_VERSION,
} from "./schema.js";
import { nowIso } from "./time.js";

export interface FeedPublicSurfaceReadInstant {
  servedAt: Date;
}

export interface FeedPublicError {
  code: string;
  message: string;
}

export interface ListPublicFeedsResponse {
  schema_version: typeof SCHEMA_VERSION;
  served_at: string;
  feeds: PublicFeed[];
  taxonomy: {
    resolution_classes: typeof RESOLUTION_CLASSES;
    edge_classes: typeof EDGE_CLASSES;
    commercial_templates: typeof COMMERCIAL_TEMPLATES;
  };
}

export interface PublicFeedResponse {
  schema_version: typeof SCHEMA_VERSION;
  feed: PublicFeed;
  packets?: Array<ReturnType<typeof publicFeedPacket>>;
}

export interface FeedAvailabilityResponse {
  schema_version: typeof SCHEMA_VERSION;
  served_at: string;
  proof: ReturnType<typeof buildFeedAvailabilityProof>;
}

export type FeedPublicSurfaceResult<T> =
  | { status: 200; body: T }
  | { status: 404; body: FeedPublicError };

export interface FeedPublicJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendFeedPublicJsonResponse<T>(
  res: FeedPublicJsonResponseTarget,
  result: FeedPublicSurfaceResult<T>,
): void {
  res.status(result.status).json(result.body);
}

export function listPublicFeedsSurface(input: {
  db: Database.Database;
  query: FeedPublicListQuery;
} & FeedPublicSurfaceReadInstant): FeedPublicSurfaceResult<ListPublicFeedsResponse> {
  const query = input.query;
  const rawAgentSlug = query.agentSlug;
  const agent = rawAgentSlug ? agentsRepo.bySlug(input.db, rawAgentSlug) : null;
  if (rawAgentSlug && !agent) {
    return {
      status: 404,
      body: { code: ERROR_CODES.unknown_agent, message: "agent not found" },
    };
  }

  const feeds = feedContractsRepo
    .list(input.db, {
      status: query.status,
      venue: query.venue,
      agent_id: agent?.agent_id,
      edge_class: query.edgeClass,
      resolution_class: query.resolutionClass,
      limit: query.limit,
    })
    .map((row) => publicFeed(input.db, row, { now: input.servedAt }));

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      served_at: nowIso(input.servedAt),
      feeds,
      taxonomy: {
        resolution_classes: RESOLUTION_CLASSES,
        edge_classes: EDGE_CLASSES,
        commercial_templates: COMMERCIAL_TEMPLATES,
      },
    },
  };
}

export function publicFeedSurface(input: {
  db: Database.Database;
  feedId: string;
  query: FeedPublicDetailQuery;
} & FeedPublicSurfaceReadInstant): FeedPublicSurfaceResult<PublicFeedResponse> {
  const row = feedContractsRepo.byId(input.db, input.feedId);
  if (!row) return feedNotFound();
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      feed: publicFeed(input.db, row, { now: input.servedAt }),
      ...(input.query.includePackets
        ? {
            packets: feedPacketsRepo
              .listForFeed(input.db, input.feedId, 50)
              .map(publicFeedPacket),
          }
        : {}),
    },
  };
}

export function feedAvailabilitySurface(input: {
  db: Database.Database;
  feedId: string;
} & FeedPublicSurfaceReadInstant): FeedPublicSurfaceResult<FeedAvailabilityResponse> {
  const row = feedContractsRepo.byId(input.db, input.feedId);
  if (!row) return feedNotFound();
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      served_at: nowIso(input.servedAt),
      proof: buildFeedAvailabilityProof(input.db, row, {
        now: input.servedAt,
        packetLimit: 100,
        incidentLimit: 500,
      }),
    },
  };
}

function feedNotFound(): { status: 404; body: FeedPublicError } {
  return {
    status: 404,
    body: { code: "not_found", message: "feed not found" },
  };
}
