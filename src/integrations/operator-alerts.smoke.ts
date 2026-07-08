import express from "express";
import { strict as assert } from "node:assert";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVerdictRouter } from "../verdict/api.js";
import {
  agentsRepo,
  openDb,
  operatorAlertsRepo,
} from "../verdict/db.js";
import { getOrCreateAccount } from "../verdict/auth/accounts.js";
import {
  deliverOperatorAlerts,
  loadOperatorAlertSinkConfig,
  OperatorAlertSinkConfigError,
  runOperatorAlertScan,
  type OperatorAlertDeliveryFetch,
} from "../verdict/operator-alerts.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-operator-alerts-smoke-"));
const dbPath = join(tmp, "test.db");
let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    process.stdout.write(`  ok ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  fail ${name}\n`);
    process.stdout.write(`      ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

try {
  process.stdout.write("murmur operator alerts smoke\n");
  const db = openDb({ path: dbPath });
  const now = "2026-06-12T09:30:00Z";
  const agentId = randomUUID();
  const currentAgentId = randomUUID();
  const alertIds = ["00000000-0000-4000-8000-000000000501"];
  const consumedAlertIds: string[] = [];
  const newAlertId = () => {
    const id = alertIds.shift();
    assert.ok(id, "Operator Alert ID Adapter consumed too many IDs");
    consumedAlertIds.push(id);
    return id;
  };
  const unexpectedAlertId = () => {
    throw new Error("Operator Alert ID Adapter should not be called");
  };

  await check("operator alert sink config rejects malformed timeout", () => {
    assert.equal(
      loadOperatorAlertSinkConfig({ MURMUR_OPERATOR_ALERT_TIMEOUT_MS: "" }).timeoutMs,
      5_000,
    );
    assert.equal(
      loadOperatorAlertSinkConfig({ MURMUR_OPERATOR_ALERT_TIMEOUT_MS: "1234" }).timeoutMs,
      1234,
    );
    assert.throws(
      () => loadOperatorAlertSinkConfig({ MURMUR_OPERATOR_ALERT_TIMEOUT_MS: "zero" }),
      (err) =>
        err instanceof OperatorAlertSinkConfigError &&
        err.key === "MURMUR_OPERATOR_ALERT_TIMEOUT_MS",
    );
    assert.throws(
      () => loadOperatorAlertSinkConfig({ MURMUR_OPERATOR_ALERT_TIMEOUT_MS: "0" }),
      (err) =>
        err instanceof OperatorAlertSinkConfigError &&
        err.key === "MURMUR_OPERATOR_ALERT_TIMEOUT_MS",
    );
  });

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "operator-alerts-smoke",
    kind: "agent",
    display_name: "Operator Alerts Smoke",
    created_at: "2026-05-15T09:30:00Z",
  });
  const account = getOrCreateAccount(db, {
    privy_user_id: "did:privy:operator-alerts-smoke",
    session_id: "operator-alerts-smoke-session",
    expires_at: "2026-06-12T12:00:00Z",
  }, {
    resolvedAt: new Date("2026-05-15T09:30:00Z"),
  });
  db.prepare(
    `INSERT INTO agent_controller_wallets
     (agent_id, account_id, wallet_address, chain_id, wallet_kind, provider,
      binding_message, binding_signature, created_at, last_attested_at,
      reattestation_due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agentId,
    account.account_id,
    "0x1111111111111111111111111111111111111111",
    "eip155:84532",
    "embedded",
    "privy",
    "binding",
    "0xsig",
    "2026-05-15T09:30:00Z",
    "2026-05-28T09:30:00Z",
    "2026-06-11T09:30:00Z",
  );
  agentsRepo.insert(db, {
    agent_id: currentAgentId,
    display_slug: "operator-alerts-current",
    kind: "agent",
    display_name: "Operator Alerts Current",
    created_at: "2026-06-10T09:30:00Z",
  });
  const currentAccount = getOrCreateAccount(db, {
    privy_user_id: "did:privy:operator-alerts-current",
    session_id: "operator-alerts-current-session",
    expires_at: "2026-06-12T12:00:00Z",
  }, {
    resolvedAt: new Date("2026-06-10T09:30:00Z"),
  });
  db.prepare(
    `INSERT INTO agent_controller_wallets
     (agent_id, account_id, wallet_address, chain_id, wallet_kind, provider,
      binding_message, binding_signature, created_at, last_attested_at,
      reattestation_due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    currentAgentId,
    currentAccount.account_id,
    "0x2222222222222222222222222222222222222222",
    "eip155:84532",
    "embedded",
    "privy",
    "binding-current",
    "0xsig-current",
    "2026-06-10T09:30:00Z",
    "2026-06-10T09:30:00Z",
    null,
  );

  await check("scan persists overdue identity alert", () => {
    const scan = runOperatorAlertScan({
      db,
      now: () => new Date(now),
      identityDueSoonHours: 24,
      newAlertId,
    });
    assert.equal(scan.open_counts.open.critical, 1);
    const rows = operatorAlertsRepo.list(db, { status: "open" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.alert_id, "00000000-0000-4000-8000-000000000501");
    assert.equal(rows[0]?.source, "identity");
    assert.equal(rows[0]?.kind, "controller_reattestation_overdue");
    assert.equal(rows[0]?.alert_key, `identity:controller:overdue:${agentId}`);
    assert.deepEqual(consumedAlertIds, [
      "00000000-0000-4000-8000-000000000501",
    ]);
  });

  await check("scan idempotent path does not consume Operator Alert IDs", () => {
    const scan = runOperatorAlertScan({
      db,
      now: () => new Date(now),
      identityDueSoonHours: 24,
      newAlertId: unexpectedAlertId,
    });
    assert.equal(scan.open_counts.open.critical, 1);
    const rows = operatorAlertsRepo.list(db, { status: "open" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.alert_id, "00000000-0000-4000-8000-000000000501");
    assert.equal(rows[0]?.occurrence_count, 2);
    assert.deepEqual(consumedAlertIds, [
      "00000000-0000-4000-8000-000000000501",
    ]);
  });

  await check("admin alerts route exposes persisted alert", async () => {
    const app = express();
    app.use(createVerdictRouter({
      db,
      adminToken: "admin-token",
      now: () => new Date(now),
    }));
    const { server, port } = await listen(app);
    try {
      const denied = await fetch(`http://127.0.0.1:${port}/v1/admin/alerts`);
      assert.equal(denied.status, 403);
      const res = await fetch(`http://127.0.0.1:${port}/v1/admin/alerts`, {
        headers: { "X-Admin-Token": "admin-token" },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as {
        counts?: { open?: { critical?: number } };
        alerts?: Array<{ source?: string }>;
      };
      assert.equal(body.counts?.open?.critical, 1);
      assert.equal(body.alerts?.[0]?.source, "identity");
    } finally {
      await closeServer(server);
    }
  });

  await check("webhook sink receives signed operator alert", async () => {
    const secret = "operator-secret";
    let receivedBody = "";
    let receivedSignature = "";
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const fetchOk: OperatorAlertDeliveryFetch = async (url, init) => {
      captured.push({ url, init });
      receivedBody = String(init.body ?? "");
      receivedSignature = String(
        (init.headers as Record<string, string>)["X-Murmur-Signature"] ?? "",
      );
      return { status: 204, ok: true, text: async () => "" };
    };
    const result = await deliverOperatorAlerts({
      db,
      sink: {
        webhookUrl: "https://alerts.example/operator",
        secret,
      },
      deliveredAt: new Date(now),
      fetch: fetchOk,
    });
    assert.equal(result.served_at, now);
    assert.equal(result.attempted, 1);
    assert.equal(result.delivered, 1);
    assert.equal(captured[0]?.url, "https://alerts.example/operator");
    assert.equal(JSON.parse(receivedBody).delivered_at, now);
    assert.match(receivedSignature, /^sha256=[0-9a-f]{64}$/);
    const expected = createHmac("sha256", secret).update(receivedBody).digest("hex");
    assert.equal(receivedSignature, `sha256=${expected}`);
    const row = operatorAlertsRepo.list(db, { status: "open" })[0];
    assert.equal(row?.delivery_status, "delivered");
    assert.equal(row?.delivery_attempts, 1);
    assert.equal(row?.last_delivery_at, now);
    assert.equal(row?.last_delivery_status, 204);
  });

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  process.stdout.write(`operator alerts smoke failed: ${failures} failure(s)\n`);
  process.exit(1);
}

process.stdout.write("operator alerts smoke ok\n");

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("server did not bind tcp address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
