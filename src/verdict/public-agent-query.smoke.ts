import { strict as assert } from "node:assert";

import {
  PUBLIC_AGENT_KINDS,
  publicAgentCallsQuery,
  publicAgentListQuery,
  publicAgentRssQuery,
} from "./public-agent-query.js";

process.stdout.write("murmur Public Agent Query smoke\n");

assert.deepEqual(PUBLIC_AGENT_KINDS, [
  "agent",
  "attested",
  "benchmark",
  "internal_test",
]);
assert.deepEqual(publicAgentListQuery({ kind: "agent", limit: "7.9" }), {
  kind: "agent",
  limit: 7,
});
assert.deepEqual(publicAgentListQuery({ kind: ["benchmark"], limit: "999" }), {
  kind: "benchmark",
  limit: 200,
});
assert.deepEqual(publicAgentListQuery({ kind: "bad-kind" }), {
  status: 400,
  body: {
    code: "invalid_kind",
    message: "kind must be one of agent|attested|benchmark|internal_test",
  },
});
assert.deepEqual(publicAgentCallsQuery({}), { limit: 50 });
assert.deepEqual(publicAgentCallsQuery({ limit: "9999" }), { limit: 500 });
assert.deepEqual(publicAgentRssQuery({}), { limit: 20 });
assert.deepEqual(publicAgentRssQuery({ limit: "9999" }), { limit: 50 });

process.stdout.write("Public Agent Query smoke ok\n");
