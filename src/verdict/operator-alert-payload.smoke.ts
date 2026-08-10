import assert from "node:assert/strict";

import {
  decodeOperatorAlertPayload,
  encodeOperatorAlertPayload,
  feedSlaIncidentAlertPayload,
} from "./operator-alert-payload.js";

const encoded = encodeOperatorAlertPayload({
  source: "smoke",
  attempt_count: 2,
});
assert.deepEqual(decodeOperatorAlertPayload(encoded), {
  source: "smoke",
  attempt_count: 2,
});
assert.equal(decodeOperatorAlertPayload("{broken"), null);

assert.deepEqual(feedSlaIncidentAlertPayload({
  incident_id: "incident-1",
  feed_id: "feed-1",
  agent_id: "agent-1",
  incident_kind: "missed_packet",
  expected_sequence: 7,
  expected_delivery_deadline_at: "2026-06-12T09:15:00Z",
  detected_at: "2026-06-12T09:30:00Z",
  grace_seconds: 60,
  refund_action: "credit",
  slash_action: "reputation",
  details_json: JSON.stringify({ generated_by: "smoke" }),
}), {
  incident_id: "incident-1",
  feed_id: "feed-1",
  agent_id: "agent-1",
  incident_kind: "missed_packet",
  expected_sequence: 7,
  expected_delivery_deadline_at: "2026-06-12T09:15:00Z",
  detected_at: "2026-06-12T09:30:00Z",
  grace_seconds: 60,
  refund_action: "credit",
  slash_action: "reputation",
  details: { generated_by: "smoke" },
});

assert.deepEqual(feedSlaIncidentAlertPayload({
  incident_id: "incident-2",
  feed_id: "feed-1",
  agent_id: "agent-1",
  incident_kind: "missed_packet",
  expected_sequence: 8,
  expected_delivery_deadline_at: "2026-06-12T09:16:00Z",
  detected_at: "2026-06-12T09:30:00Z",
  grace_seconds: 60,
  refund_action: "none",
  slash_action: "none",
  details_json: "{broken",
}), {
  incident_id: "incident-2",
  feed_id: "feed-1",
  agent_id: "agent-1",
  incident_kind: "missed_packet",
  expected_sequence: 8,
  expected_delivery_deadline_at: "2026-06-12T09:16:00Z",
  detected_at: "2026-06-12T09:30:00Z",
  grace_seconds: 60,
  refund_action: "none",
  slash_action: "none",
  details: null,
});

process.stdout.write("operator alert payload smoke ok\n");
