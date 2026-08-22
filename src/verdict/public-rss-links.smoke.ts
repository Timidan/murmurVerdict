import { strict as assert } from "node:assert";

import {
  publicRssDashboardLinks,
  publicRssDashboardOrigin,
} from "./public-rss-links.js";

process.stdout.write("murmur public rss links smoke\n");

// Nothing configured and no headers (a feed reader is not a browser: it sends
// neither Origin nor Referer) yields RELATIVE links. This used to return
// "https://murmur.verdict" — a TLD that does not exist — so every item in
// every feed pointed nowhere. An empty origin is the honest answer.
assert.equal(publicRssDashboardOrigin(), "");

// The configured dashboard origin OUTRANKS request headers: it is the
// deployment's own statement, and it is the only thing a feed reader gets.
assert.equal(
  publicRssDashboardOrigin({
    configuredOrigin: "https://murmur.example/",
    originHeader: "https://attacker.example",
  }),
  "https://murmur.example",
);
assert.equal(
  publicRssDashboardOrigin({
    originHeader: "https://dashboard.example/",
    refererHeader: "https://referer.example/",
  }),
  "https://dashboard.example",
);
assert.equal(
  publicRssDashboardOrigin({
    refererHeader: "https://referer.example/",
  }),
  "https://referer.example",
);

const links = publicRssDashboardLinks({
  originHeader: "https://dashboard.example/",
});
assert.equal(
  links.agent("agent/slash"),
  "https://dashboard.example/#/agents/agent%2Fslash",
);
assert.equal(
  links.call("call/slash"),
  "https://dashboard.example/#/calls/call%2Fslash",
);

process.stdout.write("public rss links smoke ok\n");
