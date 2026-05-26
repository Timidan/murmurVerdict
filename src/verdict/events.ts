// In-process event bus for the verdict service. The /v1/stream SSE
// endpoint subscribes here; sealed submission routes and the resolver publish here.
//
// Single instance per daemon process. Not durable, not multi-node — a
// fan-out aid only. If we ever add a second replica, replace with Redis
// pubsub or NATS; the public-facing event names below stay stable.

import type Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import {
  getLeaderboardForMarket,
  type AgentMarketRow,
} from "./leaderboard.js";
import type { AgentKind } from "./schema.js";

/** Event names exposed via SSE. Keep in sync with V14_HANDOFF.md §13. */
export const VERDICT_EVENTS = {
  call_accepted: "call.accepted",
  call_resolved: "call.resolved",
  leaderboard_update: "leaderboard.update",
  markets_update: "markets.update",
  stats_tick: "stats.tick",
} as const;

export type VerdictEventName =
  (typeof VERDICT_EVENTS)[keyof typeof VERDICT_EVENTS];

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
  // Phase 10 / Z4-extra discriminators — Polymarket and other
  // non-native-price adapters land on the same SSE channel; subscribers
  // use these to route render without inferring from the optional
  // plaintext block. NEVER load-bearing for any privacy guarantee.
  // Emitters default missing values to 'native-price' / 'financial-direction'
  // (the MIGRATION_016 backfill semantic), so in practice subscribers
  // will see these fields on every event — they're typed optional so
  // older consumers reading historical wire bytes don't break, and so
  // backend authors of new emitters aren't forced to populate them at
  // call sites where the adapter is genuinely unknowable (none today).
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
   *  this field — the concept doesn't apply (codex P11 Drift C). The
   *  dashboard / RSS / webhook consumers already guard with truthiness
   *  before formatting, so an omitted field renders as no return rather
   *  than "null %" or "0%". */
  signed_return?: string | null;
  call_score: number | null;
  resolved_at: string;
  // Phase 10 / Z4-extra discriminators — see CallAcceptedEvent for the
  // routing rationale. Subscribers can branch on adapter_id /
  // market_family without re-querying.
  adapter_id?: string;
  market_family?: string;
  market_id?: string;
  // Phase 5 — universal payout-vector additive fields. Populated only when
  // the resolver dispatched through an adapter that produced the v2 outcome
  // shape (today: native-price for every market). Legacy SSE / webhook
  // subscribers that read just `outcome` / `call_score` continue to work
  // unchanged; new clients can read `resolved_outcome` / `payout_vector` to
  // pick up the universal shape without a refetch.
  /** Wire-shape Outcome (kind + payoutNumerators stringified +
   *  payoutDenominator stringified + evidence). Same shape as
   *  `t1_resolutions.resolved_outcome_json`. Undefined when the resolver
   *  fell through to legacy-only resolution. */
  resolved_outcome?: unknown;
  /** Convenience copy of resolved_outcome.payoutNumerators (string array,
   *  bigints stringified). Undefined when v2 path didn't run. */
  payout_vector?: string[];
}

export interface LeaderboardUpdateEvent {
  type: "leaderboard.update";
  served_at: string;
  rows: Array<{
    rank: number | null;
    agent_id: string;
    display_slug: string;
    display_name: string;
    /**
     * Lets dashboards distinguish wallet_only / verified / benchmark
     * agents in the SSE delta path without a refetch. Earlier versions
     * dropped this field, so the dashboard had to hardcode "verified"
     * for streamed rows — wallet_only agents got mislabeled.
     */
    kind: AgentKind;
    verdict_score: number | null;
    win_rate: number | null;
    resolved_calls: number;
    pending_calls: number;
  }>;
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

/**
 * Per-market top-N snapshot. Fired alongside `leaderboard.update` whenever a
 * t1 resolution lands on a market — lets per-market dashboard surfaces stay
 * in sync without polling every market's REST endpoint.
 *
 * Subscribers should filter by `market_id` to scope to the market they're
 * displaying. Legacy submissions without a market_id never trigger this
 * event (the daemon emits market-scoped events only when a market is known).
 */
export interface MarketsUpdateEvent {
  type: "markets.update";
  market_id: string;
  served_at: string;
  agents: AgentMarketRow[];
}

export type VerdictEvent =
  | CallAcceptedEvent
  | CallResolvedEvent
  | LeaderboardUpdateEvent
  | MarketsUpdateEvent
  | StatsTickEvent;

/**
 * Typed wrapper around node's EventEmitter. The emitter supports many
 * subscribers; we set a permissive maxListeners so a heavy SSE fan-out
 * (e.g. 200 concurrent dashboard tabs) doesn't trigger noisy warnings.
 */
export class VerdictEventBus {
  private readonly emitter = new EventEmitter();

  constructor(maxListeners = 1024) {
    this.emitter.setMaxListeners(maxListeners);
  }

  emit(event: VerdictEvent): void {
    // Single channel ('*') for fan-out so subscribers can multiplex
    // without juggling N event names. Subscribers filter client-side.
    this.emitter.emit("*", event);
  }

  /** Returns an unsubscribe function. */
  subscribe(handler: (event: VerdictEvent) => void): () => void {
    this.emitter.on("*", handler);
    return () => this.emitter.off("*", handler);
  }

  /**
   * Total live subscribers. Useful for /v1/health diagnostics so we
   * notice if SSE clients leak.
   */
  subscriberCount(): number {
    return this.emitter.listenerCount("*");
  }

  /**
   * Convenience: snapshot the per-market top-5 leaderboard and fan it out as
   * a `markets.update` SSE event. Called from the resolver's success path
   * right next to the global `leaderboard.update` emission so both deltas
   * land in the same tick.
   *
   * Best-effort — if `getLeaderboardForMarket` throws (e.g. a transient DB
   * lock), we log and swallow. The resolver MUST NOT fail because of a
   * stats fan-out hiccup; the next resolution's emit will catch the
   * dashboard up.
   */
  emitMarketsUpdate(db: Database.Database, market_id: string): void {
    try {
      const agents = getLeaderboardForMarket(db, { market_id, limit: 5 });
      this.emit({
        type: "markets.update",
        market_id,
        served_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        agents,
      });
    } catch (err) {
      console.warn(
        `[events] markets.update emit failed for ${market_id}:`,
        err,
      );
    }
  }
}
