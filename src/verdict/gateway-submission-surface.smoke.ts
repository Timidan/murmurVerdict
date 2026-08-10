import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuthIdentity } from "./auth/dispatcher.js";
import {
  gatewayFeedPacketSubmissionResponse,
  gatewayMurmurSealedCallSubmissionResponse,
  gatewaySealedCallSubmissionResponse,
  sendGatewaySubmissionJsonResponse,
  type GatewaySubmissionRequest,
  type GatewaySubmissionSurfaceDeps,
} from "./gateway-submission-surface.js";
import { openDb } from "./db.js";
import { VerdictError } from "./schema.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-gateway-submission-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur Gateway Submission Surface smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T09:30:00Z");
  const req = fakeRequest({
    "X-Murmur-Runtime-Key": "mrt_" + "a".repeat(64),
  });
  const authResult: AuthIdentity = {
    tier: "casual",
    auth_mode: "runtime_key",
    agent_id: "agent-1",
    account_id: "account-1",
  };

  await assert.rejects(
    () =>
      gatewaySealedCallSubmissionResponse({
        req,
        deps: { db, now },
        bodyJson: { client_order_id: "disabled" },
      }),
    (err) =>
      err instanceof VerdictError &&
      err.httpStatus === 503 &&
      err.code === "oracle_unavailable",
  );

  const unauthenticatedDeps: GatewaySubmissionSurfaceDeps = {
    db,
    now,
    fhenixGateway: fakeGateway(),
    dispatchAuth: async (_req, deps) => {
      assert.equal(deps.allowRuntimeKey, true);
      assert.equal(deps.db, db);
      assert.equal(deps.now, now);
      return null;
    },
  };
  await assert.rejects(
    () =>
      gatewayFeedPacketSubmissionResponse({
        req,
        deps: unauthenticatedDeps,
        feedId: "feed-1",
        bodyJson: { client_nonce: "unauthenticated" },
      }),
    (err) =>
      err instanceof VerdictError &&
      err.httpStatus === 401 &&
      err.code === "agent_not_authorized",
  );

  const submittedBodies: unknown[] = [];
  const submittedOwnedBodies: unknown[] = [];
  const submittedFeeds: Array<{ feedId: string; bodyJson: unknown }> = [];
  const gateway = fakeGateway({
    submitSealedCall: async ({ authResult: auth, bodyJson }) => {
      assert.equal(auth, authResult);
      submittedBodies.push(bodyJson);
      return {
        status: 202,
        body: {
          attempt_id: "attempt-call-1",
          status: "queued",
          tx_hash: null,
          call_id: null,
          next_attempt_at: "2026-06-12T09:31:00Z",
          idempotent_hit: false,
        },
      };
    },
    submitMurmurSealedCall: async ({ authResult: auth, bodyJson }) => {
      assert.equal(auth, authResult);
      submittedOwnedBodies.push(bodyJson);
      return {
        status: 202,
        body: {
          attempt_id: "attempt-owned-call-1",
          status: "queued",
          tx_hash: null,
          call_id: null,
          next_attempt_at: "2026-06-12T09:31:00Z",
          idempotent_hit: false,
        },
      };
    },
    submitFeedPacket: async ({ authResult: auth, feedId, bodyJson }) => {
      assert.equal(auth, authResult);
      submittedFeeds.push({ feedId, bodyJson });
      return {
        status: 202,
        body: {
          attempt_id: "attempt-feed-1",
          status: "queued",
          tx_hash: null,
          packet_id: null,
          sequence: 1,
          sla_status: null,
          next_attempt_at: "2026-06-12T09:31:00Z",
          idempotent_hit: false,
        },
      };
    },
  });
  const deps: GatewaySubmissionSurfaceDeps = {
    db,
    now,
    fhenixGateway: gateway,
    dispatchAuth: async (_req, authDeps) => {
      assert.equal(authDeps.allowRuntimeKey, true);
      assert.equal(authDeps.now?.().toISOString(), now().toISOString());
      return authResult;
    },
  };

  const call = await gatewaySealedCallSubmissionResponse({
    req,
    deps,
    bodyJson: { client_order_id: "call-1" },
  });
  assert.equal(call.status, 202);
  assert.equal(call.body.attempt_id, "attempt-call-1");
  assert.deepEqual(submittedBodies, [{ client_order_id: "call-1" }]);
  const callTarget = makeStatusJsonTarget();
  sendGatewaySubmissionJsonResponse(callTarget, call);
  assert.equal(callTarget.statusCode, 202);
  assert.equal(callTarget.body, call.body);

  const ownedCall = await gatewayMurmurSealedCallSubmissionResponse({
    req,
    deps,
    bodyJson: { client_order_id: "owned-call-1" },
  });
  assert.equal(ownedCall.status, 202);
  assert.equal(ownedCall.body.attempt_id, "attempt-owned-call-1");
  assert.deepEqual(submittedOwnedBodies, [
    { client_order_id: "owned-call-1" },
  ]);
  const ownedCallTarget = makeStatusJsonTarget();
  sendGatewaySubmissionJsonResponse(ownedCallTarget, ownedCall);
  assert.equal(ownedCallTarget.statusCode, 202);
  assert.equal(ownedCallTarget.body, ownedCall.body);

  const feed = await gatewayFeedPacketSubmissionResponse({
    req,
    deps,
    feedId: "feed-1",
    bodyJson: { client_nonce: "feed-1" },
  });
  assert.equal(feed.status, 202);
  assert.equal(feed.body.attempt_id, "attempt-feed-1");
  assert.deepEqual(submittedFeeds, [
    { feedId: "feed-1", bodyJson: { client_nonce: "feed-1" } },
  ]);
  const feedTarget = makeStatusJsonTarget();
  sendGatewaySubmissionJsonResponse(feedTarget, feed);
  assert.equal(feedTarget.statusCode, 202);
  assert.equal(feedTarget.body, feed.body);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("Gateway Submission Surface smoke ok\n");

function fakeRequest(headers: Record<string, string>): GatewaySubmissionRequest {
  return {
    header(name: string): string | undefined {
      return headers[name] ?? headers[name.toLowerCase()];
    },
  };
}

function fakeGateway(overrides: Partial<NonNullable<GatewaySubmissionSurfaceDeps["fhenixGateway"]>> = {}): NonNullable<GatewaySubmissionSurfaceDeps["fhenixGateway"]> {
  return {
    submitSealedCall: async () => ({
      status: 202,
      body: {
        attempt_id: "attempt-call-default",
        status: "queued",
        tx_hash: null,
        call_id: null,
        next_attempt_at: "2026-06-12T09:31:00Z",
        idempotent_hit: false,
      },
    }),
    submitMurmurSealedCall: async () => ({
      status: 202,
      body: {
        attempt_id: "attempt-owned-call-default",
        status: "queued",
        tx_hash: null,
        call_id: null,
        next_attempt_at: "2026-06-12T09:31:00Z",
        idempotent_hit: false,
      },
    }),
    submitFeedPacket: async () => ({
      status: 202,
      body: {
        attempt_id: "attempt-feed-default",
        status: "queued",
        tx_hash: null,
        packet_id: null,
        sequence: 1,
        sla_status: null,
        next_attempt_at: "2026-06-12T09:31:00Z",
        idempotent_hit: false,
      },
    }),
    ...overrides,
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
