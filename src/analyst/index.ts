import {
  type AssetSlug,
  type AssetRawSignals,
  type NormalizedAssetSignals,
  type NormalizedMetric,
  type ScoredAsset,
  type PlaybookScore,
  type StrategyPlaybook,
  type SantimentMetric,
  type TimeseriesPoint,
} from "../types/index.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_DATA_POINTS = 7; // minimum points needed to normalize
const Z_SCORE_WINDOW = 30; // rolling window for z-score (days)
const CANDIDATE_SCORE_THRESHOLD = 0.18; // minimum composite score to be a candidate

// ─── Math Utilities ───────────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[], avg?: number): number {
  if (values.length < 2) return 1; // avoid division by zero
  const m = avg ?? mean(values);
  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - m, 2), 0) / values.length;
  return Math.sqrt(variance) || 1;
}

function zScore(value: number, values: number[]): number {
  const m = mean(values);
  const s = stddev(values, m);
  return (value - m) / s;
}

function percentileRank(value: number, values: number[]): number {
  if (values.length === 0) return 50;
  const sorted = [...values].sort((a, b) => a - b);
  let below = 0;
  for (const v of sorted) {
    if (v < value) below++;
  }
  return (below / sorted.length) * 100;
}

function rateOfChange(
  current: number,
  previous: number | undefined,
): number | null {
  if (previous === undefined || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalize a single metric's timeseries into a NormalizedMetric at the latest point.
 * Uses a rolling window of up to Z_SCORE_WINDOW points for z-score and percentile.
 */
function normalizeMetric(
  points: TimeseriesPoint[],
  pricePoints?: TimeseriesPoint[],
): NormalizedMetric | null {
  if (!points || points.length < MIN_DATA_POINTS) return null;

  const window = points.slice(-Z_SCORE_WINDOW);
  const values = window.map((p) => p.value);
  const latest = values[values.length - 1]!;
  const prev1 = values[values.length - 2];
  const prev7 = values.length >= 8 ? values[values.length - 8] : undefined;

  // For 24h ROC we use the previous day (index -2 in daily data)
  // For 7d ROC we use 7 days back
  const roc24h = rateOfChange(latest, prev1);
  const roc7d = rateOfChange(latest, prev7);

  // ROC 1h only meaningful if we have hourly data (more than 48 points)
  const roc1h =
    points.length >= 48
      ? rateOfChange(latest, values[values.length - 2])
      : null;

  // Divergence vs price: if both series exist, compare their 24h ROC
  let divergenceVsPrice: number | null = null;
  if (pricePoints && pricePoints.length >= MIN_DATA_POINTS) {
    const priceWindow = pricePoints.slice(-Z_SCORE_WINDOW);
    const priceValues = priceWindow.map((p) => p.value);
    const priceLatest = priceValues[priceValues.length - 1]!;
    const pricePrev = priceValues[priceValues.length - 2];
    const priceRoc = rateOfChange(priceLatest, pricePrev);
    if (roc24h !== null && priceRoc !== null) {
      divergenceVsPrice = roc24h - priceRoc;
    }
  }

  return {
    raw: latest,
    zScore: zScore(latest, values),
    percentile: percentileRank(latest, values),
    roc1h,
    roc24h,
    roc7d,
    divergenceVsPrice,
  };
}

/**
 * Normalize all signals for a single asset.
 */
export function normalizeAsset(raw: AssetRawSignals): NormalizedAssetSignals {
  const metrics: Partial<Record<SantimentMetric, NormalizedMetric>> = {};

  for (const [metricKey, points] of Object.entries(raw.signals)) {
    const metric = metricKey as SantimentMetric;
    if (!points || points.length === 0) continue;

    const normalized = normalizeMetric(points);
    if (normalized) {
      metrics[metric] = normalized;
    }
  }

  return {
    slug: raw.slug,
    timestamp: new Date().toISOString(),
    metrics,
  };
}

/**
 * Normalize all assets in the universe.
 */
export function normalizeUniverse(
  universe: Map<AssetSlug, AssetRawSignals>,
): Map<AssetSlug, NormalizedAssetSignals> {
  const result = new Map<AssetSlug, NormalizedAssetSignals>();
  for (const [slug, raw] of universe) {
    result.set(slug, normalizeAsset(raw));
  }
  return result;
}

// ─── Playbook Scoring ─────────────────────────────────────────────────────────

/**
 * Score an asset for the "Early Narrative Breakout" playbook.
 *
 * Looks for: attention rising before price, on-chain confirmation, non-euphoric sentiment.
 * Signal combination: social dominance rising + sentiment improving (not euphoric)
 *                   + active addresses / network growth confirming
 *                   + exchange inflows flat/down
 *                   + whale activity supportive
 */
function scoreEarlyNarrativeBreakout(n: NormalizedAssetSignals): PlaybookScore {
  const signals: string[] = [];
  const warnings: string[] = [];
  let score = 0;
  let weight = 0;

  const m = n.metrics;

  // 1. Social Dominance rising (percentile 40–75 = sweet spot — not yet euphoric)
  if (m.social_dominance_total) {
    const sd = m.social_dominance_total;
    if (sd.roc24h !== null && sd.roc24h > 0.05) {
      const contribution = clamp(sd.roc24h * 2, 0, 1);
      score += contribution;
      signals.push(
        `Social dominance rising +${(sd.roc24h * 100).toFixed(1)}% (24h)`,
      );
    }
    if (sd.percentile > 75) {
      warnings.push("Social dominance already elevated — may be late");
    }
    weight += 1;
  }

  // 2. Weighted sentiment improving but not extreme
  if (m.sentiment_weighted_total) {
    const ws = m.sentiment_weighted_total;
    if (ws.raw > 0 && ws.percentile < 80) {
      score += 0.5;
      signals.push(
        `Sentiment positive (${ws.raw.toFixed(3)}) but not euphoric`,
      );
    } else if (ws.percentile >= 80) {
      warnings.push("Sentiment approaching euphoric levels");
      score -= 0.2;
    }
    weight += 0.8;
  }

  // 3. Daily active addresses growing
  if (m.daily_active_addresses) {
    const daa = m.daily_active_addresses;
    if (daa.roc7d !== null && daa.roc7d > 0.02) {
      score += 0.6;
      signals.push(
        `Active addresses growing +${(daa.roc7d * 100).toFixed(1)}% (7d)`,
      );
    }
    weight += 0.8;
  }

  // 4. Network growth positive
  if (m.network_growth) {
    const ng = m.network_growth;
    if (ng.roc7d !== null && ng.roc7d > 0) {
      score += 0.4;
      signals.push("Network growth positive (7d)");
    }
    weight += 0.5;
  }

  // 5. Exchange inflows flat or declining (not selling pressure)
  if (m.exchange_inflow_usd) {
    const inflow = m.exchange_inflow_usd;
    if (inflow.roc24h !== null && inflow.roc24h < 0.1) {
      score += 0.5;
      signals.push("Exchange inflows flat/low — no immediate sell pressure");
    } else if (inflow.roc24h !== null && inflow.roc24h > 0.3) {
      warnings.push("Exchange inflows rising — possible distribution");
      score -= 0.3;
    }
    weight += 0.7;
  }

  // 6. Whale activity supportive
  if (m.whale_transaction_count_100k_usd_to_inf) {
    const whale = m.whale_transaction_count_100k_usd_to_inf;
    if (whale.roc24h !== null && whale.roc24h > 0) {
      score += 0.4;
      signals.push("Whale transaction count rising");
    }
    weight += 0.5;
  }

  const normalizedScore = weight > 0 ? clamp(score / weight, -1, 1) : 0;
  const confidence = clamp(weight / 5, 0, 1);

  return {
    playbook: "early_narrative_breakout",
    score: normalizedScore,
    confidence,
    signals,
    warnings,
  };
}

/**
 * Score an asset for the "Euphoria Fade / De-Risk" playbook.
 *
 * Looks for: social dominance at extreme, sentiment very positive,
 * dormant circulation rising, exchange inflows increasing, whales distributing.
 * Action: rotate to USDC.
 */
function scoreEuphoriaFade(n: NormalizedAssetSignals): PlaybookScore {
  const signals: string[] = [];
  const warnings: string[] = [];
  let score = 0;
  let weight = 0;

  const m = n.metrics;

  // 1. Social dominance at extreme percentile (>80)
  if (m.social_dominance_total) {
    const sd = m.social_dominance_total;
    if (sd.percentile > 80) {
      const contribution = clamp((sd.percentile - 80) / 20, 0, 1);
      score += contribution;
      signals.push(
        `Social dominance at ${sd.percentile.toFixed(0)}th percentile — crowd is in`,
      );
    }
    weight += 1;
  }

  // 2. Sentiment very positive (top quartile)
  if (m.sentiment_weighted_total) {
    const ws = m.sentiment_weighted_total;
    if (ws.percentile > 75) {
      score += 0.8;
      signals.push(
        `Sentiment at ${ws.percentile.toFixed(0)}th percentile — euphoric`,
      );
    }
    weight += 1;
  }

  // 3. Age consumed / dormant circulation rising (old coins moving)
  if (m.age_consumed) {
    const ac = m.age_consumed;
    if (ac.roc24h !== null && ac.roc24h > 0.2) {
      score += 0.9;
      signals.push(
        `Age consumed spiking +${(ac.roc24h * 100).toFixed(1)}% — old holders waking up`,
      );
    }
    weight += 1;
  }

  // 4. Exchange inflows rising (tokens moving to selling venues)
  if (m.exchange_inflow_usd) {
    const inflow = m.exchange_inflow_usd;
    if (inflow.roc24h !== null && inflow.roc24h > 0.2) {
      score += 0.7;
      signals.push(
        `Exchange inflows up +${(inflow.roc24h * 100).toFixed(1)}% — distribution pressure`,
      );
    }
    weight += 0.8;
  }

  // 5. MVRV elevated (>2.0 = historically overvalued zone)
  if (m.mvrv_usd) {
    const mvrv = m.mvrv_usd;
    if (mvrv.raw > 2.0) {
      score += clamp((mvrv.raw - 2.0) / 2.0, 0, 1);
      signals.push(`MVRV at ${mvrv.raw.toFixed(2)} — historically overvalued`);
    }
    weight += 0.7;
  }

  // 6. Whale tx count declining (whales not buying the top)
  if (m.whale_transaction_count_100k_usd_to_inf) {
    const whale = m.whale_transaction_count_100k_usd_to_inf;
    if (whale.roc24h !== null && whale.roc24h < -0.1) {
      score += 0.5;
      signals.push("Whale activity declining — no smart money confirmation");
    } else if (whale.roc24h !== null && whale.roc24h > 0.2) {
      warnings.push("Whales still active — may not be a top yet");
    }
    weight += 0.5;
  }

  const normalizedScore = weight > 0 ? clamp(score / weight, -1, 1) : 0;
  const confidence = clamp(weight / 5, 0, 1);

  return {
    playbook: "euphoria_fade",
    score: normalizedScore,
    confidence,
    signals,
    warnings,
  };
}

/**
 * Score an asset for the "Capitulation Rebound" playbook.
 *
 * Looks for: sentiment deeply negative, MVRV depressed,
 * exchange outflows rising, whale accumulation, active addresses stabilizing.
 * Action: small contrarian buy.
 */
function scoreCapitulationRebound(n: NormalizedAssetSignals): PlaybookScore {
  const signals: string[] = [];
  const warnings: string[] = [];
  let score = 0;
  let weight = 0;

  const m = n.metrics;

  // 1. Sentiment deeply negative (bottom quartile)
  if (m.sentiment_weighted_total) {
    const ws = m.sentiment_weighted_total;
    if (ws.percentile < 25) {
      score += clamp((25 - ws.percentile) / 25, 0, 1);
      signals.push(
        `Sentiment at ${ws.percentile.toFixed(0)}th percentile — deeply bearish`,
      );
    }
    weight += 1;
  }

  // 2. MVRV depressed (<1.0 = historically undervalued)
  if (m.mvrv_usd) {
    const mvrv = m.mvrv_usd;
    if (mvrv.raw < 1.0) {
      score += clamp((1.0 - mvrv.raw) / 0.5, 0, 1);
      signals.push(`MVRV at ${mvrv.raw.toFixed(2)} — historically undervalued`);
    }
    weight += 0.9;
  }

  // 3. Exchange outflows rising (tokens leaving exchanges = accumulation)
  if (m.exchange_outflow_usd) {
    const outflow = m.exchange_outflow_usd;
    if (outflow.roc24h !== null && outflow.roc24h > 0.1) {
      score += 0.8;
      signals.push(
        `Exchange outflows up +${(outflow.roc24h * 100).toFixed(1)}% — accumulation signal`,
      );
    }
    weight += 0.8;
  }

  // 4. Whale accumulation (large tx count rising despite price being down)
  if (m.whale_transaction_count_100k_usd_to_inf) {
    const whale = m.whale_transaction_count_100k_usd_to_inf;
    if (whale.roc24h !== null && whale.roc24h > 0.1) {
      score += 0.7;
      signals.push("Whale transaction count rising — smart money accumulating");
    }
    weight += 0.8;
  }

  // 5. Active addresses stabilizing (not further collapsing)
  if (m.daily_active_addresses) {
    const daa = m.daily_active_addresses;
    if (daa.roc7d !== null && daa.roc7d > -0.05) {
      score += 0.5;
      signals.push(
        "Active addresses stabilizing — sell-side exhaustion possible",
      );
    } else if (daa.roc7d !== null && daa.roc7d < -0.15) {
      warnings.push(
        "Active addresses still collapsing — capitulation may not be complete",
      );
    }
    weight += 0.6;
  }

  // 6. Social dominance low but not zero (asset still relevant)
  if (m.social_dominance_total) {
    const sd = m.social_dominance_total;
    if (sd.raw > 0.5 && sd.percentile < 40) {
      score += 0.4;
      signals.push("Social dominance low but asset still being discussed");
    }
    weight += 0.4;
  }

  const normalizedScore = weight > 0 ? clamp(score / weight, -1, 1) : 0;
  const confidence = clamp(weight / 5, 0, 1);

  return {
    playbook: "capitulation_rebound",
    score: normalizedScore,
    confidence,
    signals,
    warnings,
  };
}

// ─── Composite Scoring ────────────────────────────────────────────────────────

const PLAYBOOK_WEIGHTS: Record<StrategyPlaybook, number> = {
  early_narrative_breakout: 1.0,
  euphoria_fade: 0.9, // slightly lower — we prefer entries over exits for demo
  capitulation_rebound: 0.8, // requires more signal confidence
};

/**
 * Score a single asset across all 3 playbooks and compute a composite score.
 */
export function scoreAsset(normalized: NormalizedAssetSignals): ScoredAsset {
  const playbookScores: PlaybookScore[] = [
    scoreEarlyNarrativeBreakout(normalized),
    scoreEuphoriaFade(normalized),
    scoreCapitulationRebound(normalized),
  ];

  // Find the highest-scoring playbook
  const topPlaybook = playbookScores.reduce((best, current) =>
    current.score * current.confidence > best.score * best.confidence
      ? current
      : best,
  );

  // Use top playbook's conviction directly (not averaged — avoids dilution by zero-scoring playbooks)
  const topConviction = topPlaybook.score * topPlaybook.confidence;

  // euphoria_fade is a sell signal (negative direction), others are buy signals (positive)
  const direction = topPlaybook.playbook === "euphoria_fade" ? -1 : 1;
  const compositeScore = clamp(direction * topConviction, -1, 1);

  // Single gate: score strength + at least one supporting signal
  const isCandidate =
    Math.abs(compositeScore) >= CANDIDATE_SCORE_THRESHOLD &&
    topPlaybook.signals.length >= 1;

  return {
    slug: normalized.slug,
    timestamp: normalized.timestamp,
    normalizedSignals: normalized,
    playbookScores,
    topPlaybook: topPlaybook.playbook,
    compositeScore,
    isCandidate,
  };
}

/**
 * Score all normalized assets and return them ranked by |compositeScore|.
 */
export function scoreUniverse(
  normalized: Map<AssetSlug, NormalizedAssetSignals>,
): ScoredAsset[] {
  const scores: ScoredAsset[] = [];

  for (const [, norm] of normalized) {
    scores.push(scoreAsset(norm));
  }

  // Sort by absolute composite score descending
  return scores.sort(
    (a, b) => Math.abs(b.compositeScore) - Math.abs(a.compositeScore),
  );
}

/**
 * Return only the top N candidates that pass the threshold.
 */
export function getTopCandidates(
  scored: ScoredAsset[],
  topN = 5,
): ScoredAsset[] {
  return scored.filter((s) => s.isCandidate).slice(0, topN);
}

// ─── Logging ──────────────────────────────────────────────────────────────────

export function summarizeScoredAsset(asset: ScoredAsset): string {
  const lines: string[] = [
    `\n[Analyst] ${asset.slug.toUpperCase()} — composite: ${asset.compositeScore.toFixed(3)} | top playbook: ${asset.topPlaybook} | candidate: ${asset.isCandidate}`,
  ];

  for (const ps of asset.playbookScores) {
    lines.push(
      `  [${ps.playbook}] score: ${ps.score.toFixed(3)} conf: ${ps.confidence.toFixed(2)}`,
    );
    if (ps.signals.length > 0) {
      lines.push(`    Signals: ${ps.signals.slice(0, 3).join(" | ")}`);
    }
    if (ps.warnings.length > 0) {
      lines.push(`    Warnings: ${ps.warnings.join(" | ")}`);
    }
  }

  return lines.join("\n");
}

// ─── Standalone runner ────────────────────────────────────────────────────────

if (process.argv[1]?.includes("analyst")) {
  // Quick smoke test with synthetic data
  console.log("=".repeat(60));
  console.log("  MURMUR — Analyst Module (smoke test)");
  console.log("=".repeat(60));

  const now = new Date();
  const makePoints = (base: number, trend: number, n = 30): TimeseriesPoint[] =>
    Array.from({ length: n }, (_, i) => ({
      datetime: new Date(now.getTime() - (n - i) * 86400000).toISOString(),
      value: base + trend * i + (Math.random() - 0.5) * base * 0.1,
    }));

  // Simulate a "breakout" asset
  const breakoutRaw: AssetRawSignals = {
    slug: "ethereum",
    fetchedAt: now.toISOString(),
    signals: {
      social_dominance_total: makePoints(5, 0.1),
      sentiment_weighted_total: makePoints(0.01, 0.002),
      exchange_inflow_usd: makePoints(400_000_000, -5_000_000),
      exchange_outflow_usd: makePoints(450_000_000, 2_000_000),
      age_consumed: makePoints(20_000_000, -100_000),
      daily_active_addresses: makePoints(500_000, 3000),
      network_growth: makePoints(100_000, 1000),
      mvrv_usd: makePoints(1.2, 0.01),
      whale_transaction_count_100k_usd_to_inf: makePoints(8000, 100),
    },
  };

  const normalized = normalizeAsset(breakoutRaw);
  const scored = scoreAsset(normalized);

  console.log(summarizeScoredAsset(scored));
  console.log("\n[Analyst] Done.");
}
