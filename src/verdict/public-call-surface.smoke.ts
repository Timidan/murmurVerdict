import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  publicCallDetailResponse,
  sendPublicCallJsonResponse,
} from "./public-call-surface.js";
import {
  agentsRepo,
} from "./repos/agents-repo.js";
import {
  submissionsRepo,
} from "./repos/sealed-call-submissions-repo.js";

class FakePublicCallJsonResponse {
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

const tmp = mkdtempSync(join(tmpdir(), "murmur-public-call-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur Public Call Surface smoke\n");
  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  const callId = randomUUID();
  const acceptedAt = "2026-06-12T10:00:00Z";

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "public-call-agent",
    kind: "agent",
    display_name: "Public Call Agent",
    created_at: acceptedAt,
  });
  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: callId,
    agent_id: agentId,
    client_order_id: "public-call-client-order",
    horizon_seconds: 3600,
    submitted_at: acceptedAt,
    accepted_at: acceptedAt,
    rationale: "private rationale must not leak",
    strategy_tag: "private-strategy-tag",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${callId}`,
    commit_hash: "a".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
  });

  const missing = publicCallDetailResponse({
    db,
    callId: randomUUID(),
  });
  assert.equal(missing.status, 404);
  if (missing.status !== 404) throw new Error("expected missing call");
  assert.deepEqual(missing.body, {
    code: "not_found",
    message: "call not found",
  });
  const missingRes = new FakePublicCallJsonResponse();
  sendPublicCallJsonResponse(missingRes, missing);
  assert.equal(missingRes.statusCode, 404);
  assert.deepEqual(missingRes.body, {
    code: "not_found",
    message: "call not found",
  });

  const detail = publicCallDetailResponse({
    db,
    callId,
  });
  assert.equal(detail.status, 200);
  if (detail.status !== 200) throw new Error("expected public call detail");
  assert.equal(detail.body.submission.call_id, callId);
  assert.equal(detail.body.submission.agent_id, agentId);
  assert.equal(detail.body.submission.client_order_id, "public-call-client-order");
  assert.equal(detail.body.submission.privacy_mode, "sealed_fhenix");
  assert.equal(detail.body.submission.commit_hash, "a".repeat(64));
  assert.equal(detail.body.t0, null);
  assert.equal(detail.body.resolution, null);
  assert.equal("fhenix" in detail.body, false);
  const serialized = JSON.stringify(detail.body);
  assert.equal(serialized.includes("private rationale"), false);
  assert.equal(serialized.includes("private-strategy-tag"), false);
  const detailRes = new FakePublicCallJsonResponse();
  sendPublicCallJsonResponse(detailRes, detail);
  assert.equal(detailRes.statusCode, 200);
  assert.equal((detailRes.body as typeof detail.body).submission.call_id, callId);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("Public Call Surface smoke ok\n");
