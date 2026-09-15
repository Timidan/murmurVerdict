// In-process event bus: /v1/stream SSE subscribes; sealed submission routes and the resolver publish.
// One per daemon process; not durable or multi-node.

import { EventEmitter } from "node:events";
import type { AgentKind } from "./schema.js";
import { type VerdictEvent, type WireAgentKind } from "../types/events.js";

// Wire shapes live in src/types/events.ts (shared with the dashboard); re-exported for backend importers.
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

// Compile-time guard: WireAgentKind must equal schema.ts AgentKind, so an enum addition fails the backend build.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WireAgentKindMatchesAgentKind = Assert<Equals<WireAgentKind, AgentKind>>;

/** Typed EventEmitter wrapper. maxListeners is high so a large SSE fan-out doesn't warn. */
export class VerdictEventBus {
  private readonly emitter = new EventEmitter();

  constructor(maxListeners = 1024) {
    this.emitter.setMaxListeners(maxListeners);
  }

  emit(event: VerdictEvent): void {
    // Single '*' channel; subscribers filter client-side.
    this.emitter.emit("*", event);
  }

  /** Returns an unsubscribe function. */
  subscribe(handler: (event: VerdictEvent) => void): () => void {
    this.emitter.on("*", handler);
    return () => this.emitter.off("*", handler);
  }

  /** Live subscriber count, for spotting SSE leaks in /v1/health. */
  subscriberCount(): number {
    return this.emitter.listenerCount("*");
  }
}
