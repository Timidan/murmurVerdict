import * as dotenv from "dotenv";
dotenv.config();

import {
  type AssetSlug,
  type LLMDecision,
  type TreasuryState,
  type ScoredAsset,
  type RiskGateResult,
  type RiskCheck,
  type RiskCheckStatus,
  type SizeBucket,
  type TradeAction,
  MurmurError,
  ASSET_UNIVERSE,
} from "../types/index.js";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class RiskGateError extends MurmurError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "RISK_GATE_ERROR", context);
    this.name = "RiskGateError";
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Default policy — overridden by env / MurmurConfig
const DEFAULT_MAX_NOTIONAL_USD = 500;          // max single trade notional
const DEFAULT_MAX_DAILY_TURNOVER_USD = 1_000;  // max USD traded per 24h
const DEFAULT_MAX_SLIPPAGE_BPS = 50;           // 0.50% max slippage
const DEFAULT_MIN_LIQUIDITY_USD = 50_000;      // minimum pool liquidity
const DEFAULT_COOLDOWN_MS = 2 * 60 * 1000;    // 2 minutes between trades (demo)
const DEFAULT_MAX_POSITIONS = 5;               // max concurrent open positions
const DEFAULT_MAX_CONCENTRATION_PCT = 25;      // max % of portfolio in one asset
const DEFAULT_MAX_DELEGATION_SPEND_USD = 1_000; // lifetime delegation spend cap
const STALE_DATA_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

// Size bucket → fraction of USDC balance
const SIZE_BUCKET_FRACTIONS: Record<SizeBucket, number> = {
  "1pct": 0.01,
  "3pct": 0.03,
  "5pct": 0.05,
};

// ─── Policy Config ────────────────────────────────────────────────────────────

export interface RiskPolicy {
  allowlistedSlugs: AssetSlug[];
  maxNotionalUsd: number;
  maxDailyTurnoverUsd: number;
  maxSlippageBps: number;
  minLiquidityUsd: number;
  cooldownMs: number;
  maxPositions: number;
  maxConcentrationPct: number;
  maxDelegationSpendUsd: number;
  delegationExpiresAt: Date | null;    // null = no expiry set
  delegationSpentUsd: number;          // running total spent under delegation
  dailyTurnoverSpentUsd: number;       // running total for today
  lastTradeAt: Date | null;
}

export function defaultPolicy(overrides?: Partial<RiskPolicy>): RiskPolicy {
  return {
    allowlistedSlugs: [...ASSET_UNIVERSE],
    maxNotionalUsd: DEFAULT_MAX_NOTIONAL_USD,
    maxDailyTurnoverUsd: DEFAULT_MAX_DAILY_TURNOVER_USD,
    maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
    minLiquidityUsd: DEFAULT_MIN_LIQUIDITY_USD,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    maxPositions: DEFAULT_MAX_POSITIONS,
    maxConcentrationPct: DEFAULT_MAX_CONCENTRATION_PCT,
    maxDelegationSpendUsd: DEFAULT_MAX_DELEGATION_SPEND_USD,
    delegationExpiresAt: null,
    delegationSpentUsd: 0,
    dailyTurnoverSpentUsd: 0,
    lastTradeAt: null,
    ...overrides,
  };
}

// ─── Individual Risk Checks ───────────────────────────────────────────────────

function check(
  name: string,
  passed: boolean,
  reason: string,
  status?: RiskCheckStatus,
): RiskCheck {
  return {
    name,
    status: status ?? (passed ? "pass" : "fail"),
    reason,
  };
}

/** Check that the target asset is on the allowlist */
function checkAllowlist(slug: AssetSlug, policy: RiskPolicy): RiskCheck {
  const allowed = policy.allowlistedSlugs.includes(slug);
  return check(
    "allowlist",
    allowed,
    allowed
      ? `${slug} is on the allowlist`
      : `${slug} is NOT on the allowlist — trade blocked`,
  );
}

/** Check that action is "hold" or slug is defined */
function checkActionValidity(
  action: TradeAction,
  slug: AssetSlug | null,
): RiskCheck {
  if (action === "hold") {
    return check("action_validity", true, "Action is hold — no execution needed");
  }
  const valid = slug !== null && slug.trim().length > 0;
  return check(
    "action_validity",
    valid,
    valid ? `Action "${action}" with slug "${slug}" is valid` : "No slug provided for non-hold action",
  );
}

/** Check delegation has not expired */
function checkDelegationExpiry(policy: RiskPolicy): RiskCheck {
  if (!policy.delegationExpiresAt) {
    return check(
      "delegation_expiry",
      true,
      "No expiry set on delegation — valid",
    );
  }
  const now = new Date();
  const expired = now > policy.delegationExpiresAt;
  const minutesLeft = Math.floor(
    (policy.delegationExpiresAt.getTime() - now.getTime()) / 60_000,
  );
  return check(
    "delegation_expiry",
    !expired,
    expired
      ? `Delegation expired at ${policy.delegationExpiresAt.toISOString()}`
      : `Delegation valid for ${minutesLeft} more minutes`,
    expired ? "fail" : minutesLeft < 60 ? "warn" : "pass",
  );
}

/** Check remaining delegation spend cap */
function checkDelegationCap(
  effectiveSizeUsd: number,
  policy: RiskPolicy,
): RiskCheck {
  const remaining = policy.maxDelegationSpendUsd - policy.delegationSpentUsd;
  const fits = effectiveSizeUsd <= remaining;
  return check(
    "delegation_cap",
    fits,
    fits
      ? `Trade $${effectiveSizeUsd.toFixed(2)} fits within remaining cap $${remaining.toFixed(2)}`
      : `Trade $${effectiveSizeUsd.toFixed(2)} exceeds remaining delegation cap $${remaining.toFixed(2)}`,
  );
}

/** Check max single trade notional */
function checkMaxNotional(
  effectiveSizeUsd: number,
  policy: RiskPolicy,
): RiskCheck {
  const fits = effectiveSizeUsd <= policy.maxNotionalUsd;
  return check(
    "max_notional",
    fits,
    fits
      ? `$${effectiveSizeUsd.toFixed(2)} is within max notional $${policy.maxNotionalUsd}`
      : `$${effectiveSizeUsd.toFixed(2)} exceeds max notional $${policy.maxNotionalUsd}`,
  );
}

/** Check daily turnover limit */
function checkDailyTurnover(
  effectiveSizeUsd: number,
  policy: RiskPolicy,
): RiskCheck {
  const projectedTurnover = policy.dailyTurnoverSpentUsd + effectiveSizeUsd;
  const fits = projectedTurnover <= policy.maxDailyTurnoverUsd;
  const remainingToday = policy.maxDailyTurnoverUsd - policy.dailyTurnoverSpentUsd;
  return check(
    "daily_turnover",
    fits,
    fits
      ? `Projected daily turnover $${projectedTurnover.toFixed(2)} within limit $${policy.maxDailyTurnoverUsd}`
      : `Daily turnover limit reached — only $${remainingToday.toFixed(2)} remaining today`,
    fits
      ? projectedTurnover > policy.maxDailyTurnoverUsd * 0.8
        ? "warn"
        : "pass"
      : "fail",
  );
}

/** Check cooldown since last trade */
function checkCooldown(policy: RiskPolicy, isExit = false): RiskCheck {
  // Exits and reduces skip cooldown — fast lane
  if (isExit) {
    return check(
      "cooldown",
      true,
      "Exit/reduce action bypasses cooldown — fast lane",
    );
  }
  if (!policy.lastTradeAt) {
    return check("cooldown", true, "No previous trade — cooldown not applicable");
  }
  const elapsed = Date.now() - policy.lastTradeAt.getTime();
  const ready = elapsed >= policy.cooldownMs;
  const secondsLeft = Math.max(0, (policy.cooldownMs - elapsed) / 1000);
  return check(
    "cooldown",
    ready,
    ready
      ? `Cooldown satisfied — ${Math.floor(elapsed / 1000)}s since last trade`
      : `Cooldown not met — ${secondsLeft.toFixed(0)}s remaining`,
  );
}

/** Check maximum open positions */
function checkMaxPositions(
  action: TradeAction,
  treasury: TreasuryState,
  policy: RiskPolicy,
): RiskCheck {
  // Only applies to new buys
  if (action !== "buy") {
    return check(
      "max_positions",
      true,
      `Action "${action}" — position count check not applicable`,
    );
  }
  const currentPositions = treasury.positions.length;
  const canOpen = currentPositions < policy.maxPositions;
  return check(
    "max_positions",
    canOpen,
    canOpen
      ? `${currentPositions}/${policy.maxPositions} positions open — can add`
      : `Max positions (${policy.maxPositions}) reached — cannot open new position`,
    canOpen
      ? currentPositions >= policy.maxPositions - 1
        ? "warn"
        : "pass"
      : "fail",
  );
}

/** Check portfolio concentration — prevent overweight in one asset */
function checkConcentration(
  slug: AssetSlug,
  effectiveSizeUsd: number,
  action: TradeAction,
  treasury: TreasuryState,
  policy: RiskPolicy,
): RiskCheck {
  if (action !== "buy") {
    return check(
      "concentration",
      true,
      `Action "${action}" — concentration check not applicable`,
    );
  }

  const totalPortfolioUsd = treasury.totalPortfolioUsd;
  if (totalPortfolioUsd <= 0) {
    return check("concentration", true, "Portfolio value is zero — no concentration risk");
  }

  // Find existing position in this asset
  const existingPosition = treasury.positions.find((p) => p.slug === slug);
  const existingUsd = existingPosition ? existingPosition.usdValueAtEntry : 0;

  const projectedExposurePct =
    ((existingUsd + effectiveSizeUsd) / totalPortfolioUsd) * 100;

  const fits = projectedExposurePct <= policy.maxConcentrationPct;
  return check(
    "concentration",
    fits,
    fits
      ? `Projected ${slug} exposure ${projectedExposurePct.toFixed(1)}% within ${policy.maxConcentrationPct}% limit`
      : `Projected ${slug} exposure ${projectedExposurePct.toFixed(1)}% exceeds ${policy.maxConcentrationPct}% limit`,
    fits
      ? projectedExposurePct > policy.maxConcentrationPct * 0.8
        ? "warn"
        : "pass"
      : "fail",
  );
}

/** Check that signal data is fresh enough to act on */
function checkDataFreshness(scoredAsset: ScoredAsset | undefined): RiskCheck {
  if (!scoredAsset) {
    return check("data_freshness", false, "No scored asset data available");
  }

  const signalTime = new Date(scoredAsset.timestamp).getTime();
  const ageMs = Date.now() - signalTime;
  const fresh = ageMs <= STALE_DATA_THRESHOLD_MS;
  const ageMinutes = Math.floor(ageMs / 60_000);

  return check(
    "data_freshness",
    fresh,
    fresh
      ? `Signal data is ${ageMinutes}m old — within ${STALE_DATA_THRESHOLD_MS / 60_000}m threshold`
      : `Signal data is ${ageMinutes}m old — STALE (threshold: ${STALE_DATA_THRESHOLD_MS / 60_000}m)`,
  );
}

/** Check minimum confidence from the LLM decision */
function checkMinConfidence(decision: LLMDecision): RiskCheck {
  const MIN_CONFIDENCE = 0.35;
  const ok = decision.action === "hold" || decision.confidence >= MIN_CONFIDENCE;
  return check(
    "min_confidence",
    ok,
    ok
      ? `Decision confidence ${(decision.confidence * 100).toFixed(1)}% meets minimum ${MIN_CONFIDENCE * 100}%`
      : `Decision confidence ${(decision.confidence * 100).toFixed(1)}% too low — minimum is ${MIN_CONFIDENCE * 100}%`,
  );
}

/** Check LLM confidence vs. requested size — downsize if mismatched */
function checkConfidenceVsSize(decision: LLMDecision): RiskCheck {
  if (decision.action === "hold") {
    return check("confidence_vs_size", true, "Hold action — size check not applicable");
  }

  const { confidence, sizeBucket } = decision;

  // 5pct requires confidence >= 0.70
  if (sizeBucket === "5pct" && confidence < 0.70) {
    return check(
      "confidence_vs_size",
      false,
      `5pct size requires confidence >= 70% — got ${(confidence * 100).toFixed(1)}%. Downsize required.`,
      "warn",
    );
  }

  // 3pct requires confidence >= 0.50
  if (sizeBucket === "3pct" && confidence < 0.50) {
    return check(
      "confidence_vs_size",
      false,
      `3pct size requires confidence >= 50% — got ${(confidence * 100).toFixed(1)}%. Downsize required.`,
      "warn",
    );
  }

  return check(
    "confidence_vs_size",
    true,
    `Confidence ${(confidence * 100).toFixed(1)}% is appropriate for ${sizeBucket} position`,
  );
}

// ─── Size Calculation ─────────────────────────────────────────────────────────

/**
 * Compute the effective USD notional from the requested size bucket.
 * May downsize if confidence does not support the requested bucket.
 */
function computeEffectiveSize(
  decision: LLMDecision,
  treasury: TreasuryState,
  policy: RiskPolicy,
): { effectiveSizeUsd: number; downsized: boolean; originalSizeBucket: SizeBucket } {
  const usdcBalance = Number(treasury.usdcBalance) / 1e6; // USDC has 6 decimals
  const requestedFraction = SIZE_BUCKET_FRACTIONS[decision.sizeBucket];
  let requestedSizeUsd = usdcBalance * requestedFraction;

  // Cap at max notional
  requestedSizeUsd = Math.min(requestedSizeUsd, policy.maxNotionalUsd);

  // Downsize if confidence doesn't support the bucket
  let effectiveSizeUsd = requestedSizeUsd;
  let downsized = false;
  const originalSizeBucket = decision.sizeBucket;

  if (decision.sizeBucket === "5pct" && decision.confidence < 0.70) {
    effectiveSizeUsd = usdcBalance * SIZE_BUCKET_FRACTIONS["3pct"];
    effectiveSizeUsd = Math.min(effectiveSizeUsd, policy.maxNotionalUsd);
    downsized = true;
  } else if (decision.sizeBucket === "3pct" && decision.confidence < 0.50) {
    effectiveSizeUsd = usdcBalance * SIZE_BUCKET_FRACTIONS["1pct"];
    effectiveSizeUsd = Math.min(effectiveSizeUsd, policy.maxNotionalUsd);
    downsized = true;
  }

  return { effectiveSizeUsd, downsized, originalSizeBucket };
}

// ─── Fast-Lane Check ──────────────────────────────────────────────────────────

/**
 * Fast-lane: deterministic exit signals that bypass LLM deliberation cooldown.
 * If ANY of these conditions are met, recommend an immediate risk-off action.
 *
 * Returns true if a fast-lane exit should be triggered.
 */
export function shouldFastLaneExit(scoredAsset: ScoredAsset): {
  triggered: boolean;
  reason: string;
} {
  const m = scoredAsset.normalizedSignals.metrics;

  // Fast lane condition 1: exchange inflows spike > 200% in 24h (raised for testnet validation)
  const inflow = m.exchange_inflow_usd;
  if (inflow && inflow.roc24h !== null && inflow.roc24h > 2.0) {
    return {
      triggered: true,
      reason: `FAST-LANE EXIT: Exchange inflows spiked +${(inflow.roc24h * 100).toFixed(1)}% in 24h — distribution pressure`,
    };
  }

  // Fast lane condition 2: age consumed (dormant circulation) > 500% spike (raised for testnet validation)
  const ageConsumed = m.age_consumed;
  if (ageConsumed && ageConsumed.roc24h !== null && ageConsumed.roc24h > 5.0) {
    return {
      triggered: true,
      reason: `FAST-LANE EXIT: Age consumed spiked +${(ageConsumed.roc24h * 100).toFixed(1)}% — old holders exiting`,
    };
  }

  // Fast lane condition 3: sentiment at extreme euphoria (top 1st percentile — raised for testnet validation)
  const sentiment = m.sentiment_weighted_total;
  if (sentiment && sentiment.percentile > 99) {
    return {
      triggered: true,
      reason: `FAST-LANE EXIT: Sentiment at ${sentiment.percentile.toFixed(0)}th percentile — extreme euphoria`,
    };
  }

  // Fast lane condition 4: social dominance at extreme AND age consumed rising
  const socialDominance = m.social_dominance_total;
  if (
    socialDominance &&
    socialDominance.percentile > 98 &&
    ageConsumed &&
    ageConsumed.roc24h !== null &&
    ageConsumed.roc24h > 0.3
  ) {
    return {
      triggered: true,
      reason: `FAST-LANE EXIT: Social dominance at ${socialDominance.percentile.toFixed(0)}th pct + age consumed rising — euphoria + distribution combo`,
    };
  }

  return { triggered: false, reason: "" };
}

// ─── Main Risk Gate ───────────────────────────────────────────────────────────

/**
 * Run the full deterministic risk gate against a proposed LLM decision.
 * Returns a RiskGateResult with all checks and effective trade parameters.
 */
export function runRiskGate(params: {
  decision: LLMDecision;
  treasury: TreasuryState;
  policy: RiskPolicy;
  scoredAsset?: ScoredAsset;
  liquidityUsd?: number; // from Uniswap quote (populated later if available)
}): RiskGateResult {
  const { decision, treasury, policy, scoredAsset, liquidityUsd } = params;
  const evaluatedAt = new Date().toISOString();
  const checks: RiskCheck[] = [];

  // Fast path: hold requires no checks
  if (decision.action === "hold") {
    return {
      approved: true,
      checks: [
        check("hold_action", true, "Action is hold — no risk checks required"),
      ],
      effectiveSizeUsd: 0,
      maxSlippageBps: policy.maxSlippageBps,
      delegationCapRemaining:
        policy.maxDelegationSpendUsd - policy.delegationSpentUsd,
      evaluatedAt,
    };
  }

  const isExitAction =
    decision.action === "exit" || decision.action === "reduce";

  // ── Step 1: Action + slug validity
  checks.push(checkActionValidity(decision.action, decision.slug ?? null));

  // ── Step 2: Allowlist
  if (decision.slug) {
    checks.push(checkAllowlist(decision.slug, policy));
  }

  // ── Step 3: Delegation expiry
  checks.push(checkDelegationExpiry(policy));

  // ── Step 4: Data freshness
  checks.push(checkDataFreshness(scoredAsset));

  // ── Step 5: Compute effective size
  const usdcBalance = Number(treasury.usdcBalance) / 1e6;
  const { effectiveSizeUsd, downsized, originalSizeBucket } =
    computeEffectiveSize(decision, treasury, policy);

  if (downsized) {
    console.warn(
      `[RiskGate] Downsized from ${originalSizeBucket} due to insufficient confidence (${(decision.confidence * 100).toFixed(1)}%)`,
    );
  }

  // ── Step 6: Max notional
  checks.push(checkMaxNotional(effectiveSizeUsd, policy));

  // ── Step 7: Daily turnover
  checks.push(checkDailyTurnover(effectiveSizeUsd, policy));

  // ── Step 8: Delegation cap
  checks.push(checkDelegationCap(effectiveSizeUsd, policy));

  // ── Step 9: Cooldown (exits skip)
  checks.push(checkCooldown(policy, isExitAction));

  // ── Step 10: Max positions (only for buys)
  checks.push(checkMaxPositions(decision.action, treasury, policy));

  // ── Step 11: Concentration (only for buys)
  if (decision.slug) {
    checks.push(
      checkConcentration(
        decision.slug,
        effectiveSizeUsd,
        decision.action,
        treasury,
        policy,
      ),
    );
  }

  // ── Step 12: Min confidence
  checks.push(checkMinConfidence(decision));

  // ── Step 13: Confidence vs size alignment (warning only)
  checks.push(checkConfidenceVsSize(decision));

  // ── Step 14: Minimum liquidity (if quote available)
  if (liquidityUsd !== undefined) {
    const liquidOk = liquidityUsd >= policy.minLiquidityUsd;
    checks.push(
      check(
        "min_liquidity",
        liquidOk,
        liquidOk
          ? `Pool liquidity $${liquidityUsd.toLocaleString()} meets minimum $${policy.minLiquidityUsd.toLocaleString()}`
          : `Pool liquidity $${liquidityUsd.toLocaleString()} below minimum $${policy.minLiquidityUsd.toLocaleString()}`,
      ),
    );
  }

  // ── Step 15: USDC balance sanity
  const hasBalance = usdcBalance >= effectiveSizeUsd;
  checks.push(
    check(
      "usdc_balance",
      hasBalance,
      hasBalance
        ? `USDC balance $${usdcBalance.toFixed(2)} sufficient for $${effectiveSizeUsd.toFixed(2)} trade`
        : `Insufficient USDC balance $${usdcBalance.toFixed(2)} for $${effectiveSizeUsd.toFixed(2)} trade`,
    ),
  );

  // ── Determine overall approval
  const hardFailures = checks.filter((c) => c.status === "fail");
  const approved = hardFailures.length === 0;

  const delegationCapRemaining =
    policy.maxDelegationSpendUsd - policy.delegationSpentUsd;

  if (approved) {
    const warnings = checks.filter((c) => c.status === "warn");
    console.log(
      `[RiskGate] ✅ APPROVED — $${effectiveSizeUsd.toFixed(2)} | ${checks.length} checks passed, ${warnings.length} warnings`,
    );
  } else {
    console.warn(
      `[RiskGate] ❌ BLOCKED — ${hardFailures.length} hard failure(s): ${hardFailures.map((f) => f.name).join(", ")}`,
    );
  }

  return {
    approved,
    checks,
    effectiveSizeUsd,
    maxSlippageBps: policy.maxSlippageBps,
    delegationCapRemaining,
    evaluatedAt,
  };
}

// ─── Policy Updater ───────────────────────────────────────────────────────────

/**
 * Mutate the policy after a successful trade to keep running totals accurate.
 */
export function updatePolicyAfterTrade(
  policy: RiskPolicy,
  tradeUsd: number,
): RiskPolicy {
  return {
    ...policy,
    delegationSpentUsd: policy.delegationSpentUsd + tradeUsd,
    dailyTurnoverSpentUsd: policy.dailyTurnoverSpentUsd + tradeUsd,
    lastTradeAt: new Date(),
  };
}

/**
 * Reset the daily turnover counter (call at midnight UTC).
 */
export function resetDailyTurnover(policy: RiskPolicy): RiskPolicy {
  return {
    ...policy,
    dailyTurnoverSpentUsd: 0,
  };
}

// ─── Logging ──────────────────────────────────────────────────────────────────

export function summarizeRiskGate(result: RiskGateResult): string {
  const lines: string[] = [
    `\n[RiskGate] ${result.approved ? "✅ APPROVED" : "❌ BLOCKED"} — $${result.effectiveSizeUsd.toFixed(2)} | slippage cap: ${result.maxSlippageBps}bps | delegation remaining: $${result.delegationCapRemaining.toFixed(2)}`,
  ];

  const grouped: Record<RiskCheckStatus, RiskCheck[]> = {
    pass: [],
    warn: [],
    fail: [],
  };
  for (const c of result.checks) {
    grouped[c.status].push(c);
  }

  if (grouped.fail.length > 0) {
    lines.push(`  FAILURES:`);
    for (const c of grouped.fail) {
      lines.push(`    ✗ [${c.name}] ${c.reason}`);
    }
  }
  if (grouped.warn.length > 0) {
    lines.push(`  WARNINGS:`);
    for (const c of grouped.warn) {
      lines.push(`    ⚠ [${c.name}] ${c.reason}`);
    }
  }
  if (grouped.pass.length > 0) {
    lines.push(`  PASSED: ${grouped.pass.map((c) => c.name).join(", ")}`);
  }

  return lines.join("\n");
}

// ─── Standalone runner ────────────────────────────────────────────────────────

if (process.argv[1]?.includes("risk")) {
  console.log("=".repeat(60));
  console.log("  MURMUR — Risk Module (smoke test)");
  console.log("=".repeat(60));

  const policy = defaultPolicy({
    maxNotionalUsd: 500,
    maxDailyTurnoverUsd: 1000,
    maxDelegationSpendUsd: 1000,
    delegationSpentUsd: 200,
    dailyTurnoverSpentUsd: 100,
    lastTradeAt: new Date(Date.now() - 20 * 60 * 1000), // 20m ago
  });

  const mockTreasury: TreasuryState = {
    usdcBalance: BigInt(5000 * 1e6), // $5,000 USDC
    totalPortfolioUsd: 5000,
    positions: [],
    lastUpdatedAt: new Date().toISOString(),
  };

  const mockDecision: LLMDecision = {
    action: "buy",
    slug: "ethereum",
    sizeBucket: "3pct",
    confidence: 0.68,
    holdingHorizon: "24h",
    thesis:
      "Social dominance rising with on-chain confirmation and muted exchange inflows — early breakout conditions present.",
    invalidationCondition:
      "Exchange inflows spike above 30% or sentiment reaches euphoric levels.",
    risks: [
      "Broader market downturn could override the signal",
      "Liquidity conditions on Base may be thin for WETH",
    ],
  };

  const result = runRiskGate({
    decision: mockDecision,
    treasury: mockTreasury,
    policy,
    liquidityUsd: 500_000,
  });

  console.log(summarizeRiskGate(result));
  console.log("\n[RiskGate] Done.");
}
