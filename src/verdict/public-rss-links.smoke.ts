import { strict as assert } from "node:assert";

import {
  DEFAULT_RSS_DASHBOARD_ORIGIN,
  publicRssDashboardLinks,
  publicRssDashboardOrigin,
} from "./public-rss-links.js";

process.stdout.write("murmur public rss links smoke\n");

assert.equal(publicRssDashboardOrigin(), DEFAULT_RSS_DASHBOARD_ORIGIN);
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
