import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAgentSecurityEventPayload } from "./agent-security-event.js";
import { openDb } from "./db.js";
import { agentSecurityEventsRepo } from "./repos/agent-security-events-repo.js";
import {
  deleteRefSender,
  deleteRefSenderResponse,
  recordRefClick,
  recordRefClickResponse,
  refAgentDiscoverersResponse,
  refAgentDiscoverersSnapshot,
  refTopSendersResponse,
  refTopSendersSnapshot,
  sendDeleteRefSenderResponse,
  sendRecordRefClickResponse,
  sendRefAttributionJsonResponse,
} from "./ref-attribution.js";
import {
  normalizeRefLimit,
} from "./ref-attribution-query.js";
import {
  sanitizeRef,
} from "./ref-token.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-ref-attribution-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur ref attribution smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T09:30:00Z");
  const servedAt = now();
  const securityEventIds: string[] = [];
  const newAgentSecurityEventId = () => {
    const id = `00000000-0000-4000-8000-${String(securityEventIds.length + 1).padStart(12, "0")}`;
    securityEventIds.push(id);
    return id;
  };
  const unexpectedAgentSecurityEventId = () => {
    throw new Error("agent security event id adapter should not be called");
  };

  assert.equal(sanitizeRef(" @alice!!! "), "alice");
  assert.equal(sanitizeRef("!!!"), null);
  assert.equal(normalizeRefLimit("not-a-number", { fallback: 20, max: 50 }), 20);
  assert.equal(normalizeRefLimit("999", { fallback: 20, max: 50 }), 50);
  assert.equal(normalizeRefLimit("-4", { fallback: 20, max: 50 }), 1);

  const invalid = recordRefClick({
    db,
    ref: "!!!",
    agentSlug: "agent-one",
    now,
  });
  assert.equal("code" in invalid ? invalid.code : null, "invalid_ref");
  assert.deepEqual(
    recordRefClickResponse({
      db,
      ref: "!!!",
      agentSlug: "agent-one",
      now,
    }),
    {
      status: 400,
      body: {
        code: "invalid_ref",
        message: "ref must be 1-32 chars [a-zA-Z0-9_.-]",
      },
    },
  );
  const invalidClickTarget = makeStatusTarget();
  sendRecordRefClickResponse(invalidClickTarget, recordRefClickResponse({
    db,
    ref: "!!!",
    agentSlug: "agent-one",
    now,
  }));
  assert.equal(invalidClickTarget.statusCode, 400);
  assert.equal(invalidClickTarget.body?.code, "invalid_ref");

  const clicked = recordRefClick({
    db,
    ref: " @alice!!! ",
    agentSlug: "agent-one".repeat(10),
    now,
  });
  assert.equal("code" in clicked, false);
  assert.equal("ref" in clicked ? clicked.ref : null, "alice");
  assert.equal("agent_slug" in clicked ? clicked.agent_slug?.length : null, 64);
  assert.deepEqual(
    recordRefClickResponse({
      db,
      ref: "carol",
      agentSlug: "agent-two",
      now,
    }),
    { status: 204 },
  );
  const clickTarget = makeStatusTarget();
  sendRecordRefClickResponse(clickTarget, recordRefClickResponse({
    db,
    ref: "carol",
    agentSlug: "agent-two",
    now,
  }));
  assert.equal(clickTarget.statusCode, 204);
  assert.equal(clickTarget.ended, true);

  recordRefClick({ db, ref: "bob", agentSlug: "agent-one", now });
  recordRefClick({ db, ref: "bob", agentSlug: "agent-one", now });
  recordRefClick({ db, ref: "bob", agentSlug: "agent-one", now });

  const top = refTopSendersSnapshot(db, {
    servedAt,
    query: { limit: 1 },
  });
  assert.equal(top.served_at, "2026-06-12T09:30:00Z");
  assert.equal(top.senders.length, 1);
  assert.equal(top.senders[0]?.ref, "bob");
  const topResponse = refTopSendersResponse(db, {
    servedAt,
    query: { limit: 1 },
  });
  assert.equal(topResponse.schema_version, 1);
  assert.equal(topResponse.senders[0]?.ref, "bob");
  const topTarget = {
    body: undefined as unknown,
    json(body: unknown) {
      this.body = body;
    },
  };
  sendRefAttributionJsonResponse(topTarget, topResponse);
  assert.equal(topTarget.body, topResponse);

  const discoverers = refAgentDiscoverersSnapshot(db, {
    slug: "agent-one",
    query: { limit: 10 },
  });
  assert.equal(discoverers.slug, "agent-one");
  assert.equal(discoverers.discoverers[0]?.ref, "bob");
  const discoverersResponse = refAgentDiscoverersResponse(db, {
    slug: "agent-one",
    query: { limit: 10 },
  });
  assert.equal(discoverersResponse.schema_version, 1);
  assert.equal(discoverersResponse.discoverers[0]?.ref, "bob");

  const deleted = deleteRefSender({
    db,
    ref: "bob",
    now,
    actor: "test-admin",
    newAgentSecurityEventId,
  });
  assert.equal("code" in deleted, false);
  assert.equal("deleted_rows" in deleted ? deleted.deleted_rows : 0, 1);
  const audit = agentSecurityEventsRepo.listByKind(db, "admin_ref_delete", 1)[0];
  assert.equal(audit?.event_id, "00000000-0000-4000-8000-000000000001");
  assert.equal(audit?.actor, "test-admin");
  assert.equal(audit?.created_at, "2026-06-12T09:30:00Z");
  assert.deepEqual(parseAgentSecurityEventPayload(audit?.payload_json ?? "{}"), {
    ref: "bob",
    deleted_rows: 1,
  });
  assert.deepEqual(securityEventIds, ["00000000-0000-4000-8000-000000000001"]);
  assert.deepEqual(
    deleteRefSenderResponse({
      db,
      ref: "!!!",
      now,
      actor: "test-admin",
      newAgentSecurityEventId: unexpectedAgentSecurityEventId,
    }),
    {
      status: 400,
      body: {
        code: "invalid_ref",
        message: "ref must be 1-32 chars [a-zA-Z0-9_.-]",
      },
    },
  );
  const invalidDeleteTarget = makeStatusTarget();
  sendDeleteRefSenderResponse(invalidDeleteTarget, deleteRefSenderResponse({
    db,
    ref: "!!!",
    now,
    actor: "test-admin",
  }));
  assert.equal(invalidDeleteTarget.statusCode, 400);
  assert.equal(invalidDeleteTarget.body?.code, "invalid_ref");
  assert.deepEqual(
    deleteRefSenderResponse({
      db,
      ref: "alice",
      now,
      actor: "test-admin",
    }),
    {
      status: 200,
      body: { deleted: 1 },
    },
  );
  const deleteTarget = makeStatusTarget();
  sendDeleteRefSenderResponse(deleteTarget, deleteRefSenderResponse({
    db,
    ref: "carol",
    now,
    actor: "test-admin",
  }));
  assert.equal(deleteTarget.statusCode, 200);
  assert.equal(deleteTarget.body?.deleted, 1);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("ref attribution smoke ok\n");

function makeStatusTarget() {
  return {
    statusCode: 0,
    body: undefined as undefined | { code?: string; deleted?: number },
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return {
        end: () => {
          this.ended = true;
        },
        json: (body: { code?: string; deleted?: number }) => {
          this.body = body;
        },
      };
    },
  };
}
