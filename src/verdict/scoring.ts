import {
  AssetId,
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  HorizonHours,
  Outcome,
  SCORING_VERSION,
  Side,
  VOID_BAND,
} from "./schema.js";
import {
  callScore,
  type Commitment,
  type Outcome as UniversalOutcome,
} from "./markets-core.js";

// ─── Realized-volatility table (v0.1, static) ─────────────────────────────────
// Refreshed by post-launch backfill, never on hot path.

// P3 Phase 1.5: Partial map — only ETH is calibrated today. BTC/SOL/BNB
// fall through to the nearest-horizon fallback or the default 0.012.
// Calibrating new assets is a backfill task, not a launch blocker.
//
// P3 Phase 2e: Volatility buckets keyed by canonical horizon_seconds.
// Sub-hour markets (eth.5m, eth.15m) get their own buckets; the
// nearest-bucket fallback handles in-between horizons gracefully.
// Sub-hour RMS targets per Codex audit guidance — operators can
// recalibrate via backfill once we have live data.
const VOLATILITY_BUCKETS_SECONDS = [300, 900, 3600, 14400, 86400, 604800] as const;
const REALIZED_VOLATILITY: Partial<Record<AssetId, Partial<Record<number, number>>>> = {
  "base:ETH:USD": {
    300: 0.0008,
    900: 0.0015,
    3600: 0.006,
    14400: 0.012,
    86400: 0.03,
    604800: 0.075,
  },
};

export function expectedVolatilityBySeconds(
  asset_id: AssetId,
  horizon_seconds: number,
): number {
  const row = REALIZED_VOLATILITY[asset_id];
  if (!row) return 0.012;
  const direct = row[horizon_seconds];
  if (direct !== undefined) return direct;
  // Nearest-larger then nearest-smaller fallback over the keyed buckets.
  const sorted = [...VOLATILITY_BUCKETS_SECONDS].sort((a, b) => a - b);
  const larger = sorted.find((h) => h >= horizon_seconds);
  if (larger !== undefined && row[larger] !== undefined) return row[larger];
  const smaller = [...sorted].reverse().find((h) => h <= horizon_seconds);
  if (smaller !== undefined && row[smaller] !== undefined) return row[smaller];
  return 0.012;
}

/**
 * Back-compat surface: keep the (asset_id, horizon_hours) signature for any
 * legacy caller. Internally forwards to expectedVolatilityBySeconds via
 * `horizon_hours * 3600`. Phase 2e canonical scoring uses seconds.
 */
export function expectedVolatility(
  asset_id: AssetId,
  horizon_hours: HorizonHours,
): number {
  return expectedVolatilityBySeconds(asset_id, horizon_hours * 3600);
}

// ─── Signed return ───────────────────────────────────────────────────────────
// r = ln(p1/p0) for BUY; -ln(p1/p0) for SELL.

export function computeSignedReturn(
  side: Side,
  p0: string,
  p1: string,
): number {
  const a = Number(p0);
  const b = Number(p1);
  if (!(a > 0) || !(b > 0)) {
    throw new Error("p0 and p1 must be positive decimal strings");
  }
  const ln = Math.log(b / a);
  return side === "BUY" ? ln : -ln;
}

// ─── Outcome from signed return ──────────────────────────────────────────────

/**
 * Map a signed return to an outcome via a void band threshold.
 *
 * P4 Item 4 (Codex audit): the void_band can now come from the receipt
 * subject's market_config snapshot. Old receipts (no carried subject)
 * fall back to the global VOID_BAND constant — that path stays
 * byte-identical. New receipts pass the per-market void_band stamped
 * at acceptance, so post-bump policy changes can't retroactively rewrite
 * a call's outcome.
 */
export function outcomeFromSignedReturn(
  signed_return: number,
  void_band: number = VOID_BAND,
): Outcome {
  if (signed_return >= void_band) return "win";
  if (signed_return <= -void_band) return "loss";
  return "void";
}

// ─── Per-call score (frozen formula, scoring_version = 1) ────────────────────
// y     = 1 if signed_return >= +0.0020 else 0
// p     = clamp(confidence, 0.51, 0.95)
// skill = 0.25 - (p - y) ** 2
// move  = clamp(|signed_return| / expected_volatility, 0.25, 2.0)
// hzn   = min(sqrt(horizon_hours / 4), 3)
// call_score = skill * move * hzn

export interface CallScoreInput {
  asset_id: AssetId;
  horizon_hours: HorizonHours;
  /**
   * Phase 2e: canonical horizon for scoring. When present this overrides
   * `horizon_hours * 3600` (sub-hour precision). When absent (legacy
   * callers) we fall back to `horizon_hours * 3600` so 1h/4h/24h/7d
   * inputs produce byte-identical results to pre-Phase-2e scoring.
   */
  horizon_seconds?: number;
  confidence: number;
  signed_return: number;
  outcome: Outcome;
}

export interface CallScoreBreakdown {
  scoring_version: typeof SCORING_VERSION;
  call_score: number | null;
  components: {
    y: 0 | 1 | null;
    p: number;
    skill: number | null;
    move: number | null;
    hzn: number;
    expected_volatility_used: number;
  };
}

export function scoreCall(input: CallScoreInput): CallScoreBreakdown {
  // Phase 2e: scoring keys on canonical horizon_seconds. When the caller
  // doesn't pass it (legacy code paths), fall back to `horizon_hours * 3600`
  // so 1h/4h/24h/7d inputs reproduce the pre-Phase-2e numbers exactly.
  const seconds =
    input.horizon_seconds ?? input.horizon_hours * 3600;
  const ev = expectedVolatilityBySeconds(input.asset_id, seconds);
  // baseline 4h = 14400s; precision-preserving for sub-hour markets.
  const hzn = Math.min(Math.sqrt(seconds / 14400), 3);
  const p = clamp(input.confidence, CONFIDENCE_MIN, CONFIDENCE_MAX);

  if (input.outcome === "void" || input.outcome === "oracle_unavailable") {
    return {
      scoring_version: SCORING_VERSION,
      call_score: null,
      components: {
        y: null,
        p,
        skill: null,
        move: null,
        hzn,
        expected_volatility_used: ev,
      },
    };
  }

  const y: 0 | 1 = input.outcome === "win" ? 1 : 0;
  const skill = 0.25 - (p - y) ** 2;
  const move = clamp(Math.abs(input.signed_return) / ev, 0.25, 2.0);
  const call_score = skill * move * hzn;

  return {
    scoring_version: SCORING_VERSION,
    call_score,
    components: {
      y,
      p,
      skill,
      move,
      hzn,
      expected_volatility_used: ev,
    },
  };
}

// ─── Per-agent leaderboard score (Phase F three-axis) ────────────────────────
//
// `verdict_score` is the public-leaderboard-facing predictive metric:
//   verdict_score = mean(call_score) - stdev(call_score) / sqrt(resolved_calls)
// (= 1-sigma lower bound of the mean; rewards consistency.)
//
// Codex ranking-research recommendation D24: marketplace consumers
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

// ─── helpers ─────────────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ─── Phase 5 — universal payout-vector scoring (V2 §2.3) ─────────────────────
//
// scoreOutcomeVector is the universal counterpart to scoreCall's binary
// Brier-direction body. Where scoreCall consumes (asset, horizon, signed_return,
// outcome) and emits a confidence-weighted financial-direction score,
// scoreOutcomeVector dispatches to the markets-core multinomial-Brier shell:
//
//   call_score = 1 − halfL1Distance(predicted, resolved) ∈ [0, 1]
//
// V2 §2.3 reconciliation — the void-mapping rule:
//   The legacy resolver collapses three buckets into one outcome:
//     win  → predicted == resolved (binary [1,0]/[0,1])
//     loss → disjoint one-hots
//     void → small move inside |signed_return| < void_band
//   Legacy void produces `call_score = null` and the call is excluded from
//   leaderboard aggregation. The universal Outcome shape has TWO ways to
//   signal "this call doesn't score":
//
//     (a) kind === 'invalid' — the adapter declined to resolve. Universal
//         score is undefined; we map to `call_score = null`.
//     (b) binary outcome with payoutNumerators=[0,0] — the native-price
//         adapter emits this for void-band hits. callScore on
//         predicted=[1,0] vs resolved=[0,0] is exactly 0.5 (L1 midpoint),
//         which DIVERGES from the legacy null. Phase 5 reconciles in favor
//         of the legacy semantics: `call_score = null` for [0,0] resolved
//         outcomes too. Reasoning: leaderboard exclusion is the load-bearing
//         legacy contract (see resolver_smoke regression: void calls don't
//         move verdict_score).
//
//   Net effect: every code path that hit `outcome ∈ {void, oracle_unavailable}`
//   in the legacy resolver hits `void: true` here. The universal Outcome
//   shape is preserved on `t1_resolutions.resolved_outcome_json` for the new
//   universal-shape consumers; the legacy `call_score` column stays null.

export interface ScoreOutcomeVectorResult {
  /** Universal call_score in [0,1] for non-void resolutions; null for the
   *  three void buckets documented above. */
  call_score: number | null;
  /** True iff the outcome maps to legacy-void semantics (excluded from
   *  leaderboard aggregation, call_score = null). */
  void: boolean;
}

/**
 * Universal payout-vector scoring entry point. Dispatches the multinomial-Brier
 * shell from markets-core.callScore for non-void cases and reconciles the three
 * void buckets to the legacy `call_score = null` contract.
 *
 * Void mapping rule (Phase 5 reconciliation, see file comment above):
 *   - outcome.kind === 'invalid'                              → null, void
 *   - outcome.kind === 'binary' AND payoutNumerators=[0n,0n]  → null, void
 *   - any other case                                          → callScore(c, o)
 *
 * The kind === 'invalid' branch is fail-closed regardless of payoutNumerators —
 * callScore would fail the kind-equality check anyway when predicted is binary
 * and resolved is invalid, so we short-circuit before that throw.
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
): ScoreOutcomeVectorResult {
  // (a) adapter abstained — invalid outcome, no score.
  if (outcome.kind === "invalid") {
    return { call_score: null, void: true };
  }
  // (b) binary void: every numerator is zero. Legacy void band hit.
  // Length guard catches malformed binary outcomes (adapter bug).
  if (outcome.kind === "binary" && outcome.payoutNumerators.length === 2) {
    const allZero = outcome.payoutNumerators.every((n) => n === 0n);
    if (allZero) {
      return { call_score: null, void: true };
    }
  }
  // Non-void: dispatch to the universal multinomial-Brier shell.
  const score = callScore(commitment, outcome);
  return { call_score: score, void: false };
}
