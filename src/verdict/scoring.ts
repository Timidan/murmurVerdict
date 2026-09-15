import {
  callScore,
  type Commitment,
  type Outcome as UniversalOutcome,
} from "./markets-core.js";
import type { MarketMakerAdapter } from "../markets/types.js";

// Murmur scores one way: the payout-vector (multinomial Brier) scorer below,
// over the outcome an external venue published.

// ─── Per-agent leaderboard score ─────────────────────────────────────────────
//
//   verdict_score    = mean − stdev / sqrt(n)    (1-sigma bound; public headline)
//   verdict_score_lb = mean − 1.6449·sem         (one-sided 95%, normal approx;
//                                                  not a true Wilson interval)
// The marketplace sorts by verdict_score_lb so 20 lucky calls can't outrank
// 200 stable ones. Null call_scores (void, oracle_unavailable) are excluded.

export interface VerdictScoreResult {
  verdict_score: number | null;
  /** `mean − 1.6449·sem`; marketplace ranking signal. */
  verdict_score_lb: number | null;
  mean: number | null;
  stdev: number | null;
  resolved_calls: number;
}

// One-sided 95% z-score.
const Z_95 = 1.6449;

export function computeVerdictScore(callScores: (number | null)[]): VerdictScoreResult {
  const xs = callScores.filter((s): s is number => s !== null);
  if (xs.length === 0) {
    return {
      verdict_score: null,
      verdict_score_lb: null,
      mean: null,
      stdev: null,
      resolved_calls: 0,
    };
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance =
    xs.length > 1
      ? xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1)
      : 0;
  const stdev = Math.sqrt(variance);
  const verdict_score = mean - stdev / Math.sqrt(xs.length);
  const sem = stdev / Math.sqrt(xs.length);
  const verdict_score_lb = mean - Z_95 * sem;
  return {
    verdict_score,
    verdict_score_lb,
    mean,
    stdev,
    resolved_calls: xs.length,
  };
}

// ─── Payout-vector scoring ───────────────────────────────────────────────────
//
//   call_score = 1 − halfL1Distance(predicted, resolved) ∈ [0, 1]
//
// Non-scoring cases return call_score = null so the leaderboard excludes them:
//   · kind === 'invalid' (adapter declined, e.g. cancelled market) → void=true.
//   · kind/length mismatch → void=FALSE; a malformed pairing, not a void, and
//     callers must be able to tell the two apart.

export interface ScoreOutcomeVectorResult {
  /** Universal call_score in [0,1] for non-void resolutions; null for the
   *  two non-scoring cases documented above. */
  call_score: number | null;
  /** True iff the outcome maps to legacy-void semantics (excluded from
   *  leaderboard aggregation, call_score = null). */
  void: boolean;
}

/** Scores a commitment against a venue outcome, handling the non-scoring
 *  cases above first. */
export function scoreOutcomeVector(
  commitment: Commitment,
  outcome: UniversalOutcome,
  adapter?: MarketMakerAdapter,
): ScoreOutcomeVectorResult {
  // Invalid outcome: no score, whatever the commitment shape.
  if (outcome.kind === "invalid") {
    return { call_score: null, void: true };
  }
  // Shape mismatch is unscoreable; report it, don't filter it as a void.
  if (
    commitment.predictedOutcome.kind !== outcome.kind ||
    commitment.predictedOutcome.payoutNumerators.length !==
      outcome.payoutNumerators.length
  ) {
    console.warn(
      `[scoreOutcomeVector] kind/length mismatch: predicted.kind=${commitment.predictedOutcome.kind} (n=${commitment.predictedOutcome.payoutNumerators.length}) vs resolved.kind=${outcome.kind} (n=${outcome.payoutNumerators.length}); refusing to score`,
    );
    return { call_score: null, void: false };
  }
  // Prefer the adapter's score() so adapter-private logic stays encapsulated.
  if (adapter) {
    const { call_score } = adapter.score(commitment, outcome);
    return { call_score, void: false };
  }
  // No adapter (offline tooling): the same shell every adapter's score() wraps.
  const score = callScore(commitment, outcome);
  return { call_score: score, void: false };
}
