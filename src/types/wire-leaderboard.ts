// Shared REST wire types: leaderboards (global, per-market, per-family, cross-family).
// Browser-safe; see wire-agent.ts.

import type { WireAgentKind } from "./wire-agent.js";

export type WireLeaderboardTier = "main" | "provisional";

/** One row of GET /v1/leaderboard. Mirrors the daemon's `LeaderboardRow`. */
export interface WireLeaderboardRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: WireAgentKind;
  tier: WireLeaderboardTier;
  rank: number | null;
  verdict_score: number | null;
  verdict_score_lb: number | null;
  resolved_calls: number;
  win_rate: number | null;
  pending_calls: number;
  last_resolved_at: string | null;
  // Optional: REST rows carry these, lean SSE deltas do not.
  /** agent_reveals / (agent_reveals + daemon_fallback_reveals + misses). */
  reveal_reliability?: number | null;
  agent_reveals?: number;
  daemon_fallback_reveals?: number;
  marketplace_eligible?: boolean;
  /** Reserved; currently 0 / null. */
  operator_trust_score?: number | null;
  stake_at_risk?: string | null;
}

/** One row of GET /v1/families/:family/leaderboard. */
export interface WireAgentFamilyRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: WireAgentKind;
  market_family: string;
  verdict_score: number | null;
  verdict_score_lb: number | null;
  resolved_calls: number;
  pending_calls: number;
  win_rate: number | null;
  last_resolved_at: string | null;
  family_main_tier: boolean;
  distinct_markets: number;
}

/** One row of GET /v1/leaderboard/general. */
export interface WireAgentCrossFamilyRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: WireAgentKind;
  cross_family_score: number | null;
  general_score: number | null;
  families: Array<{
    market_family: string;
    verdict_score: number | null;
    verdict_score_lb: number | null;
    resolved_calls: number;
    qualifies: boolean;
  }>;
  qualifying_families: number;
  available_families: number;
  coverage_ratio: number;
  cross_family_main_tier: boolean;
}

/** One row of GET /v1/markets/:market_id/leaderboard and the cells of GET /v1/agents/:slug/grid. */
export interface WireAgentMarketRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: WireAgentKind;
  market_id: string;
  verdict_score: number | null;
  verdict_score_lb: number | null;
  resolved_calls: number;
  pending_calls: number;
  win_rate: number | null;
  last_resolved_at: string | null;
  /** resolved_calls >= MAIN tier threshold at this market. */
  market_main_tier: boolean;
  /** Chronological per-call scores (null = void / oracle_unavailable). Absent on lean SSE deltas. */
  call_scores?: (number | null)[];
  /**
   * The market's question, e.g. "XRP Up or Down - August 24, 5:25AM-5:30AM ET".
   * Null for native price markets and deleted rows; fall back to the id.
   */
  market_label?: string | null;
}
