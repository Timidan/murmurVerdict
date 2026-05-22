import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import {
  feedContractsRepo,
  feedPacketsRepo,
  feedSlaIncidentsRepo,
  type FeedContractRow,
} from "./db.js";

export interface FeedSlaTickResult {
  served_at: string;
  inspected_feeds: number;
  incidents_opened: number;
  max_incidents: number;
}

export interface FeedSlaTickOptions {
  now?: () => Date;
  maxIncidents?: number;
  feedLimit?: number;
}

export function runFeedSlaTick(
  db: Database.Database,
  opts: FeedSlaTickOptions = {},
): FeedSlaTickResult {
  const now = opts.now ?? (() => new Date());
  const tickNow = now();
  const servedAt = stripIso(tickNow);
  const nowMs = tickNow.getTime();
  const maxIncidents = Math.max(1, Math.min(1_000, Math.floor(opts.maxIncidents ?? 100)));
  const feeds = feedContractsRepo.listCadenceListed(db, {
    limit: opts.feedLimit ?? 500,
  });
  let incidentsOpened = 0;
  let inspectedFeeds = 0;

  for (const feed of feeds) {
    if (incidentsOpened >= maxIncidents) break;
    inspectedFeeds++;
    const cadence = feed.delivery_cadence_seconds;
    if (!cadence || cadence < 60) continue;
    const latest = feedPacketsRepo.latestForFeed(db, feed.feed_id);
    const baseMs = Date.parse(latest?.accepted_at ?? feed.created_at);
    if (!Number.isFinite(baseMs)) continue;

    const graceSeconds = feedMissedGraceSeconds(feed);
    const actions = feedIncidentActions(feed);
    let expectedSequence = (latest?.sequence ?? 0) + 1;
    let deadlineMs = baseMs + cadence * 1_000;

    while (
      deadlineMs + graceSeconds * 1_000 <= nowMs &&
      incidentsOpened < maxIncidents
    ) {
      const expectedDeadline = stripIso(new Date(deadlineMs));
      const created = feedSlaIncidentsRepo.insertMissed(db, {
        incident_id: randomUUID(),
        feed_id: feed.feed_id,
        agent_id: feed.agent_id,
        incident_kind: "missed_packet",
        status: "open",
        expected_sequence: expectedSequence,
        expected_delivery_deadline_at: expectedDeadline,
        detected_at: servedAt,
        grace_seconds: graceSeconds,
        refund_action: actions.refund_action,
        slash_action: actions.slash_action,
        details_json: JSON.stringify({
          cadence_seconds: cadence,
          grace_seconds: graceSeconds,
          refund_rule: safeJsonObject(feed.refund_rule_json),
          slash_rule: safeJsonObject(feed.slash_rule_json),
          generated_by: "feed_sla_tick_v1",
        }),
        created_at: servedAt,
        updated_at: servedAt,
      });
      if (created) incidentsOpened++;
      expectedSequence++;
      deadlineMs += cadence * 1_000;
    }
  }

  return {
    served_at: servedAt,
    inspected_feeds: inspectedFeeds,
    incidents_opened: incidentsOpened,
    max_incidents: maxIncidents,
  };
}

function feedMissedGraceSeconds(feed: FeedContractRow): number {
  if (feed.max_latency_seconds !== null) {
    return Math.max(0, Math.floor(feed.max_latency_seconds));
  }
  const refundRule = safeJsonObject(feed.refund_rule_json);
  const minutes = Number(refundRule.missed_delivery_grace ?? 0);
  if (!Number.isFinite(minutes)) return 0;
  return Math.max(0, Math.floor(minutes * 60));
}

function feedIncidentActions(feed: FeedContractRow): {
  refund_action: "none" | "credit" | "prorated";
  slash_action: "none" | "reputation" | "stake";
} {
  const refundRule = safeJsonObject(feed.refund_rule_json);
  const slashRule = safeJsonObject(feed.slash_rule_json);
  const refundKind = refundRule.kind;
  const slashKind = slashRule.kind;
  return {
    refund_action:
      refundKind === "credit" || refundKind === "prorated" ? refundKind : "none",
    slash_action:
      slashKind === "reputation" || slashKind === "stake" ? slashKind : "none",
  };
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stripIso(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}
