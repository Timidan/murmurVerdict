import { strict as assert } from "node:assert";

import {
  marketLeaderboardReadQuery,
  marketRegistryListQuery,
} from "./market-read-query.js";
import { VerdictError } from "./schema.js";

process.stdout.write("murmur Market Read Query smoke\n");

assert.deepEqual(marketRegistryListQuery(undefined), {
  assetId: null,
  status: "listed",
});
assert.deepEqual(marketRegistryListQuery({}), {
  assetId: null,
  status: "listed",
});
assert.deepEqual(marketRegistryListQuery({ status: "frozen" }), {
  assetId: null,
  status: "frozen",
});
assert.deepEqual(marketRegistryListQuery({ status: ["draft", "listed"] }), {
  assetId: null,
  status: "draft",
});
assert.throws(
  () => marketRegistryListQuery({ status: "unknown" }),
  (err) =>
    err instanceof VerdictError &&
    err.httpStatus === 400 &&
    err.code === "schema_invalid" &&
    err.message === "status must be one of draft|listed|frozen|retired",
);
assert.deepEqual(marketRegistryListQuery({ asset_id: "" }), {
  assetId: null,
  status: "listed",
});
assert.deepEqual(marketRegistryListQuery({ asset_id: "base:ETH:USD" }), {
  assetId: "base:ETH:USD",
  status: "listed",
});
assert.deepEqual(marketRegistryListQuery({ asset_id: ["base:BTC:USD"] }), {
  assetId: "base:BTC:USD",
  status: "listed",
});

assert.deepEqual(marketLeaderboardReadQuery(undefined), { limit: 20 });
assert.deepEqual(marketLeaderboardReadQuery({}), { limit: 20 });
assert.deepEqual(marketLeaderboardReadQuery({ limit: "9.8", tier: "main" }), {
  limit: 9,
  tier: "main",
});
assert.deepEqual(
  marketLeaderboardReadQuery({ limit: "999", tier: "provisional" }),
  {
    limit: 100,
    tier: "provisional",
  },
);
assert.deepEqual(marketLeaderboardReadQuery({ limit: "bad", tier: "weird" }), {
  limit: 20,
});

process.stdout.write("Market Read Query smoke ok\n");
