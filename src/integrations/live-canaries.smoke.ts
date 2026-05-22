import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { LiveCanaryRunner, type FhenixCanaryClient } from "./live-canaries.js";
import { createVerdictRouter } from "../verdict/api.js";
import { openDb } from "../verdict/db.js";
import { SCHEMA_VERSION } from "../verdict/schema.js";

process.stdout.write("murmur live canaries smoke\n");

const conditionId = `0x${"12".repeat(32)}`;
const tmp = mkdtempSync(join(tmpdir(), "murmur-live-canaries-smoke-"));
const db = openDb({ path: join(tmp, "verdict.db") });
let failures = 0;
let server: Server | null = null;

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`not ok - ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

const fhenixClient: FhenixCanaryClient = {
  getChainId: async () => 8008135,
  getBlockNumber: async () => 123456n,
  getCode: async () => "0x60016001",
};

const runner = new LiveCanaryRunner({
  schemaVersion: SCHEMA_VERSION,
  db,
  now: () => new Date("2026-05-15T12:00:00Z"),
  fhenix: {
    enabled: true,
    expectedChainId: 8008135,
    contractAddress: "0x1111111111111111111111111111111111111111",
    requireContractCode: true,
    client: fhenixClient,
  },
  polymarket: {
    enabled: true,
    conditionId,
    client: {
      fetchMarketByConditionId: async (id) => ({
        snapshot: {
          conditionId: id,
          closed: false,
          slug: "live-canary-smoke",
          endDate: "2026-06-01T00:00:00Z",
        },
        source: "fresh",
        error: null,
      }),
    },
  },
});

await check("runner succeeds with Fhenix and Polymarket checks", async () => {
  const snapshot = await runner.runNow();
  assert(snapshot.ok, "snapshot should be ok");
  assert(snapshot.checks.length === 2, "expected two checks");
  assert(snapshot.checks.every((row) => row.status === "ok"), "expected all checks ok");
});

await check("runner fails closed on Fhenix chain mismatch", async () => {
  const failing = new LiveCanaryRunner({
    schemaVersion: SCHEMA_VERSION,
    now: () => new Date("2026-05-15T12:00:00Z"),
    fhenix: {
      enabled: true,
      expectedChainId: 8008135,
      contractAddress: null,
      requireContractCode: false,
      client: {
        ...fhenixClient,
        getChainId: async () => 7,
      },
    },
    polymarket: {
      enabled: false,
      conditionId: null,
      client: null,
    },
  });
  const snapshot = await failing.runNow();
  assert(!snapshot.ok, "snapshot should fail");
  const fhenix = snapshot.checks.find((row) => row.name === "fhenix_rpc");
  assert(fhenix?.status === "fail", "fhenix check should fail");
  assert(fhenix.error?.startsWith("chain_id_mismatch"), "expected mismatch error");
});

await check("admin canary routes and required readiness use cached snapshot", async () => {
  await runner.runNow();
  const app = express();
  app.use(createVerdictRouter({
    db,
    adminToken: "admin-token",
    liveCanaries: runner,
    requireLiveCanaries: true,
    now: () => new Date("2026-05-15T12:00:00Z"),
  }));
  const started = await listen(app);
  server = started.server;
  const baseUrl = `http://127.0.0.1:${started.port}`;

  const denied = await fetch(`${baseUrl}/v1/admin/canaries`);
  assert(denied.status === 403, `expected 403, got ${denied.status}`);

  const canaries = await fetch(`${baseUrl}/v1/admin/canaries`, {
    headers: { "X-Admin-Token": "admin-token" },
  });
  assert(canaries.status === 200, `expected 200, got ${canaries.status}`);
  const body = await canaries.json() as { ok?: unknown; checks?: unknown[] };
  assert(body.ok === true, "expected canary body ok=true");
  assert(Array.isArray(body.checks) && body.checks.length === 2, "expected two checks");

  const ready = await fetch(`${baseUrl}/v1/readyz`);
  assert(ready.status === 200, `expected readyz 200, got ${ready.status}`);
  const readyBody = await ready.json() as { canaries?: { required?: boolean; ok?: boolean } };
  assert(readyBody.canaries?.required === true, "expected required canaries");
  assert(readyBody.canaries?.ok === true, "expected ready canaries");
});

if (server) {
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
}
db.close();
rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  process.stdout.write(`live canaries smoke failed: ${failures} failure(s)\n`);
  process.exit(1);
}
process.stdout.write("live canaries smoke ok\n");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("server did not bind tcp address"));
        return;
      }
      resolve({ server: s, port: addr.port });
    });
    s.once("error", reject);
  });
}
