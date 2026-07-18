// Pure "streamed lean row + prior REST-hydrated row → display row" merge
// primitives, one per SSE event type.
//
// SSE deltas carry only the lean wire fields (see events.ts). REST-only fields
// — verdict_score_lb, call_scores, last_resolved_at — are NOT present on a
// stream row, so a naive overwrite would blank them on every live tick. These
// helpers fold the streamed wire fields onto the prior REST row keyed by
// agent_id, PRESERVING the REST-only fields the stream can't supply.
//
// Consumers own the per-agent lookup (a Map by agent_id) and call the matching
// helper inside their `.map()` so the merge policy lives in exactly one place.

import type {
  LeaderboardEventAgentRow,
  MarketLeaderboardEventAgentRow,
} from "@shared/events";
import type { LeaderboardRow, AgentMarketRow } from "./../api.js";

/**
 * Global-leaderboard merge (`leaderboard.update`). Tier is derived from the
 * streamed rank (ranked ⇒ main); verdict_score_lb + last_resolved_at are
 * preserved from the prior REST row because the public event fan-out omits
 * them.
 */
export function mergeLeaderboardRow(
  streamed: LeaderboardEventAgentRow,
  prior: LeaderboardRow | undefined,
): LeaderboardRow {
  return {
    agent_id: streamed.agent_id,
    display_slug: streamed.display_slug,
    display_name: streamed.display_name,
    kind: streamed.kind,
    tier: streamed.rank ? "main" : "provisional",
    rank: streamed.rank,
    verdict_score: streamed.verdict_score,
    verdict_score_lb: prior?.verdict_score_lb ?? null,
    resolved_calls: streamed.resolved_calls,
    win_rate: streamed.win_rate,
    pending_calls: streamed.pending_calls,
    last_resolved_at: prior?.last_resolved_at ?? null,
  };
}

/**
 * Per-market-leaderboard merge (`markets.update`). The streamed wire fields
 * (incl. market_id + market_main_tier) win; verdict_score_lb (lb column),
 * last_resolved_at, and call_scores (trend sparkline) are preserved from the
 * prior REST row so a live tick never blanks the rendered REST-only columns.
 */
export function mergeMarketAgentRow(
  streamed: MarketLeaderboardEventAgentRow,
  prior: AgentMarketRow | undefined,
): AgentMarketRow {
  return {
    ...streamed,
    verdict_score_lb: prior?.verdict_score_lb ?? null,
    last_resolved_at: prior?.last_resolved_at ?? null,
    call_scores: prior?.call_scores,
  };
}
