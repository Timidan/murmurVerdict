import assert from "node:assert/strict";

import { UsageEventSchema } from "./schema.js";
import {
  makeUsageEvent,
  parseUsageEventAttributes,
  usageEventAttributesJson,
} from "./usage-event.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const now = () => new Date("2026-01-02T03:04:05.678Z");
const usageEventIds: string[] = [];
const newUsageEventId = () => {
  const id = "22222222-2222-4222-8222-222222222222";
  usageEventIds.push(id);
  return id;
};

const defaulted = makeUsageEvent({
  agent_id: agentId,
  kind: "submission_accepted",
  occurredAt: now(),
});
assert.match(
  defaulted.event_id,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
assert.equal(defaulted.agent_id, agentId);
assert.equal(defaulted.kind, "submission_accepted");
assert.equal(defaulted.ts, "2026-01-02T03:04:05Z");
assert.deepEqual(defaulted.attributes, {});
UsageEventSchema.parse(defaulted);

const accountScoped = makeUsageEvent({
  agent_id: null,
  kind: "landing.viewed",
  attributes: { account_id: "acct_123" },
  newUsageEventId,
  occurredAt: now(),
});
assert.equal(accountScoped.event_id, "22222222-2222-4222-8222-222222222222");
assert.equal(accountScoped.agent_id, null);
assert.deepEqual(accountScoped.attributes, { account_id: "acct_123" });
UsageEventSchema.parse(accountScoped);
assert.deepEqual(usageEventIds, ["22222222-2222-4222-8222-222222222222"]);

const explicitOccurrence = makeUsageEvent({
  agent_id: null,
  kind: "destination_address_updated",
  occurredAt: new Date("2026-01-02T03:04:06.789Z"),
});
assert.equal(explicitOccurrence.ts, "2026-01-02T03:04:06Z");
UsageEventSchema.parse(explicitOccurrence);

assert.deepEqual(
  parseUsageEventAttributes(usageEventAttributesJson({
    account_id: "acct_123",
    nested: { ok: true },
  })),
  {
    account_id: "acct_123",
    nested: { ok: true },
  },
);
assert.deepEqual(parseUsageEventAttributes("{broken"), {});
assert.deepEqual(parseUsageEventAttributes("[]"), {});

console.log("usage-event smoke ok");
