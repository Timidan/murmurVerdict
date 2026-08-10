import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FhenixGatewayBroadcaster } from "../integrations/fhenix-gateway.js";

import { openDb } from "./db.js";
import {
  operatorGatewayRetryResponse,
  operatorGatewaySnapshotResponse,
  operatorGatewayTickResponse,
  sendOperatorGatewayJsonResponse,
  sendOperatorGatewayStatusJsonResponse,
} from "./operator-gateway-surface.js";
import { parseGatewayOperatorQuery } from "./operator-gateway-query.js";
import { buildGatewayOperatorSnapshot } from "./operator-gateway-snapshot.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-operator-gateway-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur operator gateway surface smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T09:30:00Z");
  const servedAt = now();

  const query = parseGatewayOperatorQuery({ limit: "3" });
  const unconfigured = operatorGatewaySnapshotResponse({
    db,
    servedAt,
    query,
  });
  assert.equal(unconfigured.schema_version, 1);
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.queues.stale_before, "2026-06-12T09:20:00Z");
  const snapshotTarget = {
    body: undefined as unknown,
    json(body: unknown) {
      this.body = body;
    },
  };
  sendOperatorGatewayJsonResponse(snapshotTarget, unconfigured);
  assert.equal(snapshotTarget.body, unconfigured);

  const disabledTick = await operatorGatewayTickResponse({ now, query });
  assert.deepEqual(disabledTick, {
    status: 503,
    body: {
      code: "gateway_disabled",
      message: "Fhenix Gateway broadcaster is not configured",
    },
  });
  const disabledTickTarget = makeStatusJsonTarget();
  sendOperatorGatewayStatusJsonResponse(disabledTickTarget, disabledTick);
  assert.equal(disabledTickTarget.statusCode, 503);
  assert.equal(disabledTickTarget.body, disabledTick.body);
  assert.deepEqual(
    await operatorGatewayRetryResponse({
      now,
      attemptId: "missing",
    }),
    {
      status: 503,
      body: {
        code: "gateway_disabled",
        message: "Fhenix Gateway broadcaster is not configured",
      },
    },
  );

  const gateway = fakeGateway(db);
  const tick = await operatorGatewayTickResponse({ gateway, now, query });
  assert.equal(tick.status, 200);
  assert.equal(tick.body.schema_version, 1);
  assert.equal(tick.body.served_at, "2026-06-12T09:30:00Z");
  assert.equal(tick.body.result.broadcasted, 1);
  assert.equal(tick.body.gateway.schema_version, 1);
  assert.equal(tick.body.gateway.configured, true);
  assert.equal(tick.body.gateway.served_at, tick.body.served_at);
  const tickTarget = makeStatusJsonTarget();
  sendOperatorGatewayStatusJsonResponse(tickTarget, tick);
  assert.equal(tickTarget.statusCode, 200);
  assert.equal(tickTarget.body, tick.body);

  const retry = await operatorGatewayRetryResponse({
    gateway,
    now,
    attemptId: "attempt-1",
  });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.schema_version, 1);
  assert.equal(retry.body.served_at, "2026-06-12T09:30:00Z");
  assert.equal(retry.body.attempt_id, "attempt-1");
  const retryTarget = makeStatusJsonTarget();
  sendOperatorGatewayStatusJsonResponse(retryTarget, retry);
  assert.equal(retryTarget.statusCode, 202);
  assert.equal(retryTarget.body, retry.body);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("operator gateway surface smoke ok\n");

function fakeGateway(
  db: ReturnType<typeof openDb>,
): Pick<FhenixGatewayBroadcaster, "operatorSnapshot" | "retryAttemptNow" | "tick"> {
  return {
    operatorSnapshot: (opts) =>
      buildGatewayOperatorSnapshot({
        db,
        servedAt: opts.servedAt,
        status: opts.status,
        limit: opts.limit ?? 50,
        stuckAfterMs: opts.stuckAfterMs,
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
      }),
    tick: async () => ({
      broadcasted: 1,
      confirmed: 2,
      accepted: 3,
      failed: 0,
    }),
    retryAttemptNow: async (attemptId: string) => ({
      status: 202,
      body: {
        attempt_id: attemptId,
        status: "submitted",
        tx_hash: `0x${"1".repeat(64)}`,
        call_id: null,
        next_attempt_at: "2026-06-12T09:31:00Z",
        idempotent_hit: false,
      },
    }),
  };
}

function makeStatusJsonTarget() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return {
        json: (body: unknown) => {
          this.body = body;
        },
      };
    },
  };
}
