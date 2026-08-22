import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentsRepo,
  openDb,
  submissionsRepo,
} from "./db.js";
import {
  publicAgentRssResponse,
  sendPublicAgentRssResponse,
} from "./public-agent-rss-surface.js";
import { publicRssDashboardLinks } from "./public-rss-links.js";

class FakePublicAgentRssResponse {
  headers: Record<string, string> = {};
  statusCode: number | null = null;
  body: string | null = null;

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  status(code: number): { send: (body: string) => void } {
    this.statusCode = code;
    return {
      send: (body: string) => {
        this.body = body;
      },
    };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-public-agent-rss-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur public agent rss surface smoke\n");
  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  const olderCallId = randomUUID();
  const newerCallId = randomUUID();

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "rss-agent",
    kind: "agent",
    display_name: "RSS <Agent> & Co",
    bio: "RSS projection fixture",
    created_at: "2026-05-27T09:00:00Z",
  });

  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: olderCallId,
    agent_id: agentId,
    client_order_id: "older-private-order",
    horizon_seconds: 3600,
    submitted_at: "2026-05-27T09:30:00Z",
    accepted_at: "2026-05-27T09:30:00Z",
    rationale: "older secret rationale",
    strategy_tag: "older-secret-tag",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${olderCallId}`,
    commit_hash: "a".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
  });
  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: newerCallId,
    agent_id: agentId,
    client_order_id: "newer-private-order",
    horizon_seconds: 3600,
    submitted_at: "2026-05-27T10:00:00Z",
    accepted_at: "2026-05-27T10:00:00Z",
    rationale: "newer secret rationale",
    strategy_tag: "newer-secret-tag",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${newerCallId}`,
    commit_hash: "b".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
  });

  const known = publicAgentRssResponse({
    db,
    slug: "rss-agent",
    query: { limit: 1 },
    dashboardLinks: publicRssDashboardLinks("https://dashboard.example/"),
  });
  assert.equal(known.status, 200);
  assert.equal(known.headers["Content-Type"], "application/rss+xml; charset=utf-8");
  assert.equal(
    known.headers["Cache-Control"],
    "public, max-age=60, stale-while-revalidate=300",
  );
  assert.match(known.body, /<title>Murmur Verdict · RSS &lt;Agent&gt; &amp; Co<\/title>/);
  assert.match(known.body, /https:\/\/dashboard\.example\/#\/agents\/rss-agent/);
  assert.match(known.body, new RegExp(`murmur:${newerCallId}`));
  assert.doesNotMatch(known.body, new RegExp(olderCallId));
  assert.match(known.body, /<title>\[SEALED\] PENDING<\/title>/);
  assert.match(known.body, /sealed call · pending reveal\/resolution/);
  assert.doesNotMatch(known.body, /secret rationale/);
  assert.doesNotMatch(known.body, /secret-tag/);
  assert.doesNotMatch(known.body, /newer-private-order/);
  const knownRes = new FakePublicAgentRssResponse();
  sendPublicAgentRssResponse(knownRes, known);
  assert.equal(knownRes.statusCode, 200);
  assert.equal(knownRes.headers["Content-Type"], "application/rss+xml; charset=utf-8");
  assert.equal(
    knownRes.headers["Cache-Control"],
    "public, max-age=60, stale-while-revalidate=300",
  );
  assert.match(knownRes.body ?? "", /<title>Murmur Verdict · RSS &lt;Agent&gt; &amp; Co<\/title>/);

  const refererFallback = publicAgentRssResponse({
    db,
    slug: "rss-agent",
    query: { limit: 20 },
    dashboardLinks: publicRssDashboardLinks("https://referer.example"),
  });
  assert.match(refererFallback.body, /https:\/\/referer\.example\/#\/agents\/rss-agent/);

  const missing = publicAgentRssResponse({
    db,
    slug: "missing<agent>",
    query: { limit: 20 },
    dashboardLinks: publicRssDashboardLinks("https://dashboard.example"),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["Content-Type"], "application/xml");
  assert.match(missing.body, /<title>Murmur Verdict · missing&lt;agent&gt;<\/title>/);
  assert.match(missing.body, /<description>agent not found<\/description>/);
  const missingRes = new FakePublicAgentRssResponse();
  sendPublicAgentRssResponse(missingRes, missing);
  assert.equal(missingRes.statusCode, 404);
  assert.equal(missingRes.headers["Content-Type"], "application/xml");
  assert.equal("Cache-Control" in missingRes.headers, false);
  assert.match(missingRes.body ?? "", /<description>agent not found<\/description>/);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("  ok RSS lookup, origin links, limit policy, and privacy projection stay together\n");
