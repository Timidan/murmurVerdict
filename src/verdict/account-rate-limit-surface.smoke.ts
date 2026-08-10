import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

import { ipKeyGenerator } from "express-rate-limit";

import {
  accountRateLimitKey,
  accountRouteLimiters,
  type AccountRateLimitRequest,
} from "./account-rate-limit-surface.js";

process.stdout.write("murmur account rate limit surface smoke\n");

function fakeRequest(
  headers: Record<string, string | undefined>,
  ip = "203.0.113.10",
): AccountRateLimitRequest {
  const lowerHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ip,
    header(name: string): string | undefined {
      return lowerHeaders.get(name.toLowerCase());
    },
  };
}

const bearerToken = "privy-token-for-rate-limit";
const expectedHash = createHash("sha256")
  .update(bearerToken)
  .digest("hex")
  .slice(0, 16);

assert.equal(
  accountRateLimitKey(fakeRequest({ authorization: `Bearer ${bearerToken}` })),
  `${ipKeyGenerator("203.0.113.10")}:${expectedHash}`,
);

assert.equal(
  accountRateLimitKey(fakeRequest({ Authorization: `bearer ${bearerToken}` })),
  `${ipKeyGenerator("203.0.113.10")}:${expectedHash}`,
);

assert.equal(
  accountRateLimitKey(fakeRequest({}, "2001:db8:85a3::8a2e:370:7334")),
  ipKeyGenerator("2001:db8:85a3::8a2e:370:7334"),
);

assert.equal(
  accountRateLimitKey(fakeRequest({ authorization: "Basic nope" })),
  ipKeyGenerator("203.0.113.10"),
);

const limiters = accountRouteLimiters();
assert.deepEqual(Object.keys(limiters).sort(), [
  "createAgentLimiter",
  "destAddrLimiter",
  "funnelEventLimiter",
  "listAgentsLimiter",
  "mintKeyLimiter",
  "rotateKeyLimiter",
  "sessionLimiter",
  "webhookSubscriptionAccountLimiter",
  "webhookSubscriptionIpLimiter",
]);
for (const limiter of Object.values(limiters)) {
  assert.equal(typeof limiter, "function");
}

process.stdout.write("account rate limit surface smoke ok\n");
