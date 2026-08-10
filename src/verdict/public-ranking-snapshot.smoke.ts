import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import { csvCell } from "./public-escaping.js";
import {
  publicLeaderboardCsvQuery,
  publicLeaderboardQuery,
} from "./public-ranking-query.js";
import {
  publicLeaderboardCsv,
  publicLeaderboardMarkdown,
  publicLeaderboardSnapshot,
  publicStatsSnapshot,
} from "./public-ranking-snapshot.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { resolutionsRepo } from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-public-ranking-snapshot-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur public ranking snapshot smoke\n");
  const db = openDb({ path: dbPath });
  const servedAt = new Date("2026-06-12T09:30:00Z");
  const agentId = randomUUID();
  const resolvedCallId = randomUUID();
  const pendingCallId = randomUUID();
  const acceptedAt = "2026-06-12T09:00:00Z";

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "alpha-trader",
    kind: "agent",
    display_name: "Alpha, Trader",
    bio: "ranking fixture",
    created_at: acceptedAt,
  });

  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: resolvedCallId,
    agent_id: agentId,
    client_order_id: "ranking-resolved",
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
    client_order_id: "ranking-pending",
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

  const leaderboard = publicLeaderboardSnapshot({
    db,
    servedAt,
    query: publicLeaderboardQuery({ limit: "bad", tier: "unknown" }),
  });
  assert.equal(leaderboard.schema_version, 1);
  assert.equal(leaderboard.scoring_version, 1);
  assert.equal(leaderboard.served_at, "2026-06-12T09:30:00Z");
  assert.equal(leaderboard.rows.length, 1);
  assert.equal(leaderboard.rows[0]?.display_slug, "alpha-trader");
  assert.equal(leaderboard.rows[0]?.resolved_calls, 1);
  assert.equal(leaderboard.rows[0]?.pending_calls, 1);

  const stats = publicStatsSnapshot({
    db,
    servedAt,
    events: { subscriberCount: () => 7 },
  });
  assert.equal(stats.stream_subscribers, 7);
  assert.equal(stats.agents_total, 1);
  assert.equal(stats.calls_total, 2);
  assert.equal(stats.calls_resolved, 1);
  assert.equal(stats.calls_pending, 1);
  assert.equal(stats.wins_total, 1);
  assert.equal(stats.mean_call_score, 1);

  const markdown = publicLeaderboardMarkdown({ db, servedAt });
  assert.equal(markdown.contentType, "text/markdown; charset=utf-8");
  assert.ok(markdown.body.includes("# Murmur Verdict"));
  assert.ok(markdown.body.includes("Alpha, Trader"));

  const csv = publicLeaderboardCsv({
    db,
    query: publicLeaderboardCsvQuery({ limit: "1" }),
  });
  assert.equal(csv.filename, "leaderboard.csv");
  assert.equal(csv.contentType, "text/csv; charset=utf-8");
  assert.ok(csv.body.startsWith("rank,display_slug,display_name"));
  assert.ok(csv.body.includes("\"Alpha, Trader\""));

  for (const prefix of ["=", "+", "-", "@"]) {
    assert.equal(csvCell(`${prefix}SUM(1)`), `'${prefix}SUM(1)`);
    assert.equal(csvCell(` \t${prefix}SUM(1)`), `' \t${prefix}SUM(1)`);
  }

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("public ranking snapshot smoke ok\n");
