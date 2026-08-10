import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  buildGatewayOperatorSnapshot,
  unconfiguredGatewaySnapshot,
} from "./operator-gateway-snapshot.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-operator-gateway-snapshot-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur operator gateway snapshot smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T09:30:00Z");
  const servedAt = now();

  const unconfigured = unconfiguredGatewaySnapshot(db, { servedAt, limit: 3 });
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.config, null);
  assert.equal(unconfigured.queues.stale_before, "2026-06-12T09:20:00Z");
  assert.equal(unconfigured.status_counts.queued, 0);
  assert.equal(unconfigured.status_counts.failed_terminal, 0);
  assert.equal(unconfigured.feed_status_counts.queued, 0);
  assert.equal(unconfigured.feed_status_counts.failed_terminal, 0);

  const configured = buildGatewayOperatorSnapshot({
    db,
    servedAt,
    limit: 3,
    stuckAfterMs: 20_000,
    config: {
      chain_id: 84532,
      contract_address: "0x1111111111111111111111111111111111111111",
      relayer_address: "0x2222222222222222222222222222222222222222",
      confirmations: 2,
      retry_base_ms: 1_000,
      retry_max_ms: 60_000,
      max_attempts: 3,
      stuck_after_ms: 120_000,
    },
  });
  assert.equal(configured.configured, true);
  assert.equal(configured.config.stuck_after_ms, 60_000);
  assert.equal(configured.queues.stale_before, "2026-06-12T09:29:00Z");
  assert.equal(configured.status_counts.queued, 0);
  assert.equal(configured.feed_status_counts.queued, 0);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("operator gateway snapshot smoke ok\n");
