import {
  callScore,
  type Commitment,
  type Outcome as UniversalOutcome,
} from "./markets-core.js";
import type { MarketMakerAdapter } from "../markets/types.js";

// Murmur scores exactly one way: the universal payout-vector (multinomial
// Brier) scorer below, over the outcome an EXTERNAL venue published.
//
// Removed with the native-price path: the static realized-volatility table,
// `computeSignedReturn`, `outcomeFromSignedReturn`, and `scoreCall` — the
// confidence-weighted financial-direction score that consumed
// (asset, horizon, signed_return, outcome). Nothing produces a signed return
// any more, so nothing could call them.

// ─── Per-agent leaderboard score (Phase F three-axis) ────────────────────────
//
// `verdict_score` is the public-leaderboard-facing predictive metric:
//   verdict_score = mean(call_score) - stdev(call_score) / sqrt(resolved_calls)
// (= 1-sigma lower bound of the mean; rewards consistency.)
//
// Ranking research: marketplace consumers
// should sort by a lower confidence bound on the mean instead of the raw
// mean. The math here is `mean − 1.6449·sem` — a one-sided 95%
// normal-approx lower bound (sometimes loosely called Wilson-style, but
// it is NOT a true Wilson interval; Wilson is for binomial proportions).
// With small N, the lower bound is a stricter gate — 20 lucky calls
// can't outrank 200 stable calls. Public leaderboard keeps
// `verdict_score` as the headline number; marketplace queries (and
// Pillar 4 booking) use `verdict_score_lb`.
//
// Only win/loss outcomes count toward `resolved_calls`. void /
// oracle_unavailable produce null call_score and are excluded.

export interface VerdictScoreResult {
  verdict_score: number | null;
  /**
   * Lower confidence bound on the mean call_score: `mean − 1.6449·sem`,
   * a one-sided 95% normal-approx lower bound (sometimes loosely called
   * Wilson-style, but it is not a true Wilson binomial interval).
   * Conservative ranking signal for the marketplace tier (D24).
   */
  verdict_score_lb: number | null;
  mean: number | null;
  stdev: number | null;
  resolved_calls: number;
}

// ~95% one-sided z (1.6449); call_score is bounded [-0.75, 0.25] so
// using the normal approximation is reasonable past N≥10 and strictly
// conservative below.
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
  // Lower bound: mean - z * sem. Same direction as verdict_score but
  // wider (more conservative) — uses 1.6449 vs 1.0 multiplier.
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

// ─── Universal payout-vector scoring (V2 §2.3) ───────────────────────────────
//
// The ONE scorer. `scoreOutcomeVector` dispatches to the markets-core
// multinomial-Brier shell over the payout vector an external venue published:
//
//   call_score = 1 − halfL1Distance(predicted, resolved) ∈ [0, 1]
//
// Non-scoring outcomes still map to the legacy `call_score = null` + `void`
// contract, because leaderboard exclusion is the load-bearing legacy behavior
// and the 44 historical resolutions depend on it:
//
//   · kind === 'invalid' — the adapter declined to resolve (e.g. Polymarket
//     cancelled the market). Universal score is undefined → null, void=true.
//   · kind/length mismatch between the commitment and the resolved outcome →
//     null, void=FALSE. That is a malformed pairing, not a void outcome, and
//     callers must be able to tell the two apart.
//
// The universal Outcome shape is preserved on
// `t1_resolutions.resolved_outcome_json`; the legacy `call_score` column
// stays null for both non-scoring cases.

export interface ScoreOutcomeVectorResult {
  /** Universal call_score in [0,1] for non-void resolutions; null for the
   *  two non-scoring cases documented above. */
  call_score: number | null;
  /** True iff the outcome maps to legacy-void semantics (excluded from
   *  leaderboard aggregation, call_score = null). */
  void: boolean;
}

/**
 * Universal payout-vector scoring entry point. Dispatches the
 * multinomial-Brier shell from markets-core.callScore, mapping the two
 * non-scoring cases to the legacy `call_score = null` contract.
 *
 * Order of checks:
 *
 *   0. adapter abstained — `outcome.kind === 'invalid'`            → null, void
 *      Outcome is structurally a non-score regardless of the
 *      commitment shape; map to legacy void.
 *   1. KIND/LENGTH VALIDATION — predicted.kind === resolved.kind
 *      AND predicted.payoutNumerators.length === resolved.payoutNumerators.length.
 *      Mismatch → { call_score: null, void: false }. We CANNOT score a
 *      categorical commitment against a binary outcome (or any other
 *      shape mismatch); the only structurally-valid response is
 *      "refuse to score". void=false because the call is not a void
 *      outcome — it's a malformed pairing. Caller (verifier / replay)
 *      sees null + void=false and knows to surface a mismatch rather
 *      than silently filtering the call out of the leaderboard.
 *   2. otherwise → adapter.score(c, o) (or the markets-core callScore shell).
 *
 * @param commitment — universal Commitment shape (parsed from
 *                    `submissions.commitment_json` or derived from a legacy row
 *                    via `legacySubmissionToCommitment`).
 * @param outcome    — universal Outcome shape returned by the adapter's
 *                    `observeResolution`-family function.
 */
export function scoreOutcomeVector(
  commitment: Commitment,
  outcome: UniversalOutcome,
  adapter?: MarketMakerAdapter,
): ScoreOutcomeVectorResult {
  // (0) adapter abstained — invalid outcome, no score. Independent of
  // commitment shape: callScore would throw kind-mismatch for binary
  // commitment vs invalid resolved anyway, so fail-closed early.
  if (outcome.kind === "invalid") {
    return { call_score: null, void: true };
  }
  // (1) Kind + length validation. A categorical/scalar commitment paired
  // with a binary outcome (or any other shape mismatch) is unscoreable and
  // must be reported as a mismatch, not silently filtered out as a void.
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
  // (2) Dispatch via the adapter's `score()` so adapter-private components
  // (legacy_bin classification, future venue softmax weights, ...) stay
  // encapsulated. The adapter is OPTIONAL — callers with no registry handy
  // (offline tooling, the universal verifier harness) fall through to the
  // markets-core callScore shell directly; the dispatch is the abstraction a
  // cross-adapter leaderboard leans on.
  if (adapter) {
    const { call_score } = adapter.score(commitment, outcome);
    return { call_score, void: false };
  }
  // Fallback when no adapter passed — direct callScore, the same shell every
  // adapter's score() wraps internally.
  const score = callScore(commitment, outcome);
  return { call_score: score, void: false };
}
