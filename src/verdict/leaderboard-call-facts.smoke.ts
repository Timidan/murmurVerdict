import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  isPendingLeaderboardStatus,
  queryLeaderboardCallFacts,
} from "./leaderboard-call-facts.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { resolutionsRepo } from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-leaderboard-call-facts-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur leaderboard call facts smoke\n");
  const db = openDb({ path: dbPath });
  const agentId = randomUUID();
  insertAgent(db, {
    agentId,
    slug: "facts-agent",
    displayName: "Facts Agent",
    createdAt: "2026-06-12T09:00:00Z",
  });

  // Two resolved calls on eth.1h and one still-pending call on btc.1h.
  insertResolvedCall(db, {
    agentId,
    slug: "facts-agent",
    callScore: 1,
    outcome: "win",
    acceptedAt: "2026-06-12T09:00:00Z",
    index: 0,
    marketId: "eth.1h",
  });
  insertResolvedCall(db, {
    agentId,
    slug: "facts-agent",
    callScore: 0,
    outcome: "loss",
    acceptedAt: "2026-06-12T09:05:00Z",
    index: 1,
    marketId: "eth.1h",
  });
  const pendingCallId = insertPendingCall(db, {
    agentId,
    slug: "facts-agent",
    acceptedAt: "2026-06-12T09:10:00Z",
    index: 2,
    marketId: "btc.1h",
  });

  // global scope: every call surfaces with typed status/outcome + market cols.
  const global = queryLeaderboardCallFacts(db, {
    kind: "global",
    includeKinds: ["agent"],
  });
  assert.equal(global.length, 3);
  const pendingFact = global.find((r) => r.call_id === pendingCallId);
  assert.ok(pendingFact, "pending call present in global facts");
  assert.equal(pendingFact.outcome, null);
  assert.equal(pendingFact.resolved_at, null);
  assert.equal(pendingFact.market_id, "btc.1h");
  assert.equal(pendingFact.market_family, "financial-direction");
  assert.equal(isPendingLeaderboardStatus(pendingFact.status), true);
  const resolvedFact = global.find((r) => r.outcome === "win");
  assert.ok(resolvedFact);
  assert.equal(isPendingLeaderboardStatus(resolvedFact.status), false);

  // market scope: filters to one market_id.
  const eth = queryLeaderboardCallFacts(db, {
    kind: "market",
    includeKinds: ["agent"],
    market_id: "eth.1h",
  });
  assert.equal(eth.length, 2);
  assert.ok(eth.every((r) => r.market_id === "eth.1h"));

  // agent_markets scope: one agent, only calls that belong to a market.
  const grid = queryLeaderboardCallFacts(db, {
    kind: "agent_markets",
    agent_id: agentId,
  });
  assert.equal(grid.length, 3);
  assert.ok(grid.every((r) => r.market_id !== null));

  // family scope: filters to one market_family.
  const family = queryLeaderboardCallFacts(db, {
    kind: "family",
    includeKinds: ["agent"],
    market_family: "financial-direction",
  });
  assert.equal(family.length, 3);
  assert.ok(family.every((r) => r.market_family === "financial-direction"));

  // cross_family scope: every family-tagged call.
  const cross = queryLeaderboardCallFacts(db, {
    kind: "cross_family",
    includeKinds: ["agent"],
  });
  assert.equal(cross.length, 3);
  assert.ok(cross.every((r) => r.market_family !== null));

  // Pending-status predicate centralizes the vocabulary.
  assert.equal(isPendingLeaderboardStatus("accepted"), true);
  assert.equal(isPendingLeaderboardStatus("pending_t0"), true);
  assert.equal(isPendingLeaderboardStatus("pending_t1"), true);
  assert.equal(isPendingLeaderboardStatus("resolved"), false);
  assert.equal(isPendingLeaderboardStatus("re_resolved"), false);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("leaderboard call facts smoke ok\n");

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

function acceptCall(
  db: ReturnType<typeof openDb>,
  input: {
    agentId: string;
    slug: string;
    acceptedAt: string;
    index: number;
    marketId: string;
  },
): string {
  const callId = randomUUID();
  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: callId,
    agent_id: input.agentId,
    client_order_id: `${input.slug}-order-${input.index}`,
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
    market_family: "financial-direction",
  });
  return callId;
}

function insertResolvedCall(
  db: ReturnType<typeof openDb>,
  input: {
    agentId: string;
    slug: string;
    callScore: number;
    outcome: "win" | "loss";
    acceptedAt: string;
    index: number;
    marketId: string;
  },
): void {
  const callId = acceptCall(db, input);
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

function insertPendingCall(
  db: ReturnType<typeof openDb>,
  input: {
    agentId: string;
    slug: string;
    acceptedAt: string;
    index: number;
    marketId: string;
  },
): string {
  // Accept but do not resolve: the call stays in a pending status with no
  // t1_resolutions row, so the LEFT JOIN yields null outcome/resolved_at.
  return acceptCall(db, input);
}
