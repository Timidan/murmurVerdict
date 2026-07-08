import type Database from "better-sqlite3";

import { agentSecurityEventPayloadJson } from "../agent-security-event.js";
import { prep } from "../db-statements.js";
import {
  AgentSecurityEventSchema,
  type AgentSecurityEvent,
} from "../schema.js";

export interface AgentSecurityEventRow {
  event_id: string;
  agent_id: string | null;
  account_id: string | null;
  kind: AgentSecurityEvent["kind"];
  actor: string;
  payload_json: string;
  created_at: string;
}

export const agentSecurityEventsRepo = {
  emit(db: Database.Database, event: AgentSecurityEvent): void {
    const parsed = AgentSecurityEventSchema.parse(event);
    prep(
      db,
      `INSERT INTO agent_security_events
       (event_id, agent_id, account_id, kind, actor, payload_json, created_at)
       VALUES (@event_id, @agent_id, @account_id, @kind, @actor, @payload_json, @created_at)`,
    ).run({
      event_id: parsed.event_id,
      agent_id: parsed.agent_id,
      account_id: parsed.account_id,
      kind: parsed.kind,
      actor: parsed.actor,
      payload_json: agentSecurityEventPayloadJson(parsed.payload),
      created_at: parsed.created_at,
    });
  },

  listForAgent(
    db: Database.Database,
    agent_id: string,
    limit = 50,
  ): AgentSecurityEventRow[] {
    return prep(
      db,
      `SELECT event_id, agent_id, account_id, kind, actor, payload_json, created_at
       FROM agent_security_events
       WHERE agent_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(agent_id, limit) as AgentSecurityEventRow[];
  },

  listByKind(
    db: Database.Database,
    kind: AgentSecurityEvent["kind"],
    limit = 50,
  ): AgentSecurityEventRow[] {
    return prep(
      db,
      `SELECT event_id, agent_id, account_id, kind, actor, payload_json, created_at
       FROM agent_security_events
       WHERE kind = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(kind, limit) as AgentSecurityEventRow[];
  },
};
