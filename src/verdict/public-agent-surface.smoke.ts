import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  listPublicAgentsResponse,
  publicAgentCallsResponse,
  publicAgentCardResponse,
  publicAgentProfileResponse,
  sendPublicAgentJsonResponse,
} from "./public-agent-surface.js";
import { agentsRepo } from "./repos/agents-repo.js";

class FakePublicAgentJsonResponse {
  headers: Record<string, string> = {};
  statusCode: number | null = null;
  body: unknown = null;

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  status(code: number): { json: (body: unknown) => void } {
    this.statusCode = code;
    return {
      json: (body: unknown) => {
        this.body = body;
      },
    };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-public-agent-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur Public Agent Surface smoke\n");
  const db = openDb({ path: dbPath });
  const servedAt = new Date("2026-06-12T10:00:00Z");
  const agentId = randomUUID();
  const newerAgentId = randomUUID();
  const benchmarkId = randomUUID();

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "public-agent",
    kind: "agent",
    display_name: "Public Agent",
    bio: "A public agent profile.",
    created_at: "2026-06-12T09:50:00Z",
    wallet_address: "0x1111111111111111111111111111111111111111",
    chain_id: "eip155:84532",
  });
  agentsRepo.insert(db, {
    agent_id: newerAgentId,
    display_slug: "public-agent-new",
    kind: "agent",
    display_name: "Public Agent New",
    created_at: "2026-06-12T09:55:00Z",
  });
  agentsRepo.insert(db, {
    agent_id: benchmarkId,
    display_slug: "benchmark-agent",
    kind: "benchmark",
    display_name: "Benchmark Agent",
    created_at: "2026-06-12T09:40:00Z",
  });

  const invalid = listPublicAgentsResponse({
    db,
    servedAt,
    query: {
      status: 400,
      body: {
        code: "invalid_kind",
        message: "kind must be one of agent|attested|benchmark|internal_test",
      },
    },
  });
  assert.equal(invalid.status, 400);
  if (invalid.status !== 400) throw new Error("expected invalid kind");
  assert.equal(invalid.body.code, "invalid_kind");

  const listed = listPublicAgentsResponse({
    db,
    servedAt,
    query: { kind: "agent", limit: 1 },
  });
  assert.equal(listed.status, 200);
  if (listed.status !== 200) throw new Error("expected public agent list");
  assert.equal(listed.body.schema_version, 1);
  assert.equal(listed.body.served_at, "2026-06-12T10:00:00Z");
  assert.equal(listed.body.kind, "agent");
  assert.equal(listed.body.count, 1);
  const listedRow = listed.body.rows[0];
  assert.ok(listedRow);
  assert.equal(listedRow.display_slug, "public-agent-new");
  assert.equal("api_key_hash" in listedRow, false);

  const profile = publicAgentProfileResponse({
    db,
    slug: "public-agent",
  });
  assert.equal(profile.status, 200);
  if (profile.status !== 200) throw new Error("expected public agent profile");
  assert.equal(profile.body.agent_id, agentId);
  assert.equal(profile.body.display_slug, "public-agent");
  assert.equal(profile.body.wallet_address, "0x1111111111111111111111111111111111111111");
  assert.equal(profile.body.chain_id, "eip155:84532");
  assert.equal("api_key_hash" in profile.body, false);

  const missingProfile = publicAgentProfileResponse({
    db,
    slug: "missing-agent",
  });
  assert.equal(missingProfile.status, 404);
  if (missingProfile.status !== 404) throw new Error("expected missing profile");
  assert.deepEqual(missingProfile.body, {
    code: "unknown_agent",
    message: "agent not found",
  });

  const card = publicAgentCardResponse({
    db,
    slug: "public-agent",
    apiBase: "https://murmur.example/",
    servedAt,
  });
  assert.equal(card.status, 200);
  if (card.status !== 200) throw new Error("expected public agent card");
  assert.equal(card.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(card.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(card.body.slug, "public-agent");
  assert.equal(
    card.body.meta.call_history_entrypoint,
    "https://murmur.example/v1/agents/public-agent/calls",
  );
  assert.equal(card.body.murmur_wallet?.address, "0x1111111111111111111111111111111111111111");
  const cardRes = new FakePublicAgentJsonResponse();
  sendPublicAgentJsonResponse(cardRes, card);
  assert.equal(cardRes.statusCode, 200);
  assert.equal(cardRes.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(cardRes.headers["Access-Control-Allow-Origin"], "*");
  assert.equal((cardRes.body as typeof card.body).slug, "public-agent");

  const missingCard = publicAgentCardResponse({
    db,
    slug: "missing-agent",
    apiBase: "https://murmur.example/",
    servedAt,
  });
  assert.equal(missingCard.status, 404);
  const missingCardRes = new FakePublicAgentJsonResponse();
  sendPublicAgentJsonResponse(missingCardRes, missingCard);
  assert.equal(missingCardRes.statusCode, 404);
  assert.deepEqual(missingCardRes.headers, {});
  assert.deepEqual(missingCardRes.body, {
    code: "unknown_agent",
    message: "agent not found",
  });

  const calls = publicAgentCallsResponse({
    db,
    slug: "public-agent",
    query: { limit: 5 },
  });
  assert.equal(calls.status, 200);
  if (calls.status !== 200) throw new Error("expected public agent calls");
  assert.equal(calls.body.agent_id, agentId);
  assert.equal(calls.body.display_slug, "public-agent");
  assert.deepEqual(calls.body.calls, []);

  const missingCalls = publicAgentCallsResponse({
    db,
    slug: "missing-agent",
    query: { limit: 50 },
  });
  assert.equal(missingCalls.status, 404);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("Public Agent Surface smoke ok\n");
