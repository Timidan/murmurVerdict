export interface MissedPacketIncidentDetailInput {
  cadence_seconds: number;
  grace_seconds: number;
  refund_rule: Record<string, unknown>;
  slash_rule: Record<string, unknown>;
}

export function missedPacketIncidentDetailsJson(
  input: MissedPacketIncidentDetailInput,
): string {
  return JSON.stringify({
    cadence_seconds: input.cadence_seconds,
    grace_seconds: input.grace_seconds,
    refund_rule: input.refund_rule,
    slash_rule: input.slash_rule,
    generated_by: "feed_sla_tick_v1",
  });
}

export function publicFeedSlaIncidentDetails(row: { details_json: string }): unknown {
  return parseDetails(row.details_json);
}

export function safeFeedSlaIncidentDetails(row: { details_json: string }): unknown {
  try {
    return parseDetails(row.details_json);
  } catch {
    return null;
  }
}

function parseDetails(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(
      `feed_sla_incident.details_json is malformed JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
