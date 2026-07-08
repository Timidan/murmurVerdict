import { randomUUID } from "node:crypto";

import type {
  UsageEvent,
  UsageEventKind,
} from "./schema.js";
import { nowIso } from "./time.js";

export type UsageEventIdAdapter = () => string;

export interface UsageEventDraft {
  agent_id: string | null;
  kind: UsageEventKind;
  attributes?: Record<string, unknown>;
  newUsageEventId?: UsageEventIdAdapter;
  occurredAt: Date;
}

export function makeUsageEvent(input: UsageEventDraft): UsageEvent {
  return {
    event_id: (input.newUsageEventId ?? randomUUID)(),
    agent_id: input.agent_id,
    kind: input.kind,
    ts: nowIso(input.occurredAt),
    attributes: input.attributes ?? {},
  };
}

export function usageEventAttributesJson(
  attributes: UsageEvent["attributes"] | undefined,
): string {
  return JSON.stringify(attributes ?? {});
}

export function parseUsageEventAttributes(raw: string): UsageEvent["attributes"] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as UsageEvent["attributes"])
      : {};
  } catch {
    return {};
  }
}
