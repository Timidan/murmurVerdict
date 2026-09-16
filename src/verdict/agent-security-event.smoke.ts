import assert from "node:assert/strict";

import {
  agentSecurityEventPayloadJson,
  makeAgentSecurityEvent,
  parseAgentSecurityEventPayload,
} from "./agent-security-event.js";
import { AgentSecurityEventSchema } from "./schema.js";

const now = () => new Date("2026-01-02T03:04:05.678Z");
const eventIds: string[] = [];
const newEventId = () => {
  const id = "00000000-0000-4000-8000-000000000101";
  eventIds.push(id);
  return id;
};
const unexpectedEventId = () => {
  throw new Error("agent security event id adapter should not be called");
};

const defaulted = makeAgentSecurityEvent({
  kind: "admin_claim",
  actor: "admin_token",
  createdAt: now(),
});
assert.match(
  defaulted.event_id,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
assert.equal(defaulted.agent_id, null);
assert.equal(defaulted.account_id, null);
assert.equal(defaulted.kind, "admin_claim");
assert.equal(defaulted.actor, "admin_token");
assert.equal(defaulted.created_at, "2026-01-02T03:04:05Z");
assert.deepEqual(defaulted.payload, {});
AgentSecurityEventSchema.parse(defaulted);

const generated = makeAgentSecurityEvent({
  kind: "admin_claim",
  actor: "admin_token",
  newEventId,
  createdAt: now(),
});
assert.equal(generated.event_id, "00000000-0000-4000-8000-000000000101");
assert.deepEqual(eventIds, ["00000000-0000-4000-8000-000000000101"]);
AgentSecurityEventSchema.parse(generated);

const scoped = makeAgentSecurityEvent({
  event_id: "11111111-1111-4111-8111-111111111111",
  newEventId: unexpectedEventId,
  agent_id: "22222222-2222-4222-8222-222222222222",
  account_id: "33333333-3333-4333-8333-333333333333",
  kind: "admin_claim",
  actor: "cli:admin-claim",
  payload: { slug: "maya", created_agent: true },
  createdAt: new Date("2026-01-02T03:04:06.789Z"),
});
assert.equal(scoped.event_id, "11111111-1111-4111-8111-111111111111");
assert.equal(scoped.agent_id, "22222222-2222-4222-8222-222222222222");
assert.equal(scoped.account_id, "33333333-3333-4333-8333-333333333333");
assert.deepEqual(scoped.payload, { slug: "maya", created_agent: true });
assert.equal(scoped.created_at, "2026-01-02T03:04:06Z");
AgentSecurityEventSchema.parse(scoped);

assert.equal(
  agentSecurityEventPayloadJson(scoped.payload),
  JSON.stringify({ slug: "maya", created_agent: true }),
);
assert.deepEqual(
  parseAgentSecurityEventPayload(JSON.stringify({ slug: "bob", deleted_rows: 1 })),
  { slug: "bob", deleted_rows: 1 },
);
assert.deepEqual(parseAgentSecurityEventPayload("{broken"), {});
assert.deepEqual(parseAgentSecurityEventPayload("[]"), {});

console.log("agent-security-event smoke ok");
