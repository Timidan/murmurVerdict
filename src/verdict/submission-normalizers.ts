import {
  type Commitment,
  CommitmentSchema,
} from "./markets-core.js";

/**
 * Parse a stored `submissions.commitment_json` blob back into a runtime
 * {@link Commitment}. Bigint-string fields round-trip through `BigInt()` after
 * Zod validation. Returns null if `commitment_json` is null/empty.
 */
export function parseStoredCommitment(
  commitment_json: string | null | undefined,
): Commitment | null {
  if (!commitment_json) return null;
  // FIX 2 — robustness. Any failure along the parse chain (bad JSON,
  // schema mismatch, BigInt conversion of a non-integer string,
  // unexpected mutation of CommitmentSchema, ...) returns null so the
  // resolver's v2 path can fall back to legacy without poisoning the
  // tick. Reserve throws for unexpected programmer errors only — and
  // even those are absorbed by the resolver's outer try/catch (FIX 1).
  try {
    const parsed = JSON.parse(commitment_json);
    // CommitmentSchema validates the wire shape with bigint-strings; we map
    // those back to native bigints for the runtime Commitment.
    const validated = CommitmentSchema.parse(parsed);
    return {
      marketRef: validated.marketRef,
      predictedOutcome: {
        kind: validated.predictedOutcome.kind,
        payoutNumerators: validated.predictedOutcome.payoutNumerators.map(
          (s) => BigInt(s),
        ),
        payoutDenominator: BigInt(validated.predictedOutcome.payoutDenominator),
        ...(validated.predictedOutcome.scalarValue !== undefined
          ? { scalarValue: BigInt(validated.predictedOutcome.scalarValue) }
          : {}),
      },
      horizon: validated.horizon,
      confidence: validated.confidence,
    };
  } catch (err) {
    if (process.env.MURMUR_DEBUG_NORMALIZER === "1") {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[normalizer] parseStoredCommitment failed: ${msg}`);
    }
    return null;
  }
}
