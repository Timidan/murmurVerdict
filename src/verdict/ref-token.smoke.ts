import { strict as assert } from "node:assert";

import {
  REF_MAX_LENGTH,
  sanitizeRef,
} from "./ref-token.js";

process.stdout.write("murmur ref token smoke\n");

assert.equal(REF_MAX_LENGTH, 32);
assert.equal(sanitizeRef(" @alice!!! "), "alice");
assert.equal(sanitizeRef("!!!"), null);
assert.equal(sanitizeRef(["alice"]), null);
assert.equal(sanitizeRef("a".repeat(40)), "a".repeat(REF_MAX_LENGTH));
assert.equal(sanitizeRef("team_1.ref-2"), "team_1.ref-2");

process.stdout.write("ref token smoke ok\n");
