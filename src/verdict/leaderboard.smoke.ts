import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  getLeaderboard,
  getLeaderboardRowForAgent,
} from "./leaderboard.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { resolutionsRepo } from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-leaderboard-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur leaderboard smoke\n");
  const db = openDb({ path: dbPath });
  const highAgentId = randomUUID();
  const lowAgentId = randomUUID();

  insertResolvedCall(db, {
    agentId: highAgentId,
    slug: "leaderboard-high",
    displayName: "Leaderboard High",
    callScore: 1,
    outcome: "win",
    acceptedAt: "2026-06-12T09:00:00Z",
  });
  insertResolvedCall(db, {
    agentId: lowAgentId,
    slug: "leaderboard-low",
    displayName: "Leaderboard Low",
    callScore: 0,
    outcome: "loss",
    acceptedAt: "2026-06-12T09:05:00Z",
  });

  const topOnly = getLeaderboard(db, { limit: 1 });
  assert.equal(topOnly.length, 1);
  assert.equal(topOnly[0]?.agent_id, highAgentId);

  const lowRow = getLeaderboardRowForAgent(db, lowAgentId);
  assert.ok(lowRow);
  assert.equal(lowRow.agent_id, lowAgentId);
  assert.equal(lowRow.display_slug, "leaderboard-low");
  assert.equal(lowRow.resolved_calls, 1);

  const missingRow = getLeaderboardRowForAgent(db, randomUUID());
  assert.equal(missingRow, null);

  // Call-site policy pin: the GLOBAL board sorts by RAW verdict_score
  // (preferLowerBound:false). Construct two agents whose raw-score order is
  // the OPPOSITE of their lower-bound order, so a swap to lb-sorting would
  // flip the ranking and fail here:
  //   rawWinner  [1.0, 0.6] → verdict_score 0.6,  verdict_score_lb ≈ 0.471
  //   lbWinner   [0.55,0.55] → verdict_score 0.55, verdict_score_lb 0.55
  // Global (raw): rawWinner(0.60) > lbWinner(0.55) → rawWinner ranks first.
  // (Market/family boards prefer lb and rank lbWinner first — see
  //  leaderboard-markets.smoke.ts.)
  const rawWinnerId = randomUUID();
  const lbWinnerId = randomUUID();
  insertAgentWithResolvedCalls(db, {
    agentId: rawWinnerId,
    slug: "lb-raw-winner",
    displayName: "Raw Winner",
    acceptedAt: "2026-06-12T11:00:00Z",
    scores: [1.0, 0.6],
  });
  insertAgentWithResolvedCalls(db, {
    agentId: lbWinnerId,
    slug: "lb-lb-winner",
    displayName: "LB Winner",
    acceptedAt: "2026-06-12T11:00:00Z",
    scores: [0.55, 0.55],
  });
  const globalBoard = getLeaderboard(db);
  const rawIdx = globalBoard.findIndex((r) => r.agent_id === rawWinnerId);
  const lbIdx = globalBoard.findIndex((r) => r.agent_id === lbWinnerId);
  assert.ok(rawIdx >= 0 && lbIdx >= 0, "both divergent agents present");
  // Global board sorts by RAW verdict_score, so rawWinner ([1.0, 0.6]) outranks
  // lbWinner ([0.55, 0.55]) despite the wider interval. Market/family boards
  // use the lower bound; this pins that global does NOT — a swap here silently
  // reorders every public ranking.
  assert.ok(
    rawIdx < lbIdx,
    "global board sorts by raw verdict_score → rawWinner outranks lbWinner",
  );

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("leaderboard smoke ok\n");

function insertResolvedCall(
  db: ReturnType<typeof openDb>,
  input: {
    agentId: string;
    slug: string;
    displayName: string;
    callScore: number;
    outcome: "win" | "loss";
    acceptedAt: string;
  },
): void {
  const callId = randomUUID();
  agentsRepo.insert(db, {
    agent_id: input.agentId,
    display_slug: input.slug,
    kind: "agent",
    display_name: input.displayName,
    created_at: input.acceptedAt,
  });
  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: callId,
    agent_id: input.agentId,
    client_order_id: `${input.slug}-order`,
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
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
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

/**
 * Insert one agent with N resolved calls at the given call_scores. Used to
 * build agents whose raw verdict_score and lower-bound ordering diverge
 * (verdict_score_lb penalizes variance harder), pinning the per-board sort
 * policy. outcome is derived from the score sign and only drives win_rate;
 * verdict_score / verdict_score_lb depend solely on the call_scores.
 */
function insertAgentWithResolvedCalls(
  db: ReturnType<typeof openDb>,
  input: {
    agentId: string;
    slug: string;
    displayName: string;
    acceptedAt: string;
    scores: number[];
  },
): void {
  agentsRepo.insert(db, {
    agent_id: input.agentId,
    display_slug: input.slug,
    kind: "agent",
    display_name: input.displayName,
    created_at: input.acceptedAt,
  });
  input.scores.forEach((score, i) => {
    const callId = randomUUID();
    submissionsRepo.acceptSealedFhenixCall(db, {
      call_id: callId,
      agent_id: input.agentId,
      client_order_id: `${input.slug}-order-${i}`,
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
      market_id: "eth.1h",
      market_config_version: 1,
      adapter_id: "native-price",
      market_family: "financial-direction",
    });
    resolutionsRepo.setResolution(db, {
      call_id: callId,
      t1: "2026-06-12T10:00:00Z",
      p1: score >= 0.5 ? "101" : "99",
      t1_feed: "chainlink:base:ETH-USD",
      signed_return: score >= 0.5 ? "0.01" : "-0.01",
      outcome: score >= 0.5 ? "win" : "loss",
      call_score: score,
      resolved_at: "2026-06-12T10:00:05Z",
    });
    submissionsRepo.setStatus(db, callId, "resolved");
  });
}
