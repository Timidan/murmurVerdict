import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  publicLeaderboardCsvQuery,
  publicLeaderboardQuery,
} from "./public-ranking-query.js";
import {
  publicLeaderboardCsvResponse,
  publicLeaderboardMarkdownResponse,
  publicLeaderboardResponse,
  publicStatsResponse,
  publicTodayFeedResponse,
  sendPublicRankingBodyResponse,
  sendPublicRankingJsonResponse,
} from "./public-ranking-surface.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { resolutionsRepo } from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";

class FakeRankingJsonResponse<TBody> {
  headers: Record<string, string> = {};
  statusCode: number | null = null;
  body: TBody | null = null;

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  status(code: number): { json: (body: TBody) => void } {
    this.statusCode = code;
    return {
      json: (body: TBody) => {
        this.body = body;
      },
    };
  }
}

class FakeRankingBodyResponse {
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

const tmp = mkdtempSync(join(tmpdir(), "murmur-public-ranking-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur public ranking surface smoke\n");
  const db = openDb({ path: dbPath });
  const servedAt = new Date("2026-06-12T09:30:00Z");
  const agentId = randomUUID();
  const staleAgentId = randomUUID();
  const resolvedCallId = randomUUID();
  const pendingCallId = randomUUID();
  const staleResolvedCallId = randomUUID();
  const acceptedAt = "2026-06-12T09:00:00Z";
  const staleAcceptedAt = "2026-06-10T09:00:00Z";

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "ranking-surface",
    kind: "agent",
    display_name: "Ranking, Surface",
    bio: "ranking surface fixture",
    created_at: acceptedAt,
  });
  agentsRepo.insert(db, {
    agent_id: staleAgentId,
    display_slug: "ranking-stale",
    kind: "internal_test",
    display_name: "Ranking Stale",
    bio: "stale rolling-window fixture",
    created_at: staleAcceptedAt,
  });

  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: resolvedCallId,
    agent_id: agentId,
    client_order_id: "ranking-surface-resolved",
    horizon_seconds: 3600,
    submitted_at: acceptedAt,
    accepted_at: acceptedAt,
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${resolvedCallId}`,
    commit_hash: "a".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
  });
  resolutionsRepo.setResolution(db, {
    call_id: resolvedCallId,
    t1: "2026-06-12T10:00:00Z",
    p1: "101",
    t1_feed: "chainlink:base:ETH-USD",
    signed_return: "0.01",
    outcome: "win",
    call_score: 1,
    resolved_at: "2026-06-12T10:00:05Z",
  });
  submissionsRepo.setStatus(db, resolvedCallId, "resolved");

  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: pendingCallId,
    agent_id: agentId,
    client_order_id: "ranking-surface-pending",
    horizon_seconds: 3600,
    submitted_at: acceptedAt,
    accepted_at: "2026-06-12T09:05:00Z",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${pendingCallId}`,
    commit_hash: "b".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
  });

  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: staleResolvedCallId,
    agent_id: staleAgentId,
    client_order_id: "ranking-surface-stale",
    horizon_seconds: 3600,
    submitted_at: staleAcceptedAt,
    accepted_at: staleAcceptedAt,
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${staleResolvedCallId}`,
    commit_hash: "c".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
  });
  resolutionsRepo.setResolution(db, {
    call_id: staleResolvedCallId,
    t1: "2026-06-10T10:00:00Z",
    p1: "99",
    t1_feed: "chainlink:base:ETH-USD",
    signed_return: "-0.01",
    outcome: "loss",
    call_score: -1,
    resolved_at: "2026-06-10T10:00:05Z",
  });
  submissionsRepo.setStatus(db, staleResolvedCallId, "resolved");

  const leaderboard = publicLeaderboardResponse({
    db,
    servedAt,
    query: publicLeaderboardQuery({ limit: "bad", tier: "unknown" }),
  });
  assert.equal(leaderboard.status, 200);
  assert.equal(leaderboard.headers, undefined);
  assert.equal(leaderboard.body.served_at, "2026-06-12T09:30:00Z");
  assert.equal(leaderboard.body.rows[0]?.display_slug, "ranking-surface");
  assert.equal(leaderboard.body.rows[0]?.resolved_calls, 1);

  const today = publicTodayFeedResponse({ db, servedAt });
  assert.equal(today.status, 200);
  assert.equal(today.body.served_at, "2026-06-12T09:30:00Z");
  assert.equal(today.body.accepted_recent.length, 3);
  assert.equal(today.body.resolved_recent.length, 2);
  assert.equal(today.body.totals.accepted_24h, 2);
  assert.equal(today.body.totals.resolved_24h, 1);
  assert.equal(today.body.totals.wins_24h, 1);
  assert.equal(today.body.totals.losses_24h, 0);
  assert.equal(today.body.movers[0]?.agent_slug, "ranking-surface");
  assert.equal(today.body.movers[0]?.delta_24h_calls, 1);
  assert.equal(JSON.stringify(today.body).includes("ranking-surface-pending"), false);

  const stats = publicStatsResponse({
    db,
    servedAt,
    events: { subscriberCount: () => 4 } as never,
  });
  assert.equal(stats.status, 200);
  assert.equal(
    stats.headers?.["Cache-Control"],
    "public, max-age=60, stale-while-revalidate=300",
  );
  assert.equal(stats.body.stream_subscribers, 4);
  assert.equal(stats.body.calls_total, 3);
  assert.equal(stats.body.calls_resolved, 2);
  assert.equal(stats.body.losses_total, 1);
  const statsRes = new FakeRankingJsonResponse<typeof stats.body>();
  sendPublicRankingJsonResponse(statsRes, stats);
  assert.equal(statsRes.statusCode, 200);
  assert.equal(
    statsRes.headers["Cache-Control"],
    "public, max-age=60, stale-while-revalidate=300",
  );
  assert.equal(statsRes.body?.calls_total, 3);

  const markdown = publicLeaderboardMarkdownResponse({ db, servedAt });
  assert.equal(markdown.status, 200);
  assert.equal(markdown.headers?.["Content-Type"], "text/markdown; charset=utf-8");
  assert.equal(
    markdown.headers?.["Cache-Control"],
    "public, max-age=120, stale-while-revalidate=600",
  );
  assert.match(markdown.body, /# Murmur Verdict/);
  assert.match(markdown.body, /\*\*24h:\*\* 2 accepted · 1 resolved · 1 wins · 0 losses · 0 void/);
  assert.match(markdown.body, /Ranking, Surface/);
  const markdownRes = new FakeRankingBodyResponse();
  sendPublicRankingBodyResponse(markdownRes, markdown);
  assert.equal(markdownRes.statusCode, 200);
  assert.equal(markdownRes.headers["Content-Type"], "text/markdown; charset=utf-8");
  assert.match(markdownRes.body ?? "", /# Murmur Verdict/);

  const csv = publicLeaderboardCsvResponse({
    db,
    query: publicLeaderboardCsvQuery({ limit: "1" }),
  });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers?.["Content-Type"], "text/csv; charset=utf-8");
  assert.equal(
    csv.headers?.["Cache-Control"],
    "public, max-age=60, stale-while-revalidate=300",
  );
  assert.equal(csv.headers?.["Content-Disposition"], `inline; filename="leaderboard.csv"`);
  assert.ok(csv.body.startsWith("rank,display_slug,display_name"));
  assert.match(csv.body, /"Ranking, Surface"/);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("  ok ranking response bodies and metadata stay together\n");
