import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FhenixEventVerifier } from "../integrations/fhenix-events.js";

import { agentsRepo, openDb } from "./db.js";
import {
  operatorFhenixBackfillCallResponse,
  operatorFhenixInvalidRevealResponse,
  operatorFhenixLifecycleResponse,
  operatorFhenixRevealResponse,
  sendOperatorFhenixJsonResponse,
  sendOperatorFhenixStatusJsonResponse,
} from "./operator-fhenix-surface.js";
import { VerdictError } from "./schema.js";

class FakeOperatorFhenixStatusJsonResponse {
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

class FakeOperatorFhenixJsonResponse {
  body: unknown = null;

  json(body: unknown): void {
    this.body = body;
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-operator-fhenix-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur operator fhenix surface smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T09:30:00Z");
  const servedAt = now();
  const verifier = failIfCalledVerifier();
  const agentId = randomUUID();

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "operator-fhenix-surface-agent",
    kind: "agent",
    display_name: "Operator Fhenix Surface Agent",
    created_at: "2026-06-12T09:00:00Z",
  });

  const lifecycle = operatorFhenixLifecycleResponse({
    db,
    servedAt,
    verifierConfigured: false,
    query: { limit: 10, graceSeconds: 3600 },
  });
  assert.equal(lifecycle.schema_version, 1);
  assert.equal(lifecycle.served_at, "2026-06-12T09:30:00Z");
  assert.equal(lifecycle.configured.verifier, false);
  assert.equal(lifecycle.queues.grace_cutoff, "2026-06-12T08:30:00Z");
  assert.equal(lifecycle.queues.needs_attention, 0);
  const lifecycleRes = new FakeOperatorFhenixJsonResponse();
  sendOperatorFhenixJsonResponse(lifecycleRes, lifecycle);
  assert.equal((lifecycleRes.body as typeof lifecycle).served_at, "2026-06-12T09:30:00Z");

  await assert.rejects(
    () =>
      operatorFhenixBackfillCallResponse({
        db,
        now,
        agentSlug: undefined,
        rawBody: "{}",
        fhenixVerifier: verifier,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  await assert.rejects(
    () =>
      operatorFhenixBackfillCallResponse({
        db,
        now,
        agentSlug: "missing-agent",
        rawBody: "{}",
        fhenixVerifier: verifier,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 404,
  );

  await assert.rejects(
    () =>
      operatorFhenixBackfillCallResponse({
        db,
        now,
        agentSlug: "operator-fhenix-surface-agent",
        rawBody: "{",
        fhenixVerifier: verifier,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  await assert.rejects(
    () =>
      operatorFhenixBackfillCallResponse({
        db,
        now,
        agentSlug: "operator-fhenix-surface-agent",
        rawBody: JSON.stringify({ privacy_mode: "sealed_fhenix" }),
        fhenixVerifier: verifier,
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );
  const rejectedUsage = db.prepare(
    "SELECT COUNT(*) AS n FROM usage_events WHERE agent_id = ? AND kind = 'submission_rejected'",
  ).get(agentId) as { n: number } | undefined;
  assert.equal(rejectedUsage?.n, 1);

  await assert.rejects(
    () =>
      operatorFhenixRevealResponse({
        db,
        now,
        verifier,
        body: { call_id: "not-a-uuid" },
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const missingReveal = await operatorFhenixRevealResponse({
    db,
    now,
    verifier,
    body: {
      call_id: randomUUID(),
      binary_index: 1,
      confidence_bps: 5100,
      revealed_at: "2026-06-12T09:30:00Z",
      reveal_tx_hash: `0x${"1".repeat(64)}`,
      reveal_log_index: 0,
    },
  });
  assert.deepEqual(missingReveal, {
    status: 404,
    body: { code: "not_found", message: "call not found" },
  });
  const missingRevealRes = new FakeOperatorFhenixStatusJsonResponse();
  sendOperatorFhenixStatusJsonResponse(missingRevealRes, missingReveal);
  assert.equal(missingRevealRes.statusCode, 404);
  assert.equal((missingRevealRes.body as typeof missingReveal.body).code, "not_found");

  await assert.rejects(
    () =>
      operatorFhenixInvalidRevealResponse({
        db,
        now,
        verifier,
        body: { call_id: "not-a-uuid" },
      }),
    (err) => err instanceof VerdictError && err.httpStatus === 400,
  );

  const missingInvalidReveal = await operatorFhenixInvalidRevealResponse({
    db,
    now,
    verifier,
    body: {
      call_id: randomUUID(),
      binary_index: 1,
      confidence_bps: 50_000,
      invalid_reason: "confidence",
      revealed_at: "2026-06-12T09:30:00Z",
      reveal_tx_hash: `0x${"2".repeat(64)}`,
      reveal_log_index: 1,
    },
  });
  assert.deepEqual(missingInvalidReveal, {
    status: 404,
    body: { code: "not_found", message: "call not found" },
  });
  const missingInvalidRevealRes = new FakeOperatorFhenixStatusJsonResponse();
  sendOperatorFhenixStatusJsonResponse(
    missingInvalidRevealRes,
    missingInvalidReveal,
  );
  assert.equal(missingInvalidRevealRes.statusCode, 404);
  assert.equal(
    (missingInvalidRevealRes.body as typeof missingInvalidReveal.body).code,
    "not_found",
  );

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("operator fhenix surface smoke ok\n");

function failIfCalledVerifier(): FhenixEventVerifier {
  const fail = async () => {
    throw new Error("verifier should not be called for missing calls");
  };
  return {
    verifySealedCallSubmitted: fail,
    verifyVerdictRevealed: fail,
    verifyVerdictRevealInvalid: fail,
  };
}
