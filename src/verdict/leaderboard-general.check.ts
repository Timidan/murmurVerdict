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
} from "./db.js";
import {
  getCrossFamilyLeaderboard,
  getLeaderboard,
} from "./leaderboard.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-leaderboard-general-"));

try {
  const db = openDb({ path: join(tmp, "test.db") });
  const stable = randomUUID();
  const lucky = randomUUID();

  agentsRepo.insert(db, {
    agent_id: stable,
    display_slug: "stable-agent",
    kind: "agent",
    display_name: "Stable Agent",
    created_at: "2026-06-20T00:00:00Z",
  });
  agentsRepo.insert(db, {
    agent_id: lucky,
    display_slug: "lucky-agent",
    kind: "agent",
    display_name: "Lucky Agent",
    created_at: "2026-06-20T00:00:00Z",
  });

  // Both fixture families are EXTERNAL venue families — Murmur never authors
  // a market, so a cross-family board is "binary venue markets vs categorical
  // venue markets", not "price vs event".
  const BINARY_FAMILY = "prediction-market-binary";
  const CATEGORICAL_FAMILY = "prediction-market-categorical";
  const MARKET_ID_BY_FAMILY: Record<string, string> = {
    [BINARY_FAMILY]: `0x${"11".repeat(32)}`,
    [CATEGORICAL_FAMILY]: `0x${"22".repeat(32)}`,
  };

  function insertCall(
    agentId: string,
    n: number,
    score: number,
    marketFamily = BINARY_FAMILY,
  ): void {
    const callId = randomUUID();
    submissionsRepo.acceptSealedFhenixCall(db, {
      call_id: callId,
      agent_id: agentId,
      client_order_id: `${agentId}-${marketFamily}-${n}`,
      horizon_seconds: 3600,
      submitted_at: "2026-06-20T00:00:00Z",
      accepted_at: `2026-06-20T00:${String(n).padStart(2, "0")}:00Z`,
      schema_version: 1,
      scoring_version: 1,
      dedup_key: `${agentId}-${marketFamily}-${n}`,
      commit_hash: "a".repeat(64),
      commit_scheme: "fhenix-sealed-v1",
      market_id: MARKET_ID_BY_FAMILY[marketFamily]!,
      market_config_version: 1,
      adapter_id: "polymarket-gamma",
      market_family: marketFamily,
    });
    resolutionsRepo.setResolution(db, {
      call_id: callId,
      t1: "2026-06-20T01:00:00Z",
      // Legacy price-anchor evidence columns; always NULL now that Murmur
      // observes no prices.
      p1: null,
      t1_feed: null,
      signed_return: null,
      outcome: score > 0 ? "win" : "loss",
      call_score: score,
      resolved_at: "2026-06-20T01:00:00Z",
    });
    submissionsRepo.setStatus(db, callId, "resolved");
  }

  for (let i = 0; i < 20; i++) insertCall(stable, i, 0.14);
  for (let i = 0; i < 19; i++) insertCall(lucky, i, 0.25);
  insertCall(lucky, 19, -0.75);

  // GLOBAL RANKS BY RAW SCORE. Highest average wins, full stop.
  //
  // This case used to assert the opposite — that `stable-agent` ranked first
  // on its better lower bound — from a plan ("Conservative Global Leaderboard
  // Ranking") whose test shipped while its code change did not. The two lived
  // in the same commit as leaderboard.smoke.ts, which pins raw, and never
  // disagreed out loud because this file was named `-check.ts`: the smoke
  // runner discovers `.check.ts`, so it was invisible to the release gate.
  //
  // The ordering is deliberately kept, and this fixture is deliberately kept
  // too: it is the case where raw and lower-bound orderings DIVERGE, so it
  // pins the global policy exactly where a silent swap would show up.
  // Market and family boards use the lower bound; global does not.
  const rows = getLeaderboard(db, { tier: "main", limit: 2 });
  assert.equal(rows[0].display_slug, "lucky-agent", "global sorts by RAW score");
  assert.equal(rows[1].display_slug, "stable-agent");
  assert.equal(
    rows[0].verdict_score! > rows[1].verdict_score!,
    true,
    "the top row has the higher raw score",
  );
  assert.equal(
    rows[0].verdict_score_lb! < rows[1].verdict_score_lb!,
    true,
    "...and the WORSE lower bound — which is what makes this fixture load-bearing",
  );

  for (let i = 0; i < 20; i++) {
    insertCall(stable, i, 0.14, CATEGORICAL_FAMILY);
  }

  const general = getCrossFamilyLeaderboard(db, { tier: "main", limit: 10 });
  assert.equal(general.length, 1);
  assert.equal(general[0].display_slug, "stable-agent");
  assert.equal(general[0].qualifying_families, 2);
  assert.equal(general[0].available_families, 2);
  assert.equal(general[0].coverage_ratio, 1);
  assert.equal(general[0].general_score, general[0].cross_family_score);
  assert.equal(
    general[0].families.every((family) => family.verdict_score_lb !== undefined),
    true,
  );

  process.stdout.write(
    "murmur leaderboard general check\n"
      + "  ok global board sorts by RAW score\n"
      + "  ok market and family boards sort by lower bound\n",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
