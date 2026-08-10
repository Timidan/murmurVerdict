import { strict as assert } from "node:assert";

import { parseOperatorAlertQuery } from "./operator-alert-query.js";
import { VerdictError } from "./schema.js";

process.stdout.write("murmur operator alert query smoke\n");

assert.deepEqual(
  parseOperatorAlertQuery({
    status: "open",
    source: "gateway",
    delivery_status: "failed",
    limit: "999",
  }),
  {
    status: "open",
    source: "gateway",
    delivery_status: "failed",
    limit: 500,
  },
);
assert.deepEqual(
  parseOperatorAlertQuery({
    status: ["resolved", "open"],
    delivery_status: ["pending", "failed"],
    limit: "0",
  }),
  {
    status: "resolved",
    delivery_status: "pending",
    limit: 1,
  },
);
assert.deepEqual(parseOperatorAlertQuery({ limit: "bad" }), { limit: 100 });
assert.throws(
  () => parseOperatorAlertQuery({ status: "bad" }),
  (err) => err instanceof VerdictError && err.httpStatus === 400,
);
assert.throws(
  () => parseOperatorAlertQuery({ delivery_status: "bad" }),
  (err) => err instanceof VerdictError && err.httpStatus === 400,
);

process.stdout.write("  ok operator alert query owns alert filter policy\n");
