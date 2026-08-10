import { strict as assert } from "node:assert";

import {
  DEFAULT_FHENIX_REVEAL_GRACE_SEC,
  normalizeFhenixRevealGraceSec,
  parseFhenixLifecycleQuery,
} from "./operator-fhenix-lifecycle-query.js";
import { VerdictError } from "./schema.js";

process.stdout.write("murmur operator fhenix lifecycle query smoke\n");

assert.deepEqual(
  parseFhenixLifecycleQuery({
    status: "revealed",
    limit: "999",
    grace_sec: "7200.9",
  }),
  {
    status: "revealed",
    limit: 200,
    graceSeconds: 7200,
  },
);

assert.deepEqual(
  parseFhenixLifecycleQuery({
    status: ["invalid", "verified"],
    limit: "0",
    grace_sec: ["-5", "7200"],
  }),
  {
    status: "invalid",
    limit: 1,
    graceSeconds: 0,
  },
);

assert.deepEqual(
  parseFhenixLifecycleQuery(
    { limit: "bad" },
    { fhenixRevealGraceSec: 12 },
  ),
  {
    limit: 50,
    graceSeconds: 12,
  },
);

assert.equal(
  normalizeFhenixRevealGraceSec(undefined),
  DEFAULT_FHENIX_REVEAL_GRACE_SEC,
);
assert.equal(normalizeFhenixRevealGraceSec("forever"), DEFAULT_FHENIX_REVEAL_GRACE_SEC);
assert.equal(normalizeFhenixRevealGraceSec(String(31 * 24 * 60 * 60)), 30 * 24 * 60 * 60);

assert.throws(
  () => parseFhenixLifecycleQuery({ status: "resolved" }),
  (err) => err instanceof VerdictError && err.httpStatus === 400,
);

process.stdout.write("  ok operator fhenix lifecycle query owns lifecycle filter policy\n");
