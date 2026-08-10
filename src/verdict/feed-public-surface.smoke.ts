import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  feedAvailabilitySurface,
  listPublicFeedsSurface,
  publicFeedSurface,
  sendFeedPublicJsonResponse,
} from "./feed-public-surface.js";
import { agentsRepo } from "./repos/agents-repo.js";
import {
  feedContractsRepo,
  feedPacketsRepo,
} from "./repos/feed-availability-repo.js";

class FakeFeedPublicJsonResponse {
  statusCode: number | null = null;
  body: unknown = null;

  status(code: number): { json: (body: unknown) => void } {
    this.statusCode = code;
    return {
      json: (body: unknown) => {
        this.body = body;
      },
    };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-feed-public-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur feed public surface smoke\n");
  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  const servedAt = new Date("2026-06-12T09:30:00Z");

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "feed-public",
    kind: "agent",
    display_name: "Feed Public",
    created_at: "2026-06-12T09:00:00Z",
  });
  feedContractsRepo.insert(db, {
    feed_id: "feed-public",
    agent_id: agentId,
    name: "Feed Public",
    description: "public feed fixture",
    status: "listed",
    venue: "native-price",
    resolution_classes: ["price_direction"],
    edge_classes: ["latency", "domain"],
    covered_market_ids: ["eth.1h"],
    delivery_cadence_seconds: 60,
    trigger_rules: [{ kind: "cadence" }],
    max_latency_seconds: 60,
    subscriber_capacity: 25,
    commercial_template: "per_alert",
    reveal_policy: { kind: "after_resolution" },
    refund_rule: { kind: "credit", missed_delivery_grace: 1 },
    slash_rule: { kind: "none" },
    created_at: "2026-06-12T09:00:00Z",
    updated_at: "2026-06-12T09:00:00Z",
  });
  feedContractsRepo.insert(db, {
    feed_id: "feed-nonmatching-newer",
    agent_id: agentId,
    name: "Feed Nonmatching Newer",
    description: "newer nonmatching public feed fixture",
    status: "listed",
    venue: "native-price",
    resolution_classes: ["event_binary"],
    edge_classes: ["domain"],
    covered_market_ids: ["event.1"],
    delivery_cadence_seconds: 60,
    trigger_rules: [{ kind: "cadence" }],
    max_latency_seconds: 60,
    subscriber_capacity: 25,
    commercial_template: "per_alert",
    reveal_policy: { kind: "after_resolution" },
    refund_rule: { kind: "credit", missed_delivery_grace: 1 },
    slash_rule: { kind: "none" },
    created_at: "2026-06-12T09:05:00Z",
    updated_at: "2026-06-12T09:05:00Z",
  });
  feedPacketsRepo.insert(db, {
    packet_id: randomUUID(),
    feed_id: "feed-public",
    agent_id: agentId,
    market_id: "eth.1h",
    packet_kind: "verdict",
    sequence: 1,
    payload_schema: "murmur-feed-packet-v1",
    submitted_at: "2026-06-12T09:00:10Z",
    accepted_at: "2026-06-12T09:00:20Z",
    reveal_after: "2026-06-12T10:00:00Z",
    delivery_deadline_at: "2026-06-12T09:01:00Z",
    sla_status: "on_time",
    chain_id: 84532,
    contract_address: `0x${"a".repeat(40)}`,
    onchain_packet_id: `0x${"1".repeat(64)}`,
    submit_tx_hash: `0x${"2".repeat(64)}`,
    submit_log_index: 0,
    packet_ct_hash: `0x${"3".repeat(64)}`,
    binary_index_ct_hash: `0x${"4".repeat(64)}`,
    confidence_ct_hash: `0x${"5".repeat(64)}`,
    created_at: "2026-06-12T09:00:30Z",
  });

  const listed = listPublicFeedsSurface({
    db,
    servedAt,
    query: {
      status: "listed",
      venue: "native-price",
      agentSlug: "feed-public",
      edgeClass: "latency",
      resolutionClass: "price_direction",
      limit: 100,
    },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.schema_version, 1);
  assert.equal(listed.body.served_at, "2026-06-12T09:30:00Z");
  assert.equal(listed.body.feeds.length, 1);
  assert.equal(listed.body.feeds[0]?.agent_slug, "feed-public");
  assert.equal(listed.body.feeds[0]?.availability.next_expected_sequence, 2);
  assert.equal(listed.body.feeds[0]?.availability.next_deadline_at, "2026-06-12T09:01:20Z");
  assert.equal(listed.body.feeds[0]?.availability.overdue, true);
  assert.equal(listed.body.taxonomy.edge_classes.includes("latency"), true);
  const listedRes = new FakeFeedPublicJsonResponse();
  sendFeedPublicJsonResponse(listedRes, listed);
  assert.equal(listedRes.statusCode, 200);
  assert.equal(
    (listedRes.body as typeof listed.body).feeds[0]?.feed_id,
    "feed-public",
  );

  const limitedListed = listPublicFeedsSurface({
    db,
    servedAt,
    query: {
      status: "listed",
      venue: "native-price",
      agentSlug: "feed-public",
      edgeClass: "latency",
      resolutionClass: "price_direction",
      limit: 1,
    },
  });
  assert.equal(limitedListed.status, 200);
  assert.deepEqual(
    limitedListed.body.feeds.map((feed) => feed.feed_id),
    ["feed-public"],
  );

  const unknownAgent = listPublicFeedsSurface({
    db,
    servedAt,
    query: {
      status: undefined,
      venue: undefined,
      agentSlug: "missing-agent",
      edgeClass: null,
      resolutionClass: null,
      limit: 100,
    },
  });
  assert.deepEqual(unknownAgent, {
    status: 404,
    body: { code: "unknown_agent", message: "agent not found" },
  });
  const unknownAgentRes = new FakeFeedPublicJsonResponse();
  sendFeedPublicJsonResponse(unknownAgentRes, unknownAgent);
  assert.equal(unknownAgentRes.statusCode, 404);
  assert.deepEqual(unknownAgentRes.body, { code: "unknown_agent", message: "agent not found" });
  const detail = publicFeedSurface({
    db,
    feedId: "feed-public",
    servedAt,
    query: { includePackets: true },
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.feed.feed_id, "feed-public");
  assert.equal(detail.body.feed.availability.next_expected_sequence, 2);
  assert.equal(detail.body.feed.availability.next_deadline_at, "2026-06-12T09:01:20Z");
  assert.equal(detail.body.packets?.length, 1);
  assert.equal(detail.body.packets?.[0]?.fhenix.packet_ct_hash, `0x${"3".repeat(64)}`);

  const availability = feedAvailabilitySurface({
    db,
    feedId: "feed-public",
    servedAt,
  });
  assert.equal(availability.status, 200);
  assert.equal(availability.body.served_at, "2026-06-12T09:30:00Z");
  assert.equal(availability.body.proof.feed_id, "feed-public");
  assert.equal(availability.body.proof.evidence.delivered_packets.length, 1);
  const availabilityRes = new FakeFeedPublicJsonResponse();
  sendFeedPublicJsonResponse(availabilityRes, availability);
  assert.equal(availabilityRes.statusCode, 200);
  assert.equal((availabilityRes.body as typeof availability.body).proof.feed_id, "feed-public");

  assert.deepEqual(publicFeedSurface({
    db,
    feedId: "missing",
    servedAt,
    query: { includePackets: false },
  }), {
    status: 404,
    body: { code: "not_found", message: "feed not found" },
  });

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("feed public surface smoke ok\n");
