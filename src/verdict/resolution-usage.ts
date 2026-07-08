import {
  type UsageEvent,
} from "./schema.js";
import { makeUsageEvent } from "./usage-event.js";

export function makeResolutionUsage(
  agent_id: string,
  kind: UsageEvent["kind"],
  attributes: Record<string, unknown>,
  now: () => Date,
): UsageEvent {
  return makeUsageEvent({
    agent_id,
    kind,
    attributes,
    occurredAt: now(),
  });
}
