import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  createFeedContractResponse,
  sendFeedContractJsonResponse,
} from "./feed-contract-surface.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { feedContractsRepo } from "./repos/feed-availability-repo.js";
import { VerdictError } from "./schema.js";

class FakeFeedContractJsonResponse {
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

const tmp = mkdtempSync(join(tmpdir(), "murmur-feed-contract-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur feed contract surface smoke\n");
  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  const now = () => new Date("2026-06-12T09:30:00Z");
  const unexpectedFeedId = () => {
    throw new Error("feed id adapter should not be called before validation passes");
  };
  const feedIds: string[] = [];
  const newFeedId = () => {
    const id = "feed-contract-surface";
    feedIds.push(id);
    return id;
  };

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "feed-contract",
    kind: "agent",
    display_name: "Feed Contract",
    created_at: "2026-06-12T09:00:00Z",
  });

  assert.throws(
    () =>
      createFeedContractResponse({
        db,
        agentId,
        now,
        newFeedId: unexpectedFeedId,
        body: {
          name: "No Cadence",
          resolution_classes: ["event_binary"],
          edge_classes: ["latency"],
          commercial_template: "per_alert",
        },
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  assert.throws(
    () =>
      createFeedContractResponse({
        db,
        agentId,
        now,
        newFeedId: unexpectedFeedId,
        body: {
          ...feedBody(),
          venue: "unsupported-venue",
        },
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 422,
  );

  const created = createFeedContractResponse({
    db,
    agentId,
    now,
    newFeedId,
    body: feedBody(),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.schema_version, 1);
  assert.equal(created.body.feed.feed_id, "feed-contract-surface");
  assert.equal(created.body.feed.agent_slug, "feed-contract");
  assert.equal(created.body.feed.status, "listed");
  assert.equal(created.body.feed.delivery_cadence_seconds, 300);
  assert.equal(created.body.feed.availability.next_expected_sequence, 1);
  assert.equal(created.body.feed.availability.next_deadline_at, "2026-06-12T09:35:00Z");
  assert.equal(created.body.feed.availability.overdue, false);
  assert.equal(created.body.feed.availability.payment_execution_enabled, false);
  assert.deepEqual(feedIds, ["feed-contract-surface"]);
  const createdRes = new FakeFeedContractJsonResponse();
  sendFeedContractJsonResponse(createdRes, created);
  assert.equal(createdRes.statusCode, 201);
  assert.equal((createdRes.body as typeof created.body).feed.feed_id, "feed-contract-surface");

  const row = feedContractsRepo.byId(db, "feed-contract-surface");
  assert.ok(row);
  assert.equal(row.agent_id, agentId);
  assert.equal(row.created_at, "2026-06-12T09:30:00Z");
  assert.equal(row.updated_at, "2026-06-12T09:30:00Z");

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("feed contract surface smoke ok\n");

function feedBody() {
  return {
    name: "Alpha Feed",
    description: "Event binary feed",
    status: "listed",
    venue: "polymarket-gamma",
    resolution_classes: ["event_binary"],
    edge_classes: ["latency"],
    covered_market_ids: [],
    delivery_cadence_seconds: 300,
    trigger_rules: [],
    max_latency_seconds: 60,
    subscriber_capacity: 5,
    commercial_template: "per_alert",
    reveal_policy: { kind: "after_resolution" },
    refund_rule: { kind: "credit", missed_delivery_grace: 1 },
    slash_rule: { kind: "none" },
  };
}
