import assert from "node:assert/strict";

import {
  missedPacketIncidentDetailsJson,
  publicFeedSlaIncidentDetails,
  safeFeedSlaIncidentDetails,
} from "./feed-sla-incident-detail.js";

const detailsJson = missedPacketIncidentDetailsJson({
  cadence_seconds: 300,
  grace_seconds: 60,
  refund_rule: { kind: "credit" },
  slash_rule: { kind: "reputation" },
});
const expected = {
  cadence_seconds: 300,
  grace_seconds: 60,
  refund_rule: { kind: "credit" },
  slash_rule: { kind: "reputation" },
  generated_by: "feed_sla_tick_v1",
};
assert.deepEqual(publicFeedSlaIncidentDetails({ details_json: detailsJson }), expected);
assert.deepEqual(safeFeedSlaIncidentDetails({ details_json: detailsJson }), expected);
assert.throws(
  () => publicFeedSlaIncidentDetails({ details_json: "{broken" }),
  /feed_sla_incident\.details_json is malformed JSON/,
);
assert.equal(safeFeedSlaIncidentDetails({ details_json: "{broken" }), null);

process.stdout.write("feed SLA incident detail smoke ok\n");
