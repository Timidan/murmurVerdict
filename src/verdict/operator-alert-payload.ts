import { safeFeedSlaIncidentDetails } from "./feed-sla-incident-detail.js";

export function encodeOperatorAlertPayload(payload: unknown): string {
  return JSON.stringify(payload);
}

export function decodeOperatorAlertPayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function feedSlaIncidentAlertPayload(row: {
  incident_id: string;
  feed_id: string;
  agent_id: string;
  incident_kind: string;
  expected_sequence: number;
  expected_delivery_deadline_at: string;
  detected_at: string;
  grace_seconds: number;
  refund_action: string;
  slash_action: string;
  details_json: string;
}): unknown {
  return {
    incident_id: row.incident_id,
    feed_id: row.feed_id,
    agent_id: row.agent_id,
    incident_kind: row.incident_kind,
    expected_sequence: row.expected_sequence,
    expected_delivery_deadline_at: row.expected_delivery_deadline_at,
    detected_at: row.detected_at,
    grace_seconds: row.grace_seconds,
    refund_action: row.refund_action,
    slash_action: row.slash_action,
    details: safeFeedSlaIncidentDetails(row),
  };
}
