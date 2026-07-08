import {
  commitmentToWire,
} from "./market-adapter-config.js";
import {
  type Commitment,
  CommitmentSchema,
} from "./markets-core.js";

export interface StoredRevealedCommitment {
  commitment_json: string;
  predicted_outcome_json: string;
  outcome_labels_json: string;
}

export interface ParseStoredCommitmentOptions {
  onParseError?: (message: string) => void;
}

export function revealedCommitmentEvidence(input: {
  commitment: Commitment;
  outcomeLabels: string[];
}): StoredRevealedCommitment {
  const commitmentWire = commitmentToWire(input.commitment);
  return {
    commitment_json: JSON.stringify(commitmentWire),
    predicted_outcome_json: JSON.stringify(commitmentWire.predictedOutcome),
    outcome_labels_json: JSON.stringify(input.outcomeLabels),
  };
}

export function parseStoredCommitment(
  commitment_json: string | null | undefined,
  options: ParseStoredCommitmentOptions = {},
): Commitment | null {
  if (!commitment_json) return null;
  try {
    const parsed = JSON.parse(commitment_json) as unknown;
    const validated = CommitmentSchema.parse(parsed);
    return {
      marketRef: validated.marketRef,
      predictedOutcome: storedPredictedOutcome(validated.predictedOutcome),
      horizon: validated.horizon,
      confidence: validated.confidence,
    };
  } catch (err) {
    options.onParseError?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}

type StoredPredictedOutcome = {
  kind: Commitment["predictedOutcome"]["kind"];
  payoutNumerators: string[];
  payoutDenominator: string;
  scalarValue?: string;
};

function storedPredictedOutcome(
  predictedOutcome: StoredPredictedOutcome,
): Commitment["predictedOutcome"] {
  return {
    kind: predictedOutcome.kind,
    payoutNumerators: predictedOutcome.payoutNumerators.map((s) => BigInt(s)),
    payoutDenominator: BigInt(predictedOutcome.payoutDenominator),
    ...(predictedOutcome.scalarValue !== undefined
      ? { scalarValue: BigInt(predictedOutcome.scalarValue) }
      : {}),
  };
}
