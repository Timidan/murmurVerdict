import assert from "node:assert/strict";

import {
  RuntimeKeyGatewayPolicySchema,
  RuntimeKeyPolicySchema,
  parseRuntimeKeyGatewayPolicyJson,
} from "./runtime-key-policy.js";

const strictPolicy = RuntimeKeyPolicySchema.parse({
  allowed_market_ids: ["eth.1h", `0x${"a".repeat(64)}`],
  max_calls_per_hour: 12,
  max_calls_per_day: 100,
  feed_packets: true,
  notes: "market-maker lane",
});
assert.equal(strictPolicy.max_calls_per_hour, 12);

assert.throws(() =>
  RuntimeKeyPolicySchema.parse({
    allowed_market_ids: ["ETH/USDC"],
  }),
);
assert.throws(() =>
  RuntimeKeyPolicySchema.parse({
    unknown_extension: true,
  }),
);
assert.throws(() =>
  RuntimeKeyPolicySchema.parse({
    notes: "x".repeat(241),
  }),
);

const gatewayPolicy = parseRuntimeKeyGatewayPolicyJson(JSON.stringify({
  allowed_market_ids: ["eth.1h"],
  notes: "x".repeat(260),
  legacy_extension: true,
}));
assert.equal(gatewayPolicy.allowed_market_ids?.[0], "eth.1h");
assert.equal((gatewayPolicy as { legacy_extension?: boolean }).legacy_extension, true);

assert.throws(() =>
  RuntimeKeyGatewayPolicySchema.parse({
    allowed_market_ids: ["ETH/USDC"],
  }),
);
assert.throws(() => parseRuntimeKeyGatewayPolicyJson("{not-json"));

console.log("runtime-key-policy smoke ok");
