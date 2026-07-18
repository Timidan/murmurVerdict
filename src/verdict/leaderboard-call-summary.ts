import { computeVerdictScore } from "./scoring.js";
import {
  isPendingLeaderboardStatus,
  type LeaderboardCallFact,
} from "./leaderboard-call-facts.js";

// The scoring-facts row shape and status vocabulary now live in the
// leaderboard-call-facts Module; re-exported here so existing consumers of the
// summary seam keep importing the fact type from one place.
export type { LeaderboardCallFact } from "./leaderboard-call-facts.js";

export interface LeaderboardCallSummary {
  verdict_score: number | null;
  verdict_score_lb: number | null;
  resolved_calls: number;
  pending_calls: number;
  win_rate: number | null;
  last_resolved_at: string | null;
  /**
   * Chronological resolved-call score series (input/accepted_at order), with
   * `null` for void / oracle_unavailable. Powers the per-market trend
   * sparkline. Already computed for the verdict score; exposed so the market /
   * agent-grid Records can project it without recomputing. UI consumers filter
   * the nulls before rendering (CompactSparkline takes number[]).
   */
  call_scores: (number | null)[];
}

export function leaderboardCallSummary(
  calls: Iterable<LeaderboardCallFact>,
): LeaderboardCallSummary {
  const call_scores: (number | null)[] = [];
  let wins = 0;
  let losses = 0;
  let pending_calls = 0;
  let last_resolved_at: string | null = null;

  for (const call of calls) {
    if (call.outcome === "win") {
      wins++;
      call_scores.push(call.call_score);
    } else if (call.outcome === "loss") {
      losses++;
      call_scores.push(call.call_score);
    } else if (
      call.outcome === "void" ||
      call.outcome === "oracle_unavailable"
    ) {
      call_scores.push(null);
    } else if (isPendingLeaderboardStatus(call.status)) {
      pending_calls++;
    }
    if (call.resolved_at) {
      if (!last_resolved_at || call.resolved_at > last_resolved_at) {
        last_resolved_at = call.resolved_at;
      }
    }
  }

  const score = computeVerdictScore(call_scores);
  return {
    verdict_score: score.verdict_score,
    verdict_score_lb: score.verdict_score_lb,
    resolved_calls: score.resolved_calls,
    pending_calls,
    win_rate: wins + losses > 0 ? wins / (wins + losses) : null,
    last_resolved_at,
    call_scores,
  };
}
