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

  function insertCall(
    agentId: string,
    n: number,
    score: number,
    marketFamily = "financial-direction",
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
      market_id: "eth.1h",
      market_config_version: 1,
      adapter_id: "native-price",
      market_family: marketFamily,
    });
    resolutionsRepo.setResolution(db, {
      call_id: callId,
      t1: "2026-06-20T01:00:00Z",
      p1: "100",
      t1_feed: "chainlink:base:ETH-USD",
      signed_return: "0.01",
      outcome: score > 0 ? "win" : "loss",
      call_score: score,
      resolved_at: "2026-06-20T01:00:00Z",
    });
    submissionsRepo.setStatus(db, callId, "resolved");
  }

  for (let i = 0; i < 20; i++) insertCall(stable, i, 0.14);
  for (let i = 0; i < 19; i++) insertCall(lucky, i, 0.25);
  insertCall(lucky, 19, -0.75);

  const rows = getLeaderboard(db, { tier: "main", limit: 2 });
  assert.equal(rows[0].display_slug, "stable-agent");
  assert.equal(rows[1].display_slug, "lucky-agent");
  assert.equal(rows[0].verdict_score! < rows[1].verdict_score!, true);
  assert.equal(rows[0].verdict_score_lb! > rows[1].verdict_score_lb!, true);

  for (let i = 0; i < 20; i++) {
    insertCall(stable, i, 0.14, "prediction-market-binary");
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
    "murmur leaderboard general check\n  ok global board sorts by lower bound\n",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
