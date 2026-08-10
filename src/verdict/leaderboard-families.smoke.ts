import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import { getCrossFamilyLeaderboard } from "./leaderboard-families.js";
import { crossFamilyLeaderboardSurface } from "./market-read-surface.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { resolutionsRepo } from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import { MIN_RESOLVED_CALLS_FOR_MAIN_TIER } from "./schema.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-leaderboard-families-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur cross family leaderboard smoke\n");
  const db = openDb({ path: dbPath });
  const mainAgentId = randomUUID();
  const provisionalAgentId = randomUUID();
  const servedAt = new Date("2026-06-12T09:30:00Z");

  insertAgent(db, {
    agentId: mainAgentId,
    slug: "cross-main-low",
    displayName: "Cross Main Low",
    createdAt: "2026-06-12T09:00:00Z",
  });
  insertAgent(db, {
    agentId: provisionalAgentId,
    slug: "cross-provisional-high",
    displayName: "Cross Provisional High",
    createdAt: "2026-06-12T09:01:00Z",
  });

  insertResolvedFamilyCalls(db, {
    agentId: mainAgentId,
    slug: "cross-main-low",
    family: "financial-direction",
    marketId: "eth.1h",
    callScore: 0,
    outcome: "loss",
  });
  insertResolvedFamilyCalls(db, {
    agentId: mainAgentId,
    slug: "cross-main-low",
    family: "event-binary",
    marketId: "poly.event",
    callScore: 0,
    outcome: "loss",
  });
  insertResolvedFamilyCalls(db, {
    agentId: provisionalAgentId,
    slug: "cross-provisional-high",
    family: "financial-direction",
    marketId: "eth.4h",
    callScore: 1,
    outcome: "win",
  });

  const topOnly = getCrossFamilyLeaderboard(db, { limit: 1 });
  assert.equal(topOnly.length, 1);
  assert.equal(topOnly[0]?.agent_id, mainAgentId);
  assert.equal(topOnly[0]?.cross_family_main_tier, true);

  const mainTier = getCrossFamilyLeaderboard(db, {
    tier: "main",
    limit: 10,
  });
  assert.deepEqual(mainTier.map((row) => row.agent_id), [mainAgentId]);

  const provisionalTier = getCrossFamilyLeaderboard(db, {
    tier: "provisional",
    limit: 10,
  });
  assert.deepEqual(
    provisionalTier.map((row) => row.agent_id),
    [provisionalAgentId],
  );

  const provisionalSurface = crossFamilyLeaderboardSurface({
    db,
    query: { tier: "provisional", limit: 10 },
    servedAt,
  });
  assert.equal(provisionalSurface.status, 200);
  assert.deepEqual(
    (provisionalSurface.body as {
      agents: Array<{ agent_id: string }>;
    }).agents.map((row) => row.agent_id),
    [provisionalAgentId],
  );

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("cross family leaderboard smoke ok\n");

function insertAgent(
  db: ReturnType<typeof openDb>,
  input: {
    agentId: string;
    slug: string;
    displayName: string;
    createdAt: string;
  },
): void {
  agentsRepo.insert(db, {
    agent_id: input.agentId,
    display_slug: input.slug,
    kind: "agent",
    display_name: input.displayName,
    created_at: input.createdAt,
  });
}

function insertResolvedFamilyCalls(
  db: ReturnType<typeof openDb>,
  input: {
    agentId: string;
    slug: string;
    family: string;
    marketId: string;
    callScore: number;
    outcome: "win" | "loss";
  },
): void {
  for (let i = 0; i < MIN_RESOLVED_CALLS_FOR_MAIN_TIER; i++) {
    insertResolvedCall(db, {
      ...input,
      index: i,
      acceptedAt: `2026-06-12T09:${String(i).padStart(2, "0")}:00Z`,
    });
  }
}

function insertResolvedCall(
  db: ReturnType<typeof openDb>,
  input: {
    agentId: string;
    slug: string;
    family: string;
    marketId: string;
    callScore: number;
    outcome: "win" | "loss";
    acceptedAt: string;
    index: number;
  },
): void {
  const callId = randomUUID();
  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: callId,
    agent_id: input.agentId,
    client_order_id: `${input.slug}-${input.family}-${input.index}`,
    horizon_seconds: 3600,
    submitted_at: input.acceptedAt,
    accepted_at: input.acceptedAt,
    rationale: "private rationale",
    strategy_tag: "private-strategy",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${callId}`,
    commit_hash: "a".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: input.marketId,
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: input.family,
  });
  resolutionsRepo.setResolution(db, {
    call_id: callId,
    t1: "2026-06-12T10:00:00Z",
    p1: input.outcome === "win" ? "101" : "99",
    t1_feed: "chainlink:base:ETH-USD",
    signed_return: input.outcome === "win" ? "0.01" : "-0.01",
    outcome: input.outcome,
    call_score: input.callScore,
    resolved_at: "2026-06-12T10:00:05Z",
  });
  submissionsRepo.setStatus(db, callId, "resolved");
}
