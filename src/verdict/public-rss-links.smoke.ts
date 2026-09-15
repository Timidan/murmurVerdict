import { strict as assert } from "node:assert";

import { publicRssDashboardLinks } from "./public-rss-links.js";

process.stdout.write("murmur public rss links smoke\n");

// RSS 2.0 links must be absolute; the caller supplies the origin.
const links = publicRssDashboardLinks("https://murmur.example/");
assert.equal(links.agent("agent/slash"), "https://murmur.example/#/agents/agent%2Fslash");
assert.equal(links.call("call id"), "https://murmur.example/#/calls/call%20id");
for (const url of [links.agent("a"), links.call("c")]) {
  assert.match(url, /^https:\/\//, "RSS links must be absolute");
}

// Trailing slashes collapse rather than doubling.
assert.equal(
  publicRssDashboardLinks("https://murmur.example///").agent("a"),
  "https://murmur.example/#/agents/a",
);

process.stdout.write("public rss links smoke ok\n");
