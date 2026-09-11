// Shared REST wire types — leaderboard surfaces (global, per-market,
// per-family, cross-family). Browser-safe; see wire-agent.ts for the rules.
// Producer guards in src/verdict/wire-contract-guards.ts pin each of these
// against the daemon's authoritative type.

import type { WireAgentKind } from "./wire-agent.js";

export type WireLeaderboardTier = "main" | "provisional";

/** One row of GET /v1/leaderboard. Mirrors the daemon's zod-inferred
 *  `LeaderboardRow` (src/verdict/schema.ts LeaderboardRowSchema) exactly —
 *  including the reserved reveal-reliability / marketplace / trust axes the
 *  daemon emits on every row. */
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
  // The daemon emits the reserved reveal-reliability / marketplace / trust axes
  // on every row, but the dashboard also BUILDS partial rows from the SSE delta
  // (hooks/stream-merge.ts), which has no such fields — so they are optional
  // here and the producer guard pins the daemon output via `Conforms`.
  /** Reveal reliability = non-daemon reveals / (non-daemon + daemon-fallback +
   *  genuine misses). `agent_reveals` counts reveals published without the
   *  murmur fallback; `daemon_fallback_reveals` counts reveals the murmur-owned
   *  fallback worker guaranteed. */
  reveal_reliability?: number | null;
  agent_reveals?: number;
  daemon_fallback_reveals?: number;
  marketplace_eligible?: boolean;
  /** RESERVED axes for v0.3+ (currently 0 / null). */
  operator_trust_score?: number | null;
  stake_at_risk?: string | null;
}

/** One row of GET /v1/families/:family/leaderboard. Mirrors the daemon's
 *  AgentFamilyRow (src/verdict/leaderboard-families.ts). */
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

/** One row of GET /v1/leaderboard/general. Mirrors the daemon's
 *  AgentCrossFamilyRow (src/verdict/leaderboard-families.ts). */
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

/** One row of GET /v1/markets/:market_id/leaderboard and the cells of
 *  GET /v1/agents/:slug/grid. Mirrors the daemon's AgentMarketRow
 *  (src/verdict/leaderboard-markets.ts). */
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
  /** Chronological per-call score series (nulls mark void /
   *  oracle_unavailable resolutions), powering the trend sparkline. Optional:
   *  the daemon always emits it, but the dashboard also carries forward a
   *  possibly-absent value on the SSE merge path (hooks/stream-merge.ts). */
  call_scores?: (number | null)[];
  /**
   * The market's own question, e.g. "XRP Up or Down - August 24,
   * 5:25AM-5:30AM ET" — the same string the market page uses as its title.
   *
   * Here because `market_id` is a 66-character hex condition id, and an agent
   * profile listing forty-seven of them tells a reader nothing about what the
   * agent actually called. Null for native price markets (no config_json) and
   * for any market row that has since been deleted; renderers must fall back
   * to the id. Optional on the wire so an older daemon still type-checks.
   */
  market_label?: string | null;
}
