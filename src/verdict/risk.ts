import {
  AssetId,
  MarketRegime,
  Side,
  SubmittedCall,
  VerdictPreflight,
} from "./schema.js";

// ─── MarketContext ────────────────────────────────────────────────────────────
// What the risk evaluator needs to judge a call. The submissions pipeline is
// responsible for building this from the existing analyst/scout cache.

export interface MarketContext {
  asset_id: AssetId;
  /** Murmur's composite analyst score in [-1, 1]. Positive = constructive. */
  composite_score: number;
  /** Top playbook (e.g. "early_narrative_breakout"). */
  top_playbook: string;
  /** Per-playbook scores for the asset; used for tie-break and explanations. */
  playbook_scores: { playbook: string; score: number; confidence: number }[];
  /** "bullish" | "bearish" | "neutral" — derived upstream. */
  regime: MarketRegime;
  /** Seconds since underlying market data was last refreshed. */
  data_freshness_seconds: number;
}

/**
 * Direction implied by a playbook label, when there is one. Returning null
 * means the playbook is not directionally opinionated by name and we should
 * not flag misalignment.
 */
function playbookImpliedDirection(playbook: string): Side | null {
  switch (playbook) {
    case "early_narrative_breakout":
    case "capitulation_rebound":
      return "BUY";
    case "euphoria_fade":
      return "SELL";
    default:
      return null;
  }
}

// Public risk-flag names. Stable wire contract.
export const RISK_FLAGS = {
  regime_against_call: "regime_against_call",
  data_stale: "data_stale",
  playbook_misalignment: "playbook_misalignment",
  confidence_outlier: "confidence_outlier",
  low_murmur_conviction: "low_murmur_conviction",
} as const;

export type RiskFlag = (typeof RISK_FLAGS)[keyof typeof RISK_FLAGS];

export interface RiskEvaluationOptions {
  /** Older than this → flag `data_stale`. Default 600s (10 min). */
  data_stale_threshold_sec?: number;
  /** |composite_score| below this → flag `low_murmur_conviction`. Default 0.10. */
  low_conviction_threshold?: number;
  /** |confidence_implied − agent_confidence| above this → flag `confidence_outlier`. Default 0.40. */
  confidence_divergence_threshold?: number;
}

const DEFAULT_OPTS: Required<RiskEvaluationOptions> = {
  data_stale_threshold_sec: 600,
  low_conviction_threshold: 0.1,
  confidence_divergence_threshold: 0.4,
};

/**
 * Map Murmur's composite score to an "implied confidence" in [0.5, 0.95] for
 * the call side that aligns with the score's sign. We use this only to flag
 * outliers, not to gate; the agent owns the call.
 */
function impliedConfidenceForSide(composite_score: number, side: Side): number {
  const aligned = (side === "BUY" && composite_score > 0) || (side === "SELL" && composite_score < 0);
  const magnitude = Math.min(0.95, 0.5 + Math.abs(composite_score) * 0.45);
  return aligned ? magnitude : 1 - magnitude;
}

export interface RiskEvaluation {
  preflight: VerdictPreflight;
  /** Detailed reasons keyed by flag, for debugging and Telegram cards. */
  reasons: Partial<Record<RiskFlag, string>>;
}

export function evaluateRisk(
  call: SubmittedCall,
  ctx: MarketContext,
  opts: RiskEvaluationOptions = {},
): RiskEvaluation {
  if (call.asset_id !== ctx.asset_id) {
    throw new Error(
      `risk evaluator: asset_id mismatch (call=${call.asset_id} ctx=${ctx.asset_id})`,
    );
  }
  const o = { ...DEFAULT_OPTS, ...opts };
  const flags: RiskFlag[] = [];
  const reasons: Partial<Record<RiskFlag, string>> = {};

  if (ctx.data_freshness_seconds > o.data_stale_threshold_sec) {
    flags.push(RISK_FLAGS.data_stale);
    reasons[RISK_FLAGS.data_stale] = `data is ${ctx.data_freshness_seconds}s old (> ${o.data_stale_threshold_sec}s)`;
  }

  const isBullishCall = call.side === "BUY";
  if (isBullishCall && ctx.regime === "bearish") {
    flags.push(RISK_FLAGS.regime_against_call);
    reasons[RISK_FLAGS.regime_against_call] = "BUY into bearish regime";
  } else if (!isBullishCall && ctx.regime === "bullish") {
    flags.push(RISK_FLAGS.regime_against_call);
    reasons[RISK_FLAGS.regime_against_call] = "SELL into bullish regime";
  }

  const impliedDir = playbookImpliedDirection(ctx.top_playbook);
  if (impliedDir && impliedDir !== call.side) {
    flags.push(RISK_FLAGS.playbook_misalignment);
    reasons[RISK_FLAGS.playbook_misalignment] =
      `top playbook ${ctx.top_playbook} implies ${impliedDir}, call is ${call.side}`;
  }

  if (Math.abs(ctx.composite_score) < o.low_conviction_threshold) {
    flags.push(RISK_FLAGS.low_murmur_conviction);
    reasons[RISK_FLAGS.low_murmur_conviction] =
      `Murmur composite |${ctx.composite_score.toFixed(3)}| < ${o.low_conviction_threshold}`;
  }

  const implied = impliedConfidenceForSide(ctx.composite_score, call.side);
  if (Math.abs(implied - call.confidence) > o.confidence_divergence_threshold) {
    flags.push(RISK_FLAGS.confidence_outlier);
    reasons[RISK_FLAGS.confidence_outlier] =
      `agent confidence ${call.confidence.toFixed(2)} diverges from Murmur-implied ${implied.toFixed(2)}`;
  }

  const preflight: VerdictPreflight = {
    murmur_score: clamp(ctx.composite_score, -1, 1),
    murmur_playbook: ctx.top_playbook,
    risk_flags: flags,
    data_freshness_seconds: Math.max(0, Math.floor(ctx.data_freshness_seconds)),
    market_regime: ctx.regime,
  };

  return { preflight, reasons };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
