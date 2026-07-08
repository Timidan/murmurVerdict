import type Database from "better-sqlite3";
import type { VerdictEventBus } from "./events.js";
import { publicResolutionFanoutEvents } from "./public-event-fanout.js";

export interface ResolutionFanoutDeps {
  db: Database.Database;
  events: VerdictEventBus;
  now: () => Date;
}

/**
 * Build the resolver completion hook that fans terminal Sealed Calls out to
 * public SSE subscribers. The resolver owns state transitions; this Module
 * owns the read-side deltas those transitions produce.
 */
export function createResolutionFanout(
  deps: ResolutionFanoutDeps,
): (call_id: string) => Promise<void> {
  const { db, events, now } = deps;

  return async (call_id: string) => {
    try {
      for (const event of publicResolutionFanoutEvents({
        db,
        call_id,
        servedAt: now(),
      })) {
        events.emit(event);
      }
    } catch (err) {
      console.warn(`[daemon] sse fan-out failed for ${call_id}:`, err);
    }
  };
}
