import { strict as assert } from "node:assert";

import {
  conditionIdForMarketConfig,
  endDateMsForMarketConfig,
  parseMarketConfigJson,
} from "./market-adapter-config.js";

process.stdout.write("murmur Market Adapter Config smoke\n");

assert.deepEqual(
  parseMarketConfigJson(JSON.stringify({
    conditionId: `0x${"a".repeat(64)}`,
    outcomes: ["YES", "NO"],
  })),
  {
    conditionId: `0x${"a".repeat(64)}`,
    outcomes: ["YES", "NO"],
  },
);

assert.deepEqual(parseMarketConfigJson(""), {});
assert.deepEqual(parseMarketConfigJson(null), {});
assert.deepEqual(parseMarketConfigJson("{"), {});
assert.deepEqual(parseMarketConfigJson("[]"), {});
assert.deepEqual(parseMarketConfigJson("42"), {});

const conditionId = `0x${"b".repeat(64)}`;
const endDate = "2026-06-12T09:30:00Z";
const configJson = JSON.stringify({ conditionId, endDate });

assert.equal(conditionIdForMarketConfig(configJson), conditionId);
assert.equal(conditionIdForMarketConfig(JSON.stringify({ conditionId: "bad" })), null);
assert.equal(conditionIdForMarketConfig("{broken"), null);
assert.equal(endDateMsForMarketConfig(configJson), Date.parse(endDate));
assert.equal(endDateMsForMarketConfig(JSON.stringify({ endDate: "not-a-date" })), null);
assert.equal(endDateMsForMarketConfig("{broken"), null);

process.stdout.write("Market Adapter Config smoke ok\n");
