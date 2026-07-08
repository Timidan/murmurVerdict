import type Database from "better-sqlite3";
import { z } from "zod";

import { feedAvailabilitySummary } from "./feed-availability.js";
import { publicFeedSlaIncident } from "./feed-presenters.js";
import { runFeedSlaTick, type FeedSlaIncidentIdAdapter } from "./feed-sla.js";
import type { FeedSlaQuery } from "./feed-sla-query.js";
import {
  feedContractsRepo,
  feedSlaIncidentsRepo,
} from "./repos/feed-availability-repo.js";
import {
  ERROR_CODES,
  SCHEMA_VERSION,
  VerdictError,
} from "./schema.js";
import { nowIso } from "./time.js";

export const FeedSlaTickBodySchema = z
  .object({
    max_incidents: z.number().int().min(1).max(1_000).optional(),
    feed_limit: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();

export interface FeedSlaSurfaceClock {
  now: () => Date;
}

export interface FeedSlaSurfaceAdapters {
  newIncidentId?: FeedSlaIncidentIdAdapter;
}

export interface FeedSlaSurfaceReadInstant {
  servedAt: Date;
}

export interface FeedSlaJsonResponseTarget {
  json(body: unknown): unknown;
}

export function sendFeedSlaJsonResponse(
  res: FeedSlaJsonResponseTarget,
  result: unknown,
): void {
  res.json(result);
}

export function feedSlaSnapshotResponse(input: {
  db: Database.Database;
  query: FeedSlaQuery;
} & FeedSlaSurfaceReadInstant) {
  const incidents = feedSlaIncidentsRepo
    .list(input.db, {
      feed_id: input.query.feed_id,
      status: input.query.status,
      limit: input.query.limit,
    })
    .map(publicFeedSlaIncident);
  const feed_health = feedContractsRepo
    .listCadenceListed(input.db, { limit: 100 })
    .map((row) => feedAvailabilitySummary(input.db, row, {
      now: input.servedAt,
    }));
  const refundRecommendations = incidents.reduce(
    (acc, incident) => acc + (incident.refund_action === "none" ? 0 : 1),
    0,
  );
  const slashRecommendations = incidents.reduce(
    (acc, incident) => acc + (incident.slash_action === "none" ? 0 : 1),
    0,
  );
  return {
    schema_version: SCHEMA_VERSION,
    served_at: nowIso(input.servedAt),
    summary: {
      open_incidents: incidents.filter((incident) => incident.status === "open").length,
      refund_recommendations: refundRecommendations,
      slash_recommendations: slashRecommendations,
      failing_feeds: feed_health.filter((feed) => feed.health_status === "failing").length,
      degraded_feeds: feed_health.filter((feed) => feed.health_status === "degraded").length,
      payment_execution_enabled: false,
    },
    feed_health,
    incidents,
  };
}

export function feedSlaTickResponse(input: {
  db: Database.Database;
  body: unknown;
} & FeedSlaSurfaceClock & FeedSlaSurfaceAdapters) {
  const parsed = FeedSlaTickBodySchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throw new VerdictError(
      "feed SLA tick failed schema validation",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.format() },
    );
  }
  const result = runFeedSlaTick(input.db, {
    tickedAt: input.now(),
    newIncidentId: input.newIncidentId,
    maxIncidents: parsed.data.max_incidents,
    feedLimit: parsed.data.feed_limit,
  });
  return {
    schema_version: SCHEMA_VERSION,
    result,
    open_incidents: feedSlaIncidentsRepo
      .list(input.db, { status: "open", limit: 100 })
      .map(publicFeedSlaIncident),
  };
}
