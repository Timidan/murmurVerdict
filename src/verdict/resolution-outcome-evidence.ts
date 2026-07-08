import type { CallResolvedEvent } from "./events.js";
import {
  serializeOutcome,
  type Outcome as UniversalOutcome,
} from "./markets-core.js";

export interface ResolutionOutcomeEvidenceJson {
  resolved_outcome_json: string;
  payout_vector_json: string;
}

export function resolutionOutcomeEvidenceJson(
  outcome: UniversalOutcome,
): ResolutionOutcomeEvidenceJson {
  return {
    resolved_outcome_json: JSON.stringify(serializeOutcome(outcome)),
    payout_vector_json: JSON.stringify(
      outcome.payoutNumerators.map((n) => n.toString()),
    ),
  };
}

export function publicResolutionOutcomeEvidence(input: {
  resolved_outcome_json: string | null;
  payout_vector_json: string | null;
}): Pick<CallResolvedEvent, "resolved_outcome" | "payout_vector"> {
  const resolvedOutcome = parseOptionalJson(input.resolved_outcome_json);
  const payoutVector = parseOptionalStringArray(input.payout_vector_json);
  return {
    ...(resolvedOutcome !== undefined ? { resolved_outcome: resolvedOutcome } : {}),
    ...(payoutVector !== undefined ? { payout_vector: payoutVector } : {}),
  };
}

function parseOptionalJson(value: string | null): unknown | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseOptionalStringArray(value: string | null): string[] | undefined {
  const parsed = parseOptionalJson(value);
  if (!Array.isArray(parsed)) return undefined;
  return parsed.every((item) => typeof item === "string")
    ? parsed
    : undefined;
}
