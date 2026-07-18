import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import {
  feedContractsRepo,
  feedPacketsRepo,
  feedSlaIncidentsRepo,
} from "./repos/feed-availability-repo.js";
import { missedPacketIncidentDetailsJson } from "./feed-sla-incident-detail.js";
import { feedSlaPolicy } from "./feed-policy.js";

export type FeedSlaIncidentIdAdapter = () => string;

export interface FeedSlaTickResult {
  served_at: string;
  inspected_feeds: number;
  incidents_opened: number;
  max_incidents: number;
}

export interface FeedSlaTickInput {
  tickedAt: Date;
  newIncidentId?: FeedSlaIncidentIdAdapter;
  maxIncidents?: number;
  feedLimit?: number;
}

export function runFeedSlaTick(
  db: Database.Database,
  input: FeedSlaTickInput,
): FeedSlaTickResult {
  const servedAt = stripIso(input.tickedAt);
  const nowMs = input.tickedAt.getTime();
  const maxIncidents = Math.max(
    1,
    Math.min(1_000, Math.floor(input.maxIncidents ?? 100)),
  );
  const feeds = feedContractsRepo.listCadenceListed(db, {
    limit: input.feedLimit ?? 500,
  });
  let incidentsOpened = 0;
  let inspectedFeeds = 0;

  for (const feed of feeds) {
    if (incidentsOpened >= maxIncidents) break;
    inspectedFeeds++;
    const cadence = feed.delivery_cadence_seconds;
    if (!cadence || cadence < 60) continue;
    const policy = feedSlaPolicy(feed);

    while (incidentsOpened < maxIncidents) {
      const expectedSequence = feedPacketsRepo.firstUnaccountedSequence(
        db,
        feed.feed_id,
      );
      const deadlineMs = expectedSequenceDeadlineMs(
        db,
        feed.feed_id,
        feed.created_at,
        expectedSequence,
        cadence,
      );
      if (
        deadlineMs === null ||
        deadlineMs + policy.grace_seconds * 1_000 > nowMs
      ) {
        break;
      }
      const expectedDeadline = stripIso(new Date(deadlineMs));
      const created = feedSlaIncidentsRepo.insertMissed(db, {
        incident_id: (input.newIncidentId ?? randomUUID)(),
        feed_id: feed.feed_id,
        agent_id: feed.agent_id,
        incident_kind: "missed_packet",
        status: "open",
        expected_sequence: expectedSequence,
        expected_delivery_deadline_at: expectedDeadline,
        detected_at: servedAt,
        grace_seconds: policy.grace_seconds,
        refund_action: policy.refund_action,
        slash_action: policy.slash_action,
        details_json: missedPacketIncidentDetailsJson({
          cadence_seconds: cadence,
          grace_seconds: policy.grace_seconds,
          refund_rule: policy.refund_rule,
          slash_rule: policy.slash_rule,
        }),
        created_at: servedAt,
        updated_at: servedAt,
      });
      if (created) incidentsOpened++;
      else break;
    }
  }

  return {
    served_at: servedAt,
    inspected_feeds: inspectedFeeds,
    incidents_opened: incidentsOpened,
    max_incidents: maxIncidents,
  };
}

function expectedSequenceDeadlineMs(
  db: Database.Database,
  feedId: string,
  feedCreatedAt: string,
  expectedSequence: number,
  cadenceSeconds: number,
): number | null {
  let baseMs: number;
  if (expectedSequence === 1) {
    baseMs = Date.parse(feedCreatedAt);
  } else {
    const previousSequence = expectedSequence - 1;
    const previousPacket = feedPacketsRepo.byFeedSequence(
      db,
      feedId,
      previousSequence,
    );
    if (previousPacket) {
      baseMs = Date.parse(previousPacket.accepted_at);
    } else {
      const previousIncident = feedSlaIncidentsRepo.byFeedSequence(
        db,
        feedId,
        previousSequence,
      );
      baseMs = previousIncident
        ? Date.parse(previousIncident.expected_delivery_deadline_at)
        : Date.parse(feedCreatedAt) +
          cadenceSeconds * 1_000 * Math.max(0, expectedSequence - 1);
    }
  }
  return Number.isFinite(baseMs) ? baseMs + cadenceSeconds * 1_000 : null;
}

function stripIso(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}
