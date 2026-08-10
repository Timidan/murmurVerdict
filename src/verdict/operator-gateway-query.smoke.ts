import { strict as assert } from "node:assert";

import { parseGatewayOperatorQuery } from "./operator-gateway-query.js";
import { VerdictError } from "./schema.js";

process.stdout.write("murmur operator gateway query smoke\n");

assert.deepEqual(
  parseGatewayOperatorQuery({
    status: "queued",
    limit: "999",
    stuck_after_sec: "20",
  }),
  {
    status: "queued",
    limit: 200,
    stuckAfterMs: 60_000,
  },
);
assert.deepEqual(
  parseGatewayOperatorQuery({
    status: ["confirmed", "queued"],
    limit: "0",
    stuck_after_sec: "121",
  }),
  {
    status: "confirmed",
    limit: 1,
    stuckAfterMs: 121_000,
  },
);
assert.deepEqual(parseGatewayOperatorQuery({ limit: "bad" }), { limit: 50 });
assert.throws(
  () => parseGatewayOperatorQuery({ status: "bad" }),
  (err) => err instanceof VerdictError && err.httpStatus === 400,
);
assert.throws(
  () => parseGatewayOperatorQuery({ stuck_after_sec: "bad" }),
  (err) => err instanceof VerdictError && err.httpStatus === 400,
);

process.stdout.write("  ok operator gateway query owns attempt filter policy\n");
