import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import express from "express";

import { createVerdictRouter } from "../api.js";
import { openDb } from "../db.js";
import { agentsRepo } from "../repos/agents-repo.js";

process.stdout.write("murmur public agent routes smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "murmur-public-agent-routes-"));
const dbPath = join(tmp, "test.db");

try {
  const db = openDb({ path: dbPath });
  agentsRepo.insert(db, {
    agent_id: randomUUID(),
    display_slug: "configured-origin-agent",
    kind: "agent",
    display_name: "Configured Origin Agent",
    created_at: "2026-06-12T09:00:00Z",
  });

  const app = express();
  app.use(createVerdictRouter({
    db,
    env: {},
    now: () => new Date("2026-06-12T10:00:00Z"),
    publicOrigin: {
      publicApiUrl: "https://api.murmur.example/public",
      dashboardUrl: null,
    },
  }));

  const { server, port } = await listen(app);
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/agents/configured-origin-agent/agent-card`,
      { headers: { Host: "internal-proxy.example" } },
    );
    assert.equal(res.status, 200);
    const card = await res.json() as {
      services?: Array<{ endpoint?: string }>;
      meta?: { call_history_entrypoint?: string; openapi?: string };
    };
    assert.equal(
      card.services?.[0]?.endpoint,
      "https://api.murmur.example/public/v1/agents/configured-origin-agent",
    );
    assert.equal(
      card.meta?.call_history_entrypoint,
      "https://api.murmur.example/public/v1/agents/configured-origin-agent/calls",
    );
    assert.equal(
      card.meta?.openapi,
      "https://api.murmur.example/public/v1/openapi.json",
    );
  } finally {
    await closeServer(server);
  }

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("  ok public agent card uses configured public origin\n");

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("server did not bind tcp address"));
        return;
      }
      resolve({ server, port: address.port });
    });
    server.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
