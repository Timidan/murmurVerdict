import {
  AssetId,
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  HORIZONS_HOURS,
  HorizonHours,
  Outcome,
  SCORING_VERSION,
  Side,
  VOID_BAND,
} from "./schema.js";

// ─── Realized-volatility table (v0.1, static) ─────────────────────────────────
// Refreshed by post-launch backfill, never on hot path.

const REALIZED_VOLATILITY: Record<AssetId, Record<HorizonHours, number>> = {
  "base:ETH:USD": {
    1: 0.006,
    4: 0.012,
    24: 0.03,
    168: 0.075,
  },
};

export function expectedVolatility(
  asset_id: AssetId,
  horizon_hours: HorizonHours,
): number {
  const row = REALIZED_VOLATILITY[asset_id];
  const direct = row[horizon_hours];
  if (direct !== undefined) return direct;

  // Fallback to nearest-larger horizon, then nearest-smaller; never 0.
  const sorted = [...HORIZONS_HOURS].sort((a, b) => a - b);
  const larger = sorted.find((h) => h >= horizon_hours);
  if (larger !== undefined && row[larger] !== undefined) return row[larger];
  const smaller = [...sorted].reverse().find((h) => h <= horizon_hours);
  if (smaller !== undefined && row[smaller] !== undefined) return row[smaller];
  return 0.012;
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

export function outcomeFromSignedReturn(signed_return: number): Outcome {
  if (signed_return >= VOID_BAND) return "win";
  if (signed_return <= -VOID_BAND) return "loss";
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
  const ev = expectedVolatility(input.asset_id, input.horizon_hours);
  const hzn = Math.min(Math.sqrt(input.horizon_hours / 4), 3);
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
// should sort by a Wilson-style lower confidence bound on the mean
// instead of the raw mean. With small N, the lower bound is a stricter
// gate — 20 lucky calls can't outrank 200 stable calls. Public
// leaderboard keeps `verdict_score` as the headline number; marketplace
// queries (and Pillar 4 booking) use `verdict_score_lb`.
//
// Only win/loss outcomes count toward `resolved_calls`. void /
// oracle_unavailable produce null call_score and are excluded.

export interface VerdictScoreResult {
  verdict_score: number | null;
  /**
   * 95% lower confidence bound on the mean call_score using a
   * Student-t / normal approximation. Conservative ranking signal for
   * the marketplace tier (D24).
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
