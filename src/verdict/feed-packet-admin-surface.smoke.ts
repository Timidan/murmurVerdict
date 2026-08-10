import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  feedPacketBackfillResponse,
  sendFeedPacketAdminJsonResponse,
} from "./feed-packet-admin-surface.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { feedContractsRepo } from "./repos/feed-availability-repo.js";
import { VerdictError } from "./schema.js";

class FakeFeedPacketAdminJsonResponse {
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

const tmp = mkdtempSync(join(tmpdir(), "murmur-feed-packet-admin-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur feed packet admin surface smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-01-02T00:02:00Z");
  const agentId = randomUUID();
  const packetIds = ["00000000-0000-4000-8000-000000000201"];
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

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "feed-packet-admin",
    kind: "agent",
    display_name: "Feed Packet Admin",
    created_at: "2026-01-02T00:00:00Z",
  });
  insertFeed(db, agentId, "feed-admin", "listed");
  insertFeed(db, agentId, "feed-retired", "retired");

  const missing = feedPacketBackfillResponse({
    // The route is gated on the same acknowledgement as live feed submission,
    // because it also lands packets in SLA and public feed state. These cases
    // exercise the backfill logic itself.
    feedRevealAcknowledged: true,
    db,
    feedId: "missing",
    body: {},
    now,
  });
  assert.deepEqual(missing, {
    status: 404,
    body: { code: "not_found", message: "feed not found" },
  });
  const missingRes = new FakeFeedPacketAdminJsonResponse();
  sendFeedPacketAdminJsonResponse(missingRes, missing);
  assert.equal(missingRes.statusCode, 404);
  assert.equal((missingRes.body as typeof missing.body).code, "not_found");

  assert.throws(
    () =>
      feedPacketBackfillResponse({
        feedRevealAcknowledged: true,
        db,
        feedId: "feed-retired",
        body: packetBody("1", "2", "3"),
        newPacketId: unexpectedPacketId,
        now,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 409,
  );

  assert.throws(
    () =>
      feedPacketBackfillResponse({
        feedRevealAcknowledged: true,
        db,
        feedId: "feed-admin",
        body: { packet_kind: "verdict" },
        newPacketId: unexpectedPacketId,
        now,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const inserted = feedPacketBackfillResponse({
    feedRevealAcknowledged: true,
    db,
    feedId: "feed-admin",
    body: packetBody("1", "2", "3"),
    newPacketId,
    now,
  });
  assert.equal(inserted.status, 201);
  assert.equal(inserted.body.schema_version, 1);
  assert.equal(inserted.body.idempotent_hit, false);
  assert.equal(
    inserted.body.packet.packet_id,
    "00000000-0000-4000-8000-000000000201",
  );
  assert.equal(inserted.body.packet.feed_id, "feed-admin");
  assert.equal(inserted.body.packet.sequence, 1);
  assert.equal(inserted.body.packet.sla_status, "on_time");
  assert.equal(inserted.body.reliability.packets_total, 1);
  const insertedRes = new FakeFeedPacketAdminJsonResponse();
  sendFeedPacketAdminJsonResponse(insertedRes, inserted);
  assert.equal(insertedRes.statusCode, 201);
  assert.equal((insertedRes.body as typeof inserted.body).packet.feed_id, "feed-admin");

  const repeated = feedPacketBackfillResponse({
    feedRevealAcknowledged: true,
    db,
    feedId: "feed-admin",
    body: packetBody("1", "2", "3"),
    newPacketId: unexpectedPacketId,
    now,
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.schema_version, 1);
  assert.equal(repeated.body.idempotent_hit, true);
  assert.equal(repeated.body.packet.packet_id, inserted.body.packet.packet_id);
  const repeatedRes = new FakeFeedPacketAdminJsonResponse();
  sendFeedPacketAdminJsonResponse(repeatedRes, repeated);
  assert.equal(repeatedRes.statusCode, 200);
  assert.equal((repeatedRes.body as typeof repeated.body).idempotent_hit, true);
  assert.deepEqual(consumedPacketIds, [
    "00000000-0000-4000-8000-000000000201",
  ]);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("feed packet admin surface smoke ok\n");

function insertFeed(
  db: ReturnType<typeof openDb>,
  agentId: string,
  feedId: string,
  status: "listed" | "retired",
): void {
  feedContractsRepo.insert(db, {
    feed_id: feedId,
    agent_id: agentId,
    name: feedId,
    description: null,
    status,
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
}

function packetBody(
  onchainPacketId: string,
  txHash: string,
  packetHash: string,
) {
  return {
    packet_kind: "verdict",
    payload_schema: "murmur-feed-packet-v1",
    fhenix: {
      chain_id: 84532,
      contract_address: `0x${"A".repeat(40)}`,
      onchain_packet_id: `0x${onchainPacketId.repeat(64)}`,
      submit_tx_hash: `0x${txHash.repeat(64)}`,
      submit_log_index: 0,
      packet_ct_hash: `0x${packetHash.repeat(64)}`,
      accepted_at: "2026-01-02T00:00:30Z",
      reveal_after: "2026-01-02T00:05:00Z",
    },
  };
}
