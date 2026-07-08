import { randomUUID } from "node:crypto";

import type {
  AgentSecurityEvent,
  AgentSecurityEventKind,
} from "./schema.js";
import { nowIso } from "./time.js";

export type AgentSecurityEventIdAdapter = () => string;

export interface AgentSecurityEventDraft {
  event_id?: string;
  newEventId?: AgentSecurityEventIdAdapter;
  agent_id?: string | null;
  account_id?: string | null;
  kind: AgentSecurityEventKind;
  actor: string;
  payload?: Record<string, unknown>;
  createdAt: Date;
}

export function makeAgentSecurityEvent(
  input: AgentSecurityEventDraft,
): AgentSecurityEvent {
  return {
    event_id: input.event_id ?? input.newEventId?.() ?? randomUUID(),
    agent_id: input.agent_id ?? null,
    account_id: input.account_id ?? null,
    kind: input.kind,
    actor: input.actor,
    payload: input.payload ?? {},
    created_at: nowIso(input.createdAt),
  };
}

export function agentSecurityEventPayloadJson(
  payload: AgentSecurityEvent["payload"] | undefined,
): string {
  return JSON.stringify(payload ?? {});
}

export function parseAgentSecurityEventPayload(
  raw: string,
): AgentSecurityEvent["payload"] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as AgentSecurityEvent["payload"])
      : {};
  } catch {
    return {};
  }
}
