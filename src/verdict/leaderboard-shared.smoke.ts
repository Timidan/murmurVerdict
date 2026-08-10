import { strict as assert } from "node:assert";

import {
  meetsMainTierThreshold,
  publicRankedLeaderboardRows,
  rankedLeaderboardRows,
  resolveTierAndSort,
} from "./leaderboard-shared.js";
import { MIN_RESOLVED_CALLS_FOR_MAIN_TIER } from "./schema.js";

process.stdout.write("murmur leaderboard rank bands smoke\n");

// ── meetsMainTierThreshold + resolveTierAndSort (the shared tier/sort seam) ──
// Pins the single MAIN-tier threshold + the two sort-key policies that the
// global / market / family boards route through.
assert.equal(MIN_RESOLVED_CALLS_FOR_MAIN_TIER, 20);
assert.equal(meetsMainTierThreshold(19), false, "below threshold");
assert.equal(meetsMainTierThreshold(20), true, "at threshold (>=)");
assert.equal(meetsMainTierThreshold(21), true, "above threshold");

// preferLowerBound:false (global board) → sorts by RAW verdict_score, ignoring lb.
{
  const r = resolveTierAndSort(
    { resolved_calls: 25, verdict_score: 0.4, verdict_score_lb: 0.1 },
    { preferLowerBound: false },
  );
  assert.equal(r.mainTier, true);
  assert.equal(r.sortKey, 0.4);
}
// preferLowerBound:true (market/family boards) → prefers verdict_score_lb.
{
  const r = resolveTierAndSort(
    { resolved_calls: 3, verdict_score: 0.4, verdict_score_lb: 0.1 },
    { preferLowerBound: true },
  );
  assert.equal(r.mainTier, false, "3 resolved < 20");
  assert.equal(r.sortKey, 0.1, "lb preferred when present");
}
// preferLowerBound:true but lb null → falls back to verdict_score.
{
  const r = resolveTierAndSort(
    { resolved_calls: 20, verdict_score: 0.4, verdict_score_lb: null },
    { preferLowerBound: true },
  );
  assert.equal(r.sortKey, 0.4, "lb null → verdict_score");
}
// both scores null → -Infinity (sorts last), either policy.
assert.equal(
  resolveTierAndSort(
    { resolved_calls: 0, verdict_score: null, verdict_score_lb: null },
    { preferLowerBound: false },
  ).sortKey,
  -Infinity,
);
assert.equal(
  resolveTierAndSort(
    { resolved_calls: 0, verdict_score: null, verdict_score_lb: null },
    { preferLowerBound: true },
  ).sortKey,
  -Infinity,
);

type TestRow = {
  id: string;
  main: boolean;
  rank: number | null;
  _sortKey: number;
};

const rows: TestRow[] = [
  { id: "provisional-high", main: false, rank: null, _sortKey: 100 },
  { id: "main-low", main: true, rank: null, _sortKey: 1 },
  { id: "main-high", main: true, rank: null, _sortKey: 2 },
];

const ordered = rankedLeaderboardRows(rows, {
  isMain: (row) => row.main,
  onMainRank: (row, index) => {
    row.rank = index + 1;
  },
});
assert.deepEqual(ordered.map((row) => row.id), [
  "main-high",
  "main-low",
  "provisional-high",
]);
assert.deepEqual(
  ordered.filter((row) => row.main).map((row) => row.rank),
  [1, 2],
);

const provisionalOnly = rankedLeaderboardRows(rows, {
  tier: "provisional",
  isMain: (row) => row.main,
});
assert.deepEqual(provisionalOnly.map((row) => row.id), ["provisional-high"]);

const publicRows = publicRankedLeaderboardRows(ordered);
assert.equal("_sortKey" in publicRows[0]!, false);
assert.deepEqual(publicRows.map((row) => row.id), [
  "main-high",
  "main-low",
  "provisional-high",
]);

process.stdout.write("leaderboard rank bands smoke ok\n");
