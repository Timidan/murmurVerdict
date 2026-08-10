import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentsRepo,
  feedContractsRepo,
  feedPacketsRepo,
  openDb,
} from "./db.js";
import { feedAvailabilitySummary } from "./feed-availability.js";
import { ingestFeedPacket } from "./feed-packet-ingestion.js";
import { VerdictError } from "./schema.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-feed-packet-ingestion-"));
const dbPath = join(tmp, "test.db");

try {
  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "feed-smoke",
    kind: "agent",
    display_name: "Feed Smoke",
    created_at: "2026-01-02T00:00:00Z",
  });
  feedContractsRepo.insert(db, {
    feed_id: "feed-smoke",
    agent_id: agentId,
    name: "Feed Smoke",
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
    refund_rule: { kind: "credit", missed_delivery_grace: 1 },
    slash_rule: { kind: "none" },
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  });
  const feed = feedContractsRepo.byId(db, "feed-smoke");
  assert.ok(feed);
  const packetIds = [
    "00000000-0000-4000-8000-000000000101",
    "00000000-0000-4000-8000-000000000102",
  ];
  const consumedPacketIds: string[] = [];
  const newPacketId = () => {
    const id = packetIds.shift();
    assert.ok(id, "Feed Packet ID Adapter consumed too many IDs");
    consumedPacketIds.push(id);
    return id;
  };
  const unexpectedPacketId = () => {
    throw new Error("Feed Packet ID Adapter should not be called");
  };

  const first = ingestFeedPacket({
    db,
    feed,
    packet_kind: "verdict",
    payload_schema: "murmur-feed-packet-v1",
    fhenix: fhenixEvent({
      onchainPacketId: "1",
      txHash: "2",
      packetHash: "3",
      acceptedAt: "2026-01-02T00:00:30Z",
      revealAfter: "2026-01-02T00:05:00Z",
    }),
    newPacketId,
    now: () => new Date("2026-01-02T00:02:00Z"),
  });
  assert.equal(first.kind, "inserted");
  assert.equal(first.packet.packet_id, "00000000-0000-4000-8000-000000000101");
  assert.equal(first.packet.sequence, 1);
  assert.equal(first.packet.delivery_deadline_at, "2026-01-02T00:01:00Z");
  assert.equal(first.packet.sla_status, "on_time");
  assert.equal(first.packet.contract_address, `0x${"a".repeat(40)}`);
  assert.equal(first.packet.created_at, "2026-01-02T00:02:00Z");

  const repeated = ingestFeedPacket({
    db,
    feed,
    packet_kind: "verdict",
    payload_schema: "murmur-feed-packet-v1",
    fhenix: fhenixEvent({
      onchainPacketId: "1",
      txHash: "2",
      packetHash: "3",
      acceptedAt: "2026-01-02T00:00:30Z",
      revealAfter: "2026-01-02T00:05:00Z",
    }),
    newPacketId: unexpectedPacketId,
    now: () => new Date("2026-01-02T00:02:00Z"),
  });
  assert.equal(repeated.kind, "idempotent");
  assert.equal(repeated.packet.packet_id, first.packet.packet_id);

  const second = ingestFeedPacket({
    db,
    feed,
    packet_kind: "heartbeat",
    payload_schema: "murmur-feed-packet-v1",
    fhenix: fhenixEvent({
      onchainPacketId: "4",
      txHash: "5",
      packetHash: "6",
      acceptedAt: "2026-01-02T00:02:10Z",
      revealAfter: "2026-01-02T00:03:00Z",
    }),
    newPacketId,
    now: () => new Date("2026-01-02T00:02:20Z"),
  });
  assert.equal(second.kind, "inserted");
  assert.equal(second.packet.packet_id, "00000000-0000-4000-8000-000000000102");
  assert.equal(second.packet.sequence, 2);
  assert.equal(second.packet.delivery_deadline_at, "2026-01-02T00:01:30Z");
  assert.equal(second.packet.sla_status, "late");
  assert.equal(feedPacketsRepo.listForFeed(db, "feed-smoke", 10).length, 2);
  const summary = feedAvailabilitySummary(db, feed, {
    now: new Date("2026-01-02T00:03:00Z"),
  });
  assert.equal(summary.scheduled_packets, 2);
  assert.equal(summary.on_time_packets, 1);
  assert.equal(summary.late_packets, 1);
  assert.equal(summary.health_status, "degraded");
  assert.equal(summary.reliability_score, 0.5);
  assert.equal(summary.overdue_grace_seconds, 60);
  assert.equal(summary.overdue, false);
  assert.match(summary.proof_hash, /^[0-9a-f]{64}$/);

  assert.throws(
    () =>
      ingestFeedPacket({
        db,
        feed,
        packet_kind: "verdict",
        payload_schema: "murmur-feed-packet-v1",
        fhenix: fhenixEvent({
          onchainPacketId: "7",
          txHash: "8",
          packetHash: "9",
          acceptedAt: "2026-01-02T00:10:00Z",
          revealAfter: "2026-01-02T00:09:59Z",
        }),
        newPacketId: unexpectedPacketId,
        now: () => new Date("2026-01-02T00:02:00Z"),
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );
  assert.deepEqual(consumedPacketIds, [
    "00000000-0000-4000-8000-000000000101",
    "00000000-0000-4000-8000-000000000102",
  ]);

  console.log("feed-packet-ingestion smoke ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function fhenixEvent(input: {
  onchainPacketId: string;
  txHash: string;
  packetHash: string;
  acceptedAt: string;
  revealAfter: string;
}) {
  return {
    chain_id: 84532,
    contract_address: `0x${"A".repeat(40)}`,
    onchain_packet_id: `0x${input.onchainPacketId.repeat(64)}`,
    submit_tx_hash: `0x${input.txHash.repeat(64)}`,
    submit_log_index: 0,
    packet_ct_hash: `0x${input.packetHash.repeat(64)}`,
    accepted_at: input.acceptedAt,
    reveal_after: input.revealAfter,
  };
}
