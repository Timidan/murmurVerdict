import assert from "node:assert/strict";

import { parseLocation, readRouteQuery, buildRouteQueryUrl } from "./route.js";

assert.equal(parseLocation({ pathname: "/", hash: "" }).name, "landing");
assert.equal(parseLocation({ pathname: "/dashboard", hash: "" }).name, "dashboard");
assert.equal(parseLocation({ pathname: "/leaderboard", hash: "" }).name, "leaderboard");
assert.equal(parseLocation({ pathname: "/today", hash: "" }).name, "today");
assert.equal(parseLocation({ pathname: "/launch", hash: "" }).name, "launch");
assert.equal(parseLocation({ pathname: "/install", hash: "" }).name, "launch");
assert.equal(parseLocation({ pathname: "/recruiters", hash: "" }).name, "recruiters");
assert.equal(parseLocation({ pathname: "/#/leaderboard", hash: "#/leaderboard" }).name, "leaderboard");

// Query params resolve from whichever routing mode is live, and route
// resolution still ignores them (name matches on path only).
assert.equal(
  parseLocation({ pathname: "/leaderboard", hash: "", search: "?tier=main&sort=wr" }).name,
  "leaderboard",
);
assert.equal(
  parseLocation({ pathname: "/", hash: "#/leaderboard?tier=main&sort=wr" }).name,
  "leaderboard",
);

// Every agent-settings tab the page renders must be routable.
for (const tab of [
  "payout",
  "pricing",
  "earnings",
  "reveals",
  "wallet",
  "runtime",
  "keys",
  "profile",
]) {
  const r = parseLocation({ pathname: `/account/agent/x/${tab}`, hash: "" });
  assert.equal(r.name, "account_agent_settings");
  assert.equal(r.params?.tab, tab);
  assert.equal(r.params?.slug, "x");
}
// …and a tab that is not in the alternation is a real 404, not a silent
// fall-through to the default `payout` tab.
assert.equal(parseLocation({ pathname: "/account/agent/x/bogus", hash: "" }).name, "not_found");

// readRouteQuery: path-mode reads location.search, hash-mode reads the hash.
assert.equal(
  readRouteQuery({ pathname: "/leaderboard", hash: "", search: "?tier=main&sort=wr" }).get("tier"),
  "main",
);
assert.equal(
  readRouteQuery({ pathname: "/", hash: "#/leaderboard?tier=provisional&sort=lb" }).get("sort"),
  "lb",
);
assert.equal(readRouteQuery({ pathname: "/leaderboard", hash: "", search: "" }).get("tier"), null);

// buildRouteQueryUrl: mode-preserving, never doubles the path.
{
  const p = new URLSearchParams({ tier: "main", sort: "wr" });
  assert.equal(
    buildRouteQueryUrl({ pathname: "/leaderboard", hash: "", search: "" }, p),
    "/leaderboard?tier=main&sort=wr",
  );
  assert.equal(
    buildRouteQueryUrl({ pathname: "/", hash: "#/leaderboard?tier=all" }, p),
    "#/leaderboard?tier=main&sort=wr",
  );
  // Empty params drop the query string entirely (clean default URL).
  assert.equal(
    buildRouteQueryUrl({ pathname: "/leaderboard", hash: "", search: "?tier=main" }, new URLSearchParams()),
    "/leaderboard",
  );
}

console.log("router smoke: ok");
