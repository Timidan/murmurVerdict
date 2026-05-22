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
  runOperatorAlertScan,
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

  await check("scan persists overdue identity alert", () => {
    const scan = runOperatorAlertScan({
      db,
      now: () => new Date(now),
      identityDueSoonHours: 24,
    });
    assert.equal(scan.open_counts.open.critical, 1);
    const rows = operatorAlertsRepo.list(db, { status: "open" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.source, "identity");
    assert.equal(rows[0]?.kind, "controller_reattestation_overdue");
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
    const sink = express();
    sink.use(express.text({ type: "*/*" }));
    sink.post("/alerts", (req, res) => {
      receivedBody = String(req.body);
      receivedSignature = String(req.header("X-Murmur-Signature") ?? "");
      res.status(204).end();
    });
    const { server, port } = await listen(sink);
    try {
      const result = await deliverOperatorAlerts(db, {
        webhookUrl: `http://127.0.0.1:${port}/alerts`,
        secret,
      }, () => new Date(now));
      assert.equal(result.attempted, 1);
      assert.equal(result.delivered, 1);
      assert.match(receivedSignature, /^sha256=[0-9a-f]{64}$/);
      const expected = createHmac("sha256", secret).update(receivedBody).digest("hex");
      assert.equal(receivedSignature, `sha256=${expected}`);
      const row = operatorAlertsRepo.list(db, { status: "open" })[0];
      assert.equal(row?.delivery_status, "delivered");
      assert.equal(row?.delivery_attempts, 1);
    } finally {
      await closeServer(server);
    }
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
