import assert from "node:assert/strict";

import {
  deriveFeedRevealAfter,
  feedSlaPolicy,
  publicFeedPolicy,
  safeFeedJsonObject,
} from "./feed-policy.js";
import type { FeedContractRow } from "./repos/feed-availability-repo.js";

const now = new Date("2026-01-02T00:00:00Z");

const fixedDelay = deriveFeedRevealAfter(
  feed({
    reveal_policy_json: JSON.stringify({
      kind: "fixed_delay",
      delay_seconds: 90,
    }),
  }),
  undefined,
  now,
);
assert.equal(fixedDelay, "2026-01-02T00:01:30Z");

const fallbackDelay = deriveFeedRevealAfter(
  feed({
    reveal_policy_json: JSON.stringify({ kind: "after_resolution" }),
    max_latency_seconds: 75.9,
    delivery_cadence_seconds: 60,
  }),
  undefined,
  now,
);
assert.equal(fallbackDelay, "2026-01-02T00:01:15Z");

const requestedReveal = deriveFeedRevealAfter(
  feed(),
  "2026-01-02T00:05:00.123Z",
  now,
);
assert.equal(requestedReveal, "2026-01-02T00:05:00Z");
assert.equal(deriveFeedRevealAfter(feed(), "not-a-timestamp", now), "not-a-timestamp");

assert.throws(
  () => deriveFeedRevealAfter(feed({ reveal_policy_json: "[]" }), undefined, now),
  /feed\.reveal_policy_json is malformed JSON/,
);

const refundDriven = feedSlaPolicy(feed({
  refund_rule_json: JSON.stringify({
    kind: "credit",
    missed_delivery_grace: 2.5,
  }),
  slash_rule_json: JSON.stringify({ kind: "stake" }),
  max_latency_seconds: null,
}));
assert.equal(refundDriven.grace_seconds, 150);
assert.equal(refundDriven.refund_action, "credit");
assert.equal(refundDriven.slash_action, "stake");
assert.deepEqual(refundDriven.refund_rule, {
  kind: "credit",
  missed_delivery_grace: 2.5,
});

const maxLatencyOverride = feedSlaPolicy(feed({
  refund_rule_json: JSON.stringify({
    kind: "prorated",
    missed_delivery_grace: 30,
  }),
  slash_rule_json: JSON.stringify({ kind: "reputation" }),
  max_latency_seconds: 75.9,
}));
assert.equal(maxLatencyOverride.grace_seconds, 75);
assert.equal(maxLatencyOverride.refund_action, "prorated");
assert.equal(maxLatencyOverride.slash_action, "reputation");

const malformed = feedSlaPolicy(feed({
  refund_rule_json: "{not-json",
  slash_rule_json: JSON.stringify(["stake"]),
  max_latency_seconds: null,
}));
assert.equal(malformed.grace_seconds, 0);
assert.equal(malformed.refund_action, "none");
assert.equal(malformed.slash_action, "none");
assert.deepEqual(malformed.refund_rule, {});
assert.deepEqual(malformed.slash_rule, {});

assert.deepEqual(publicFeedPolicy(feed({
  reveal_policy_json: JSON.stringify({ kind: "manual" }),
  refund_rule_json: JSON.stringify({ kind: "none" }),
  slash_rule_json: JSON.stringify({ kind: "none" }),
})), {
  reveal_policy: { kind: "manual" },
  refund_rule: { kind: "none" },
  slash_rule: { kind: "none" },
});

assert.deepEqual(safeFeedJsonObject(JSON.stringify({ ok: true })), { ok: true });
assert.deepEqual(safeFeedJsonObject(JSON.stringify(["not", "object"])), {});
assert.deepEqual(safeFeedJsonObject("{broken"), {});

console.log("feed-policy smoke ok");

function feed(overrides: Partial<FeedContractRow> = {}): FeedContractRow {
  return {
    feed_id: "feed-policy-smoke",
    agent_id: "11111111-1111-4111-8111-111111111111",
    name: "Feed Policy Smoke",
    description: null,
    status: "listed",
    venue: "native-price",
    resolution_classes_json: JSON.stringify(["price_direction"]),
    edge_classes_json: JSON.stringify(["latency"]),
    covered_market_ids_json: JSON.stringify([]),
    delivery_cadence_seconds: 60,
    trigger_rules_json: JSON.stringify([]),
    max_latency_seconds: null,
    subscriber_capacity: 10,
    commercial_template: "per_alert",
    reveal_policy_json: JSON.stringify({ kind: "after_resolution" }),
    refund_rule_json: JSON.stringify({ kind: "none" }),
    slash_rule_json: JSON.stringify({ kind: "none" }),
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}
