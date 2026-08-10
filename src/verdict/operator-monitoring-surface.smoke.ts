import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LiveCanaryProvider,
  LiveCanarySnapshot,
} from "../integrations/live-canaries.js";

import { openDb } from "./db.js";
import {
  operatorCanarySnapshotResponse,
  operatorCanaryTickResponse,
  operatorControllerIdentityResponse,
  sendOperatorMonitoringJsonResponse,
  sendOperatorMonitoringResultJsonResponse,
} from "./operator-monitoring-surface.js";

class FakeOperatorMonitoringResultJsonResponse {
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

class FakeOperatorMonitoringJsonResponse {
  body: unknown = null;

  json(body: unknown): void {
    this.body = body;
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-operator-monitoring-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur operator monitoring surface smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T09:30:00Z");
  const servedAt = now();

  const disabled = operatorCanarySnapshotResponse(null);
  assert.deepEqual(disabled, {
    status: 503,
    body: {
      code: "canaries_disabled",
      message: "Live canary runner is not configured",
    },
  });
  const disabledRes = new FakeOperatorMonitoringResultJsonResponse();
  sendOperatorMonitoringResultJsonResponse(disabledRes, disabled);
  assert.equal(disabledRes.statusCode, 503);
  assert.equal((disabledRes.body as typeof disabled.body).code, "canaries_disabled");

  const liveCanaries = canaries();
  const snapshot = operatorCanarySnapshotResponse(liveCanaries);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.ok, true);
  assert.equal(snapshot.body.checks[0]?.name, "fhenix_rpc");
  const snapshotRes = new FakeOperatorMonitoringResultJsonResponse();
  sendOperatorMonitoringResultJsonResponse(snapshotRes, snapshot);
  assert.equal(snapshotRes.statusCode, 200);
  assert.equal((snapshotRes.body as typeof snapshot.body).ok, true);

  const tick = await operatorCanaryTickResponse(liveCanaries);
  assert.equal(tick.status, 200);
  assert.equal(tick.body.served_at, "2026-06-12T09:30:05Z");
  const tickRes = new FakeOperatorMonitoringResultJsonResponse();
  sendOperatorMonitoringResultJsonResponse(tickRes, tick);
  assert.equal(tickRes.statusCode, 200);
  assert.equal((tickRes.body as typeof tick.body).served_at, "2026-06-12T09:30:05Z");

  const identity = operatorControllerIdentityResponse({
    db,
    servedAt,
    query: { limit: 10, dueSoonHours: 24 },
  });
  assert.equal(identity.schema_version, 1);
  assert.equal(identity.served_at, "2026-06-12T09:30:00Z");
  assert.equal(identity.due_soon_at, "2026-06-13T09:30:00Z");
  assert.equal(identity.counts.controller_wallets, 0);
  assert.equal(identity.counts.active_runtime_keys, 0);
  assert.equal(identity.needs_attention.length, 0);
  assert.equal(identity.rows.length, 0);
  const identityRes = new FakeOperatorMonitoringJsonResponse();
  sendOperatorMonitoringJsonResponse(identityRes, identity);
  assert.equal(
    (identityRes.body as typeof identity).served_at,
    "2026-06-12T09:30:00Z",
  );

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("operator monitoring surface smoke ok\n");

function canaries(): LiveCanaryProvider {
  const snapshot: LiveCanarySnapshot = {
    schema_version: 1,
    served_at: "2026-06-12T09:30:00Z",
    ok: true,
    checks: [
      {
        name: "fhenix_rpc",
        status: "ok",
        checked_at: "2026-06-12T09:29:59Z",
        latency_ms: 12,
        details: { chain_id: 84532 },
        error: null,
      },
    ],
  };
  return {
    snapshot: () => snapshot,
    runNow: async () => ({
      ...snapshot,
      served_at: "2026-06-12T09:30:05Z",
    }),
    hasEnabledChecks: () => true,
  };
}
