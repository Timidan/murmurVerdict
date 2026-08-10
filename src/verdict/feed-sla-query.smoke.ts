import { strict as assert } from "node:assert";

import { parseFeedSlaQuery } from "./feed-sla-query.js";
import { VerdictError } from "./schema.js";

process.stdout.write("murmur feed SLA query smoke\n");

assert.deepEqual(
  parseFeedSlaQuery({
    feed_id: "feed-one",
    status: "open",
    limit: "999",
  }),
  {
    feed_id: "feed-one",
    status: "open",
    limit: 500,
  },
);
assert.deepEqual(
  parseFeedSlaQuery({
    feed_id: ["feed-two", "ignored"],
    status: ["fulfilled_late", "open"],
    limit: "0",
  }),
  {
    feed_id: "feed-two",
    status: "fulfilled_late",
    limit: 1,
  },
);
assert.deepEqual(parseFeedSlaQuery({ limit: "bad" }), { limit: 100 });
assert.throws(
  () => parseFeedSlaQuery({ status: "bad" }),
  (err) => err instanceof VerdictError && err.httpStatus === 400,
);

process.stdout.write("  ok feed SLA query owns incident filter policy\n");
