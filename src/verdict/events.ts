// In-process event bus for the verdict service. The /v1/stream SSE
// endpoint subscribes here; submitCall and the resolver publish here.
//
// Single instance per daemon process. Not durable, not multi-node — a
// fan-out aid only. If we ever add a second replica, replace with Redis
// pubsub or NATS; the public-facing event names below stay stable.

import { EventEmitter } from "node:events";

/** Event names exposed via SSE. Keep in sync with V14_HANDOFF.md §13. */
export const VERDICT_EVENTS = {
  call_accepted: "call.accepted",
  call_resolved: "call.resolved",
  leaderboard_update: "leaderboard.update",
  stats_tick: "stats.tick",
} as const;

export type VerdictEventName =
  (typeof VERDICT_EVENTS)[keyof typeof VERDICT_EVENTS];

export interface CallAcceptedEvent {
  type: "call.accepted";
  call_id: string;
  agent_id: string;
  agent_slug: string;
  side: "BUY" | "SELL";
  asset_id: string;
  horizon_hours: number;
  confidence: number;
  accepted_at: string;
}

export interface CallResolvedEvent {
  type: "call.resolved";
  call_id: string;
  agent_id: string;
  agent_slug: string;
  outcome: string;
  signed_return: string | null;
  call_score: number | null;
  resolved_at: string;
}

export interface LeaderboardUpdateEvent {
  type: "leaderboard.update";
  served_at: string;
  rows: Array<{
    rank: number | null;
    agent_id: string;
    display_slug: string;
    display_name: string;
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

export type VerdictEvent =
  | CallAcceptedEvent
  | CallResolvedEvent
  | LeaderboardUpdateEvent
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
}
