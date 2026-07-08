import assert from "node:assert/strict";

import {
  deployVerificationChecks,
  deployVerificationSummary,
  formatDeployVerificationResult,
  renderDeployVerificationHeader,
  renderDeployVerificationSummary,
  runDeployVerificationCheck,
  type DeployVerificationFetchAdapter,
} from "./deploy-verification-surface.js";

process.stdout.write("murmur deploy verification surface smoke\n");

const target = {
  api: "https://api.murmur.example",
  dashboard: "https://dash.murmur.example",
  expectNanopayX402: true,
  nanopayPipelineId: `0x${"1".repeat(64)}`,
  slug: "murmur-momentum",
};
const checks = deployVerificationChecks(target);
assert.equal(checks.length, 26);
assert.equal(checks[0]?.url, "https://api.murmur.example/v1/health");
assert.ok(
  checks.some(
    (c) =>
      c.name === "daemon /share/:slug (OG meta)" &&
      c.url === "https://api.murmur.example/share/murmur-momentum",
  ),
);
assert.ok(
  checks.some(
    (c) =>
      c.name === "dashboard /" &&
      c.url === "https://dash.murmur.example/",
  ),
);

const clock = steppedClock(1_000, 1_037);
const pass = await runDeployVerificationCheck({
  check: {
    name: "pass",
    url: "https://api.murmur.example/pass",
    expectContentType: /json/,
    expectBodyContains: /ok/,
  },
  fetcher: responseFetcher("ok", {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
  clock,
});
assert.deepEqual(pass, {
  name: "pass",
  url: "https://api.murmur.example/pass",
  ok: true,
  status: 200,
  contentType: "application/json",
  ms: 37,
});

const statusFail = await runDeployVerificationCheck({
  check: { name: "status", url: "https://api.murmur.example/status" },
  fetcher: responseFetcher("no", { status: 503 }),
  clock: steppedClock(2_000, 2_005),
});
assert.equal(statusFail.ok, false);
assert.equal(statusFail.detail, "expected 200 got 503");
assert.equal(statusFail.ms, 5);

const contentTypeFail = await runDeployVerificationCheck({
  check: {
    name: "content",
    url: "https://api.murmur.example/content",
    expectContentType: /json/,
  },
  fetcher: responseFetcher("{}", {
    status: 200,
    headers: { "content-type": "text/plain" },
  }),
  clock: steppedClock(3_000, 3_010),
});
assert.equal(contentTypeFail.ok, false);
assert.equal(
  contentTypeFail.detail,
  'content-type "text/plain" doesn\'t match /json/',
);

const bodyFail = await runDeployVerificationCheck({
  check: {
    name: "body",
    url: "https://api.murmur.example/body",
    expectBodyContains: /schema_version/,
  },
  fetcher: responseFetcher("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
  clock: steppedClock(4_000, 4_020),
});
assert.equal(bodyFail.ok, false);
assert.equal(bodyFail.detail, "body doesn't contain /schema_version/");

const shareCheck = checks.find((c) => c.name === "daemon /share/:slug (OG meta)");
assert.ok(shareCheck);
const sharePass = await runDeployVerificationCheck({
  check: shareCheck,
  fetcher: responseFetcher(
    [
      '<meta property="og:image" content="https://api.murmur.example/v1/og/murmur-momentum.png">',
      '<meta name="twitter:image" content="https://api.murmur.example/v1/og/murmur-momentum.png">',
    ].join("\n"),
    { headers: { "content-type": "text/html" } },
  ),
  clock: steppedClock(5_000, 5_011),
});
assert.equal(sharePass.ok, true);

const cardCheck = checks.find((c) => c.name === "daemon /v1/agents/:slug/agent-card");
assert.ok(cardCheck);
const cardPass = await runDeployVerificationCheck({
  check: cardCheck,
  fetcher: responseFetcher(
    JSON.stringify({
      type: "ERC-8004:AgentCard",
      services: [{ endpoint: "https://api.murmur.example/v2/nanopay/infer/{pipelineId}" }],
      x402Support: true,
      x402: { endpoint: "https://api.murmur.example/v2/nanopay/infer/{pipelineId}" },
    }),
    { headers: { "content-type": "application/json" } },
  ),
  clock: steppedClock(5_100, 5_119),
});
assert.equal(cardPass.ok, true);

const nanopayCheck = checks.find((c) => c.name === "daemon /v2/nanopay/infer/:pipelineId (x402)");
assert.ok(nanopayCheck);
assert.equal(nanopayCheck.url, `https://api.murmur.example/v2/nanopay/infer/0x${"1".repeat(64)}`);
const nanopayPass = await runDeployVerificationCheck({
  check: nanopayCheck,
  fetcher: responseFetcher("", { status: 402 }),
  clock: steppedClock(5_200, 5_229),
});
assert.equal(nanopayPass.ok, true);

const defaultTarget = {
  api: "https://api.murmur.example",
  dashboard: "https://dash.murmur.example",
  slug: "murmur-momentum",
};
const defaultCardCheck = deployVerificationChecks(defaultTarget).find(
  (c) => c.name === "daemon /v1/agents/:slug/agent-card",
);
assert.ok(defaultCardCheck);
const defaultCardPass = await runDeployVerificationCheck({
  check: defaultCardCheck,
  fetcher: responseFetcher(
    JSON.stringify({
      type: "ERC-8004:AgentCard",
      services: [],
      x402Support: false,
    }),
    { headers: { "content-type": "application/json" } },
  ),
  clock: steppedClock(5_300, 5_317),
});
assert.equal(defaultCardPass.ok, true);

const fetchFail = await runDeployVerificationCheck({
  check: { name: "network", url: "https://api.murmur.example/network" },
  fetcher: async () => {
    throw new Error("connection refused");
  },
  clock: steppedClock(6_000, 6_123),
});
assert.equal(fetchFail.ok, false);
assert.equal(fetchFail.detail, "connection refused");
assert.equal(fetchFail.ms, 123);

assert.match(renderDeployVerificationHeader(target), /Murmur Verdict - deploy verifier/);
assert.match(formatDeployVerificationResult(pass), /pass/);
assert.match(formatDeployVerificationResult(fetchFail), /connection refused/);
assert.deepEqual(deployVerificationSummary([pass, fetchFail]), {
  passed: 1,
  failed: 1,
  total: 2,
});
assert.match(renderDeployVerificationSummary([pass]), /1 \/ 1 passed/);

process.stdout.write("deploy verification surface smoke ok\n");

function responseFetcher(
  body: string,
  init: ResponseInit = {},
): DeployVerificationFetchAdapter {
  return async () => new Response(body, init);
}

function steppedClock(...values: number[]): { nowMs: () => number } {
  let i = 0;
  return {
    nowMs: () => values[Math.min(i++, values.length - 1)] ?? 0,
  };
}
