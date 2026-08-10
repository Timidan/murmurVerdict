import { strict as assert } from "node:assert";

import { leaderboardCallSummary } from "./leaderboard-call-summary.js";

process.stdout.write("murmur leaderboard call summary smoke\n");

const summary = leaderboardCallSummary([
  {
    status: "resolved",
    outcome: "win",
    call_score: 0.8,
    resolved_at: "2026-06-12T10:00:00Z",
  },
  {
    status: "resolved",
    outcome: "loss",
    call_score: -0.2,
    resolved_at: "2026-06-12T11:00:00Z",
  },
  {
    status: "resolved",
    outcome: "void",
    call_score: null,
    resolved_at: "2026-06-12T12:00:00Z",
  },
  {
    status: "pending_t1",
    outcome: null,
    call_score: null,
  },
  {
    status: "accepted",
    outcome: null,
    call_score: null,
  },
]);

assert.equal(summary.resolved_calls, 2);
assert.equal(summary.pending_calls, 2);
assert.equal(summary.win_rate, 0.5);
assert.equal(summary.last_resolved_at, "2026-06-12T12:00:00Z");
assert.equal(typeof summary.verdict_score, "number");
assert.equal(typeof summary.verdict_score_lb, "number");
// Chronological resolved-call series: win→0.8, loss→-0.2, void→null
// (pending/accepted are not resolved and contribute no entry).
assert.deepEqual(summary.call_scores, [0.8, -0.2, null]);

const empty = leaderboardCallSummary([]);
assert.deepEqual(empty, {
  verdict_score: null,
  verdict_score_lb: null,
  resolved_calls: 0,
  pending_calls: 0,
  win_rate: null,
  last_resolved_at: null,
  call_scores: [],
});

process.stdout.write("leaderboard call summary smoke ok\n");
