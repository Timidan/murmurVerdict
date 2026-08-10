import { strict as assert } from "node:assert";

import {
  boundedIntegerQuery,
  firstQueryValue,
} from "./route-query.js";

process.stdout.write("murmur route query smoke\n");

assert.equal(firstQueryValue("agent"), "agent");
assert.equal(firstQueryValue(["agent", "benchmark"]), "agent");
assert.equal(firstQueryValue([]), undefined);
assert.equal(firstQueryValue(42), undefined);

assert.equal(boundedIntegerQuery(undefined, { fallback: 20, max: 50 }), 20);
assert.equal(boundedIntegerQuery("7.9", { fallback: 20, max: 50 }), 7);
assert.equal(boundedIntegerQuery("0", { fallback: 20, max: 50 }), 1);
assert.equal(boundedIntegerQuery("999", { fallback: 20, max: 50 }), 50);
assert.equal(boundedIntegerQuery("bad", { fallback: 20, max: 50 }), 20);
assert.equal(boundedIntegerQuery(["12", "48"], { fallback: 20, max: 50 }), 12);
assert.equal(boundedIntegerQuery("-4", { fallback: 24, min: 6, max: 30 }), 6);

process.stdout.write("  ok route query bounds and first-value handling\n");
