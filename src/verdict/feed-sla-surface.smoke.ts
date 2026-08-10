import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentsRepo,
  feedContractsRepo,
  feedPacketsRepo,
  feedSlaIncidentsRepo,
  openDb,
} from "./db.js";
import {
  feedSlaSnapshotResponse,
  feedSlaTickResponse,
  sendFeedSlaJsonResponse,
} from "./feed-sla-surface.js";
import { parseFeedSlaQuery } from "./feed-sla-query.js";
import { VerdictError } from "./schema.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-feed-sla-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur feed SLA surface smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T09:30:00Z");
  const servedAt = now();
  const incidentIds: string[] = [];
  const newIncidentId = () => {
    const id = "11111111-1111-4111-8111-111111111111";
    incidentIds.push(id);
    return id;
  };

  const snapshot = feedSlaSnapshotResponse({
    db,
    servedAt,
    query: parseFeedSlaQuery({}),
  });
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.served_at, "2026-06-12T09:30:00Z");
  assert.equal(snapshot.summary.open_incidents, 0);
  assert.equal(snapshot.summary.payment_execution_enabled, false);
  assert.equal(snapshot.feed_health.length, 0);
  assert.equal(snapshot.incidents.length, 0);
  const snapshotTarget = {
    body: undefined as unknown,
    json(body: unknown) {
      this.body = body;
    },
  };
  sendFeedSlaJsonResponse(snapshotTarget, snapshot);
  assert.equal(snapshotTarget.body, snapshot);

  assert.throws(
    () =>
      feedSlaTickResponse({
        db,
        body: { max_incidents: 0 },
        newIncidentId: () => {
          throw new Error("invalid SLA tick body should not mint incident id");
        },
        now,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const tick = feedSlaTickResponse({
    db,
    now,
    body: { max_incidents: 5, feed_limit: 10 },
  });
  assert.equal(tick.schema_version, 1);
  assert.equal(tick.result.served_at, "2026-06-12T09:30:00Z");
  assert.equal(tick.result.inspected_feeds, 0);
  assert.equal(tick.result.max_incidents, 5);
  assert.equal(tick.open_incidents.length, 0);
  const tickTarget = {
    body: undefined as unknown,
    json(body: unknown) {
      this.body = body;
    },
  };
  sendFeedSlaJsonResponse(tickTarget, tick);
  assert.equal(tickTarget.body, tick);

  agentsRepo.insert(db, {
    agent_id: "22222222-2222-4222-8222-222222222222",
    display_slug: "feed-sla-surface",
    kind: "agent",
    display_name: "Feed SLA Surface",
    created_at: "2026-06-12T09:00:00Z",
  });
  feedContractsRepo.insert(db, {
    feed_id: "feed-sla-surface",
    agent_id: "22222222-2222-4222-8222-222222222222",
    name: "Feed SLA Surface",
    description: null,
    status: "listed",
    venue: "native-price",
    resolution_classes: ["price_direction"],
    edge_classes: ["latency"],
    covered_market_ids: [],
    delivery_cadence_seconds: 60,
    trigger_rules: [],
    max_latency_seconds: null,
    subscriber_capacity: 10,
    commercial_template: "per_alert",
    reveal_policy: { kind: "after_resolution" },
    refund_rule: { kind: "none" },
    slash_rule: { kind: "none" },
    created_at: "2026-06-12T09:00:00Z",
    updated_at: "2026-06-12T09:00:00Z",
  });

  const opened = feedSlaTickResponse({
    db,
    body: { max_incidents: 5, feed_limit: 10 },
    newIncidentId,
    now: () => new Date("2026-06-12T09:01:00Z"),
  });
  assert.equal(opened.result.incidents_opened, 1);
  const incident = feedSlaIncidentsRepo.byFeedSequence(
    db,
    "feed-sla-surface",
    1,
  );
  assert.equal(incident?.incident_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(incident?.expected_delivery_deadline_at, "2026-06-12T09:01:00Z");
  assert.equal(incident?.detected_at, "2026-06-12T09:01:00Z");
  assert.deepEqual(incidentIds, ["11111111-1111-4111-8111-111111111111"]);

  const duplicate = feedSlaTickResponse({
    db,
    body: { max_incidents: 5, feed_limit: 10 },
    newIncidentId: () => {
      throw new Error("duplicate SLA incident should not mint incident id");
    },
    now: () => new Date("2026-06-12T09:01:00Z"),
  });
  assert.equal(duplicate.result.incidents_opened, 0);
  assert.deepEqual(incidentIds, ["11111111-1111-4111-8111-111111111111"]);

  feedContractsRepo.insert(db, {
    feed_id: "feed-sla-gap",
    agent_id: "22222222-2222-4222-8222-222222222222",
    name: "Feed SLA Gap",
    description: null,
    status: "listed",
    venue: "native-price",
    resolution_classes: ["price_direction"],
    edge_classes: ["latency"],
    covered_market_ids: [],
    delivery_cadence_seconds: 60,
    trigger_rules: [],
    max_latency_seconds: null,
    subscriber_capacity: 10,
    commercial_template: "per_alert",
    reveal_policy: { kind: "after_resolution" },
    refund_rule: { kind: "none" },
    slash_rule: { kind: "none" },
    created_at: "2026-06-12T09:00:00Z",
    updated_at: "2026-06-12T09:00:00Z",
  });
  insertPacket(1, "2026-06-12T09:00:30Z");
  insertPacket(3, "2026-06-12T09:01:00Z");

  const gapTick = feedSlaTickResponse({
    db,
    body: { max_incidents: 5, feed_limit: 10 },
    newIncidentId: () => "33333333-3333-4333-8333-333333333333",
    now: () => new Date("2026-06-12T09:01:30Z"),
  });
  assert.equal(gapTick.result.incidents_opened, 1);
  const gapIncident = feedSlaIncidentsRepo.byFeedSequence(
    db,
    "feed-sla-gap",
    2,
  );
  assert.equal(gapIncident?.incident_id, "33333333-3333-4333-8333-333333333333");
  assert.equal(
    gapIncident?.expected_delivery_deadline_at,
    "2026-06-12T09:01:30Z",
  );

  db.close();

  function insertPacket(sequence: number, acceptedAt: string): void {
    const discriminator = sequence.toString(16);
    feedPacketsRepo.insert(db, {
      packet_id: `00000000-0000-4000-8000-00000000010${sequence}`,
      feed_id: "feed-sla-gap",
      agent_id: "22222222-2222-4222-8222-222222222222",
      market_id: null,
      packet_kind: "heartbeat",
      sequence,
      payload_schema: "murmur-feed-packet-v1",
      submitted_at: acceptedAt,
      accepted_at: acceptedAt,
      reveal_after: "2026-06-12T10:00:00Z",
      delivery_deadline_at: null,
      sla_status: "on_time",
      chain_id: 84532,
      contract_address: `0x${"a".repeat(40)}`,
      onchain_packet_id: `0x${discriminator.repeat(64)}`,
      submit_tx_hash: `0x${discriminator.repeat(64)}`,
      submit_log_index: sequence,
      packet_ct_hash: `0x${discriminator.repeat(64)}`,
      binary_index_ct_hash: null,
      confidence_ct_hash: null,
      created_at: acceptedAt,
    });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("feed SLA surface smoke ok\n");
