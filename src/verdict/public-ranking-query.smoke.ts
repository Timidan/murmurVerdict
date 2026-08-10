import { strict as assert } from "node:assert";

import {
  publicLeaderboardCsvQuery,
  publicLeaderboardQuery,
} from "./public-ranking-query.js";

process.stdout.write("murmur public ranking query smoke\n");

assert.deepEqual(publicLeaderboardQuery(undefined), { limit: 200 });
assert.deepEqual(publicLeaderboardQuery({ tier: "main", limit: "10" }), {
  tier: "main",
  limit: 10,
});
assert.deepEqual(publicLeaderboardQuery({ tier: "provisional", limit: "999" }), {
  tier: "provisional",
  limit: 500,
});
assert.deepEqual(publicLeaderboardQuery({ tier: "unknown", limit: "bad" }), {
  limit: 200,
});
assert.deepEqual(publicLeaderboardQuery({ tier: ["main", "provisional"] }), {
  tier: "main",
  limit: 200,
});
assert.deepEqual(publicLeaderboardCsvQuery({ limit: "0" }), { limit: 1 });
assert.deepEqual(publicLeaderboardCsvQuery({ limit: "999" }), { limit: 500 });

process.stdout.write("  ok public ranking query owns tier and limit policy\n");
