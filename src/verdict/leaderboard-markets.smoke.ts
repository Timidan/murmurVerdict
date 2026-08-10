import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  getAgentMarketGrid,
  getLeaderboardForMarket,
  getLeaderboardForMarkets,
} from "./leaderboard-markets.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { resolutionsRepo } from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import { MIN_RESOLVED_CALLS_FOR_MAIN_TIER } from "./schema.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-leaderboard-markets-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur market scoped leaderboard smoke\n");
  const db = openDb({ path: dbPath });
  const mainAgentId = randomUUID();
  const provisionalAgentId = randomUUID();

  insertAgent(db, {
    agentId: mainAgentId,
    slug: "market-main-low",
    displayName: "Market Main Low",
    createdAt: "2026-06-12T09:00:00Z",
  });
  insertAgent(db, {
    agentId: provisionalAgentId,
    slug: "market-provisional-high",
    displayName: "Market Provisional High",
    createdAt: "2026-06-12T09:01:00Z",
  });

  for (let i = 0; i < MIN_RESOLVED_CALLS_FOR_MAIN_TIER; i++) {
    insertResolvedCall(db, {
      agentId: mainAgentId,
      slug: "market-main-low",
      callScore: 0,
      outcome: "loss",
      acceptedAt: `2026-06-12T09:${String(i).padStart(2, "0")}:00Z`,
      index: i,
      marketId: "eth.1h",
    });
  }
  insertResolvedCall(db, {
    agentId: provisionalAgentId,
    slug: "market-provisional-high",
    callScore: 1,
    outcome: "win",
    acceptedAt: "2026-06-12T09:30:00Z",
    index: 0,
    marketId: "eth.1h",
  });
  insertResolvedCall(db, {
    agentId: mainAgentId,
    slug: "market-main-low",
    callScore: 1,
    outcome: "win",
    acceptedAt: "2026-06-12T09:45:00Z",
    index: 100,
    marketId: "eth.4h",
  });

  const topOnly = getLeaderboardForMarket(db, {
    market_id: "eth.1h",
    limit: 1,
  });
  assert.equal(topOnly.length, 1);
  assert.equal(topOnly[0]?.agent_id, mainAgentId);
  assert.equal(topOnly[0]?.market_main_tier, true);

  const mainTier = getLeaderboardForMarket(db, {
    market_id: "eth.1h",
    tier: "main",
    limit: 10,
  });
  assert.deepEqual(mainTier.map((row) => row.agent_id), [mainAgentId]);

  const provisionalTier = getLeaderboardForMarket(db, {
    market_id: "eth.1h",
    tier: "provisional",
    limit: 10,
  });
  assert.deepEqual(
    provisionalTier.map((row) => row.agent_id),
    [provisionalAgentId],
  );

  const grid = getAgentMarketGrid(db, mainAgentId);
  assert.ok(grid.length >= 2);
  const ethGridRow = grid.find((row) => row.market_id === "eth.1h");
  assert.ok(ethGridRow);
  // Per-market trend series is now projected (chronological resolved scores).
  // mainAgent on eth.1h resolved MIN_RESOLVED_CALLS_FOR_MAIN_TIER losses
  // (score 0), so the series is that many zeros — and it feeds the sparkline.
  assert.ok(Array.isArray(ethGridRow.call_scores));
  assert.equal(ethGridRow.call_scores.length, MIN_RESOLVED_CALLS_FOR_MAIN_TIER);
  assert.ok(ethGridRow.call_scores.every((s) => s === 0));
  const limitedGrid = getAgentMarketGrid(db, mainAgentId, { limit: 1 });
  assert.equal(limitedGrid.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(limitedGrid[0], "_sortKey"),
    false,
  );

  // Call-site policy pin: per-market boards sort by the LOWER-BOUND score
  // (preferLowerBound:true). Mirror of leaderboard.smoke's global pin with the
  // OPPOSITE expected winner — a swap to raw-sorting would flip this:
  //   rawWinner [1.0,0.6] → verdict_score 0.6,  verdict_score_lb ≈ 0.471
  //   lbWinner  [0.55,0.55]→ verdict_score 0.55, verdict_score_lb 0.55
  // Market (lb): lbWinner(0.55) > rawWinner(0.471) → lbWinner ranks first.
  const mktRawWinnerId = randomUUID();
  const mktLbWinnerId = randomUUID();
  insertAgent(db, {
    agentId: mktRawWinnerId,
    slug: "mkt-raw-winner",
    displayName: "Market Raw Winner",
    createdAt: "2026-06-12T09:00:00Z",
  });
  insertAgent(db, {
    agentId: mktLbWinnerId,
    slug: "mkt-lb-winner",
    displayName: "Market LB Winner",
    createdAt: "2026-06-12T09:00:00Z",
  });
  [1.0, 0.6].forEach((score, i) =>
    insertResolvedCall(db, {
      agentId: mktRawWinnerId,
      slug: "mkt-raw-winner",
      callScore: score,
      outcome: score >= 0.5 ? "win" : "loss",
      acceptedAt: "2026-06-12T09:00:00Z",
      index: i,
      marketId: "btc.1h",
    }),
  );
  [0.55, 0.55].forEach((score, i) =>
    insertResolvedCall(db, {
      agentId: mktLbWinnerId,
      slug: "mkt-lb-winner",
      callScore: score,
      outcome: "win",
      acceptedAt: "2026-06-12T09:00:00Z",
      index: i,
      marketId: "btc.1h",
    }),
  );
  const btcBoard = getLeaderboardForMarket(db, { market_id: "btc.1h" });
  const mktRawIdx = btcBoard.findIndex((r) => r.agent_id === mktRawWinnerId);
  const mktLbIdx = btcBoard.findIndex((r) => r.agent_id === mktLbWinnerId);
  assert.ok(mktRawIdx >= 0 && mktLbIdx >= 0, "both divergent market agents present");
  assert.ok(
    mktLbIdx < mktRawIdx,
    "market board sorts by verdict_score_lb → lbWinner outranks rawWinner",
  );

  // Batched markets-grid read: ONE query per every market, and each market's
  // ranked rows must match its single-market board exactly (same aggregation,
  // same lower-bound ranking policy) — the whole point of the collapse.
  const gridBatched = getLeaderboardForMarkets(db);
  const gridByMarket = new Map(gridBatched.map((e) => [e.market_id, e.agents]));
  assert.ok(
    gridByMarket.has("eth.1h") &&
      gridByMarket.has("eth.4h") &&
      gridByMarket.has("btc.1h"),
    "batched grid surfaces every market with scoring calls",
  );
  const singleEth = getLeaderboardForMarket(db, { market_id: "eth.1h", limit: 3 });
  assert.deepEqual(
    gridByMarket.get("eth.1h")?.map((r) => r.agent_id),
    singleEth.map((r) => r.agent_id),
    "batched eth.1h rows match the single-market board top-3",
  );
  // Rows carry the same projected fields as the per-market board.
  const ethGridRow0 = gridByMarket.get("eth.1h")?.[0];
  assert.ok(ethGridRow0 && Array.isArray(ethGridRow0.call_scores));
  assert.equal(
    Object.prototype.hasOwnProperty.call(ethGridRow0, "_sortKey"),
    false,
    "batched rows drop the internal sort key",
  );
  // Per-market lower-bound ordering is preserved in the batched read.
  const gridBtc = gridByMarket.get("btc.1h") ?? [];
  const gRawIdx = gridBtc.findIndex((r) => r.agent_id === mktRawWinnerId);
  const gLbIdx = gridBtc.findIndex((r) => r.agent_id === mktLbWinnerId);
  assert.ok(
    gLbIdx >= 0 && gRawIdx >= 0 && gLbIdx < gRawIdx,
    "batched grid ranks btc.1h by verdict_score_lb",
  );
  // limitPerMarket caps rows PER MARKET.
  const cappedGrid = getLeaderboardForMarkets(db, { limitPerMarket: 1 });
  assert.ok(
    cappedGrid.every((e) => e.agents.length <= 1),
    "limitPerMarket caps each market's rows",
  );

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("market scoped leaderboard smoke ok\n");

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
