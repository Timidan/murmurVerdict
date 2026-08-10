import { strict as assert } from "node:assert";

import {
  adminRefTopSendersQuery,
  normalizeRefLimit,
  publicRefTopSendersQuery,
  refAgentDiscoverersQuery,
} from "./ref-attribution-query.js";

process.stdout.write("murmur ref attribution query smoke\n");

assert.equal(normalizeRefLimit("not-a-number", { fallback: 20, max: 50 }), 20);
assert.equal(normalizeRefLimit("999", { fallback: 20, max: 50 }), 50);
assert.equal(normalizeRefLimit("-4", { fallback: 20, max: 50 }), 1);

assert.deepEqual(publicRefTopSendersQuery(undefined), { limit: 20 });
assert.deepEqual(publicRefTopSendersQuery({ limit: "999" }), { limit: 50 });
assert.deepEqual(adminRefTopSendersQuery(undefined), { limit: 50 });
assert.deepEqual(adminRefTopSendersQuery({ limit: "999" }), { limit: 200 });
assert.deepEqual(refAgentDiscoverersQuery(undefined), { limit: 5 });
assert.deepEqual(refAgentDiscoverersQuery({ limit: "21" }), { limit: 20 });

process.stdout.write("  ok ref attribution query owns limit policy\n");
