// Shared SSE wire types for the /v1/stream event channel — the SINGLE source
// of truth consumed by BOTH the daemon (src/verdict/events.ts re-exports
// these and adds the VerdictEventBus) and the dashboard
// (dashboard/src/verdict/hooks/useStream.ts imports them via the `@shared`
// alias → ../src/types). Browser-safe by construction: wire shapes + the event-name constant
// only — NO node:events, NO EventEmitter, NO backend imports. Anything added
// here must stay free of Node-only or framework imports so the dashboard can
// compile it.

/** Event names exposed via SSE. */
export const VERDICT_EVENTS = {
  call_accepted: "call.accepted",
  call_resolved: "call.resolved",
  leaderboard_update: "leaderboard.update",
  markets_update: "markets.update",
  stats_tick: "stats.tick",
} as const;

export type VerdictEventName =
  (typeof VERDICT_EVENTS)[keyof typeof VERDICT_EVENTS];

/**
 * Agent kind on the wire. Local copy of the canonical `AgentKind`
 * (src/verdict/schema.ts `AgentKindSchema`) so this module stays
 * dependency-free; src/verdict/events.ts asserts at backend build time that
 * this union exactly equals `AgentKind`, so a future enum addition fails the
 * build rather than silently diverging.
 */
export type WireAgentKind = "benchmark" | "agent" | "internal_test" | "attested";

export interface CallAcceptedEvent {
  type: "call.accepted";
  call_id: string;
  agent_id: string;
  agent_slug: string;
  /** Canonical value is "sealed_fhenix". */
  privacy_mode: string;
  /** Public binding over the Fhenix submit-event metadata. */
  commit_hash?: string;
  /** Retained for older clients; always null. */
  acceptance_receipt_hash?: string;
  accepted_at: string;
  // Polymarket and other
  // non-native-price adapters land on the same SSE channel; subscribers
  // use these to route render without inferring from the optional
  // plaintext block. NEVER load-bearing for any privacy guarantee.
  // Emitters default missing values to 'native-price' / 'financial-direction'
  // (the MIGRATION_016 backfill semantic), so in practice subscribers
  // will see these fields on every event — they're typed optional so
  // older consumers reading historical wire bytes don't break.
  adapter_id?: string;
  market_family?: string;
  market_id?: string;
  // Kept optional for older clients. Sealed Fhenix call.accepted events
  // omit these so SSE subscribers + webhook bridges cannot front-run a
  // pending call.
  side?: "BUY" | "SELL";
  asset_id?: string;
  horizon_hours?: number;
  confidence?: number;
}

export interface CallResolvedEvent {
  type: "call.resolved";
  call_id: string;
  agent_id: string;
  agent_slug: string;
  outcome: string;
  /** Native-price markets emit a string-decimal return (e.g. "0.0034"
   *  for +0.34%). Non-native adapters (Polymarket and any future
   *  prediction-market-binary, event-binary, etc. family) MUST omit
   *  this field — the concept doesn't apply. Consumers guard with
   *  truthiness before formatting, so an omitted field renders as no
   *  return rather than "null %" or "0%". */
  signed_return?: string | null;
  call_score: number | null;
  resolved_at: string;
  // See CallAcceptedEvent.
  adapter_id?: string;
  market_family?: string;
  market_id?: string;
  // universal payout-vector additive fields. Populated only when
  // the resolver dispatched through an adapter that produced the v2 outcome
  // shape. Legacy subscribers reading just `outcome`/`call_score` keep working.
  /** Wire-shape Outcome (kind + payoutNumerators stringified +
   *  payoutDenominator stringified + evidence). Undefined when the resolver
   *  fell through to legacy-only resolution. */
  resolved_outcome?: unknown;
  /** Convenience copy of resolved_outcome.payoutNumerators (string array,
   *  bigints stringified). Undefined when v2 path didn't run. */
  payout_vector?: string[];
}

export interface LeaderboardEventAgentRow {
  rank: number | null;
  agent_id: string;
  display_slug: string;
  display_name: string;
  /**
   * Lets dashboards distinguish wallet_only / verified / benchmark
   * agents in the SSE delta path without a refetch.
   */
  kind: WireAgentKind;
  verdict_score: number | null;
  win_rate: number | null;
  resolved_calls: number;
  pending_calls: number;
}

export interface LeaderboardUpdateEvent {
  type: "leaderboard.update";
  served_at: string;
  rows: LeaderboardEventAgentRow[];
}

export interface MarketLeaderboardEventAgentRow
  extends Omit<LeaderboardEventAgentRow, "rank"> {
  market_id: string;
  market_main_tier: boolean;
}

export interface MarketsUpdateEvent {
  type: "markets.update";
  market_id: string;
  served_at: string;
  agents: MarketLeaderboardEventAgentRow[];
}

export interface StatsTickEvent {
  type: "stats.tick";
  served_at: string;
  accepted_24h: number;
  resolved_24h: number;
  wins_24h: number;
  losses_24h: number;
  void_24h: number;
}

export type VerdictEvent =
  | CallAcceptedEvent
  | CallResolvedEvent
  | LeaderboardUpdateEvent
  | MarketsUpdateEvent
  | StatsTickEvent;
