// In-process event bus for the verdict service. The /v1/stream SSE
// endpoint subscribes here; sealed submission routes and the resolver publish here.
//
// Single instance per daemon process. Not durable, not multi-node — a
// fan-out aid only. If we ever add a second replica, replace with Redis
// pubsub or NATS; the public-facing event names below stay stable.

import { EventEmitter } from "node:events";
import type { AgentKind } from "./schema.js";
import { type VerdictEvent, type WireAgentKind } from "../types/events.js";

// The wire shapes live in src/types/events.ts (the single source of truth,
// browser-safe so the dashboard imports the SAME types). Re-export them here
// so every existing backend importer of "./events.js" keeps working with zero
// churn — this module adds only the VerdictEventBus + node:events runtime.
export { VERDICT_EVENTS } from "../types/events.js";
export type {
  VerdictEventName,
  WireAgentKind,
  CallAcceptedEvent,
  CallResolvedEvent,
  LeaderboardEventAgentRow,
  LeaderboardUpdateEvent,
  MarketLeaderboardEventAgentRow,
  MarketsUpdateEvent,
  StatsTickEvent,
  VerdictEvent,
} from "../types/events.js";

// Compile-time guard (codex option iii): the wire `WireAgentKind` copy in
// src/types/events.ts MUST stay identical to the canonical `AgentKind`
// (schema.ts AgentKindSchema). A future enum addition makes this assertion
// fail the BACKEND build, forcing the shared wire type to be updated rather
// than silently diverging from the dashboard.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WireAgentKindMatchesAgentKind = Assert<Equals<WireAgentKind, AgentKind>>;

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
