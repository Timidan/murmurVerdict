import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";

import { openDb } from "./db.js";
import {
  operatorAlertSnapshotResponse,
  operatorAlertTickResponse,
  sendOperatorAlertJsonResponse,
} from "./operator-alert-surface.js";
import { operatorAlertsRepo } from "./repos/operator-alerts-repo.js";
import { VerdictError } from "./schema.js";

class FakeOperatorAlertJsonResponse {
  body: unknown = null;

  json(body: unknown): void {
    this.body = body;
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-operator-alert-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur operator alert surface smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T09:30:00Z");
  const servedAt = now();
  const alertIds = ["00000000-0000-4000-8000-000000000601"];
  const consumedAlertIds: string[] = [];
  const newAlertId = () => {
    const id = alertIds.shift();
    assert.ok(id, "Operator Alert ID Adapter consumed too many IDs");
    consumedAlertIds.push(id);
    return id;
  };
  const liveCanaries: LiveCanaryProvider = {
    hasEnabledChecks: () => true,
    snapshot: () => ({
      schema_version: 1,
      served_at: "2026-06-12T09:30:00Z",
      ok: false,
      checks: [
        {
          name: "fhenix_rpc",
          status: "fail",
          checked_at: "2026-06-12T09:30:00Z",
          latency_ms: 12,
          details: { fixture: true },
          error: "surface canary failed",
        },
      ],
    }),
    runNow: async () => liveCanaries.snapshot(),
  };

  operatorAlertsRepo.upsertOpen(db, {
    alert_id: randomUUID(),
    alert_key: "surface:test:critical",
    source: "surface",
    kind: "surface_fixture",
    severity: "critical",
    title: "Surface fixture",
    description: "Operator Alert Surface fixture",
    payload_json: JSON.stringify({ fixture: true }),
    seen_at: "2026-06-12T09:00:00Z",
  });

  const snapshot = operatorAlertSnapshotResponse({
    db,
    servedAt,
    query: {
      status: "open",
      source: "surface",
      delivery_status: "pending",
      limit: 10,
    },
    sink: {
      webhookUrl: "https://alerts.example/operator",
      secret: "secret",
    },
  });
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.served_at, "2026-06-12T09:30:00Z");
  assert.equal(snapshot.sink_configured, true);
  assert.equal(snapshot.counts.open.critical, 1);
  assert.equal(snapshot.alerts.length, 1);
  assert.equal(snapshot.alerts[0]?.payload && typeof snapshot.alerts[0].payload, "object");
  const snapshotRes = new FakeOperatorAlertJsonResponse();
  sendOperatorAlertJsonResponse(snapshotRes, snapshot);
  assert.equal((snapshotRes.body as typeof snapshot).served_at, "2026-06-12T09:30:00Z");

  await assert.rejects(
    () =>
      operatorAlertTickResponse({
        db,
        now,
        body: { gateway_stuck_after_sec: 1 },
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const tick = await operatorAlertTickResponse({
    db,
    now,
    liveCanaries,
    newAlertId,
    body: {
      gateway_stuck_after_sec: 60,
      fhenix_reveal_grace_sec: 0,
      identity_due_soon_hours: 24,
    },
  });
  assert.equal(tick.schema_version, 1);
  assert.equal(tick.scan.served_at, "2026-06-12T09:30:00Z");
  assert.equal(tick.delivery.served_at, tick.scan.served_at);
  assert.equal(tick.delivery.attempted, 0);
  assert.equal(tick.snapshot.served_at, "2026-06-12T09:30:00Z");
  assert.equal(tick.snapshot.alerts[0]?.alert_id, "00000000-0000-4000-8000-000000000601");
  assert.deepEqual(consumedAlertIds, [
    "00000000-0000-4000-8000-000000000601",
  ]);
  const tickRes = new FakeOperatorAlertJsonResponse();
  sendOperatorAlertJsonResponse(tickRes, tick);
  assert.equal((tickRes.body as typeof tick).snapshot.served_at, "2026-06-12T09:30:00Z");

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("operator alert surface smoke ok\n");
