import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentsRepo,
  openDb,
  resolutionsRepo,
  submissionsRepo,
} from "../verdict/db.js";
import { buildLaunchpadOpenServCapabilities } from "./openserv-launchpad.js";

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    process.stdout.write(`  ok ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  fail ${name}\n`);
    process.stdout.write(`      ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-openserv-smoke-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur openserv launchpad smoke\n");
  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  const pendingCallId = randomUUID();
  const resolvedCallId = randomUUID();
  const acceptedAt = "2026-05-14T12:00:00Z";

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "openserv-smoke",
    kind: "agent",
    display_name: "OpenServ Smoke",
    bio: "Public market agent",
    created_at: acceptedAt,
  });

  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: pendingCallId,
    agent_id: agentId,
    client_order_id: "pending-private-order",
    horizon_seconds: 3600,
    submitted_at: acceptedAt,
    accepted_at: acceptedAt,
    rationale: "secret pending rationale should not leak",
    strategy_tag: "secret-tag",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${pendingCallId}`,
    commit_hash: "a".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
  });

  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: resolvedCallId,
    agent_id: agentId,
    client_order_id: "resolved-private-order",
    horizon_seconds: 3600,
    submitted_at: acceptedAt,
    accepted_at: "2026-05-14T13:00:00Z",
    rationale: "resolved rationale is still not part of OpenServ discovery",
    strategy_tag: "resolved-secret-tag",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${resolvedCallId}`,
    commit_hash: "b".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
  });
  resolutionsRepo.setResolution(db, {
    call_id: resolvedCallId,
    t1: "2026-05-14T14:00:00Z",
    p1: "101",
    t1_feed: "chainlink:base:ETH-USD",
    signed_return: "0.01",
    outcome: "win",
    call_score: 1,
    resolved_at: "2026-05-14T14:00:05Z",
  });
  submissionsRepo.setStatus(db, resolvedCallId, "resolved");

  const capabilities = buildLaunchpadOpenServCapabilities({
    db,
    dashboardUrl: "https://murmur.example",
    publicApiUrl: "https://api.murmur.example",
    launchpadProjectId: "openserv-project-1",
    launchpadProjectUrl: "https://launch.openserv.ai/projects/murmur",
    launchpadStage: "prelaunch",
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const capability = capabilities.find((item) => item.name === name);
    assert.ok(capability, `missing capability ${name}`);
    return JSON.parse(await capability.run({ args }));
  };

  await check("capability set is public-only", () => {
    const names = capabilities.map((capability) => capability.name).sort();
    assert.deepEqual(names, [
      "create_murmur_deeplink",
      "get_agent_scorecard",
      "get_leaderboard",
      "get_market",
      "get_market_taxonomy",
      "get_murmur_launch_status",
      "get_public_agent_calls",
      "get_public_call",
      "rank_agents_for_market",
      "search_markets",
    ]);
    assert.equal(names.includes("submit_call"), false);
    assert.equal(names.includes("submit_verdict"), false);
    assert.equal(names.some((name) => name.includes("fhenix")), false);
  });

  await check("market discovery returns public registry metadata", async () => {
    const result = await call("search_markets", { query: "eth", limit: 5 });
    assert.equal(result.kind, "murmur_market_search");
    assert.ok(
      result.markets.some((market: { market_id: string }) => market.market_id === "eth.1h"),
    );
    const market = await call("get_market", { market_id: "eth.1h" });
    assert.equal(market.market.market_id, "eth.1h");
    assert.equal(market.market.adapter_id, "native-price");
    assert.equal(market.market.market_taxonomy.resolution_class, "price_direction");
    const byClass = await call("search_markets", {
      resolution_class: "price_direction",
      limit: 5,
    });
    assert.ok(
      byClass.markets.some((item: { market_id: string }) => item.market_id === "eth.1h"),
    );
  });

  await check("market taxonomy is discoverable by OpenServ", async () => {
    const result = await call("get_market_taxonomy");
    assert.equal(result.kind, "murmur_market_taxonomy");
    assert.ok(result.taxonomy.live_resolution_classes.includes("price_direction"));
    assert.ok(result.taxonomy.reserved_resolution_classes.includes("sports_match"));
  });

  await check("agent scorecard exposes public reputation and links", async () => {
    const result = await call("get_agent_scorecard", { slug: "openserv-smoke" });
    assert.equal(result.agent.display_slug, "openserv-smoke");
    assert.equal(result.agent.api_key_hash, undefined);
    assert.equal(result.links.profile, "https://murmur.example/#/agents/openserv-smoke");
    assert.ok(Array.isArray(result.market_grid));
  });

  await check("public agent calls do not leak pending private verdict fields", async () => {
    const result = await call("get_public_agent_calls", {
      slug: "openserv-smoke",
      limit: 10,
    });
    const asText = JSON.stringify(result);
    assert.equal(asText.includes("secret pending rationale"), false);
    assert.equal(asText.includes("secret-tag"), false);
    assert.equal(asText.includes("confidence"), false);
    assert.equal(asText.includes("BUY"), false);
    const pending = result.calls.find((item: { call_id: string }) => item.call_id === pendingCallId);
    assert.ok(pending);
    assert.equal(pending.status, "accepted");
    assert.equal(pending.commit_hash, "a".repeat(64));
    const resolved = result.calls.find((item: { call_id: string }) => item.call_id === resolvedCallId);
    assert.equal(resolved.outcome, "win");
    assert.equal(resolved.call_score, 1);
  });

  await check("single public call keeps pending rows operator-blind", async () => {
    const pending = await call("get_public_call", { call_id: pendingCallId });
    const asText = JSON.stringify(pending);
    assert.equal(pending.submission.status, "accepted");
    assert.equal(pending.resolution, null);
    assert.equal(asText.includes("secret pending rationale"), false);
    assert.equal(asText.includes("secret-tag"), false);
    assert.equal(asText.includes("revealed_verdict"), false);
  });

  await check("launch status and deep links are OpenServ launchpad-facing", async () => {
    const status = await call("get_murmur_launch_status");
    assert.equal(status.stage, "prelaunch");
    assert.equal(status.launchpad_project_id, "openserv-project-1");
    assert.equal(status.public_api_url, "https://api.murmur.example");
    const link = await call("create_murmur_deeplink", {
      target: "market",
      market_id: "eth.1h",
    });
    assert.equal(link.url, "https://murmur.example/#/markets/eth.1h");
  });

  if (failures > 0) {
    process.exitCode = 1;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
