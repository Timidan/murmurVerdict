import * as dotenv from "dotenv";
dotenv.config();

import {
  type AssetSlug,
  type ScoredAsset,
  type PlaybookScore,
  type NormalizedMetric,
  type SantimentMetric,
  type LLMDecision,
  type DeliberationResult,
  type TradeAction,
  type SizeBucket,
  type HoldingHorizon,
  type StrategyPlaybook,
  MurmurError,
} from "../types/index.js";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class StrategistError extends MurmurError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "STRATEGIST_ERROR", context);
    this.name = "StrategistError";
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Venice AI is OpenAI-compatible — free, private inference
const VENICE_BASE_URL = process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1";

// Model routing: use a lighter model for routine cycles, escalate for high-stakes
const ROUTINE_MODEL = "llama-3.3-70b";
const HIGH_STAKES_MODEL = "llama-3.3-70b"; // Venice flagship model

// Escalate to a stronger model if composite score is very high and size is large
const ESCALATION_SCORE_THRESHOLD = 0.75;
const ESCALATION_SIZE_BUCKET: SizeBucket = "5pct";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 60_000;

// Valid enum values for parsing / validation
const VALID_ACTIONS: TradeAction[] = ["buy", "reduce", "exit", "hold"];
const VALID_SIZE_BUCKETS: SizeBucket[] = ["1pct", "3pct", "5pct"];
const VALID_HORIZONS: HoldingHorizon[] = ["4h", "24h", "72h"];
const VALID_PLAYBOOKS: StrategyPlaybook[] = [
  "early_narrative_breakout",
  "euphoria_fade",
  "capitulation_rebound",
];

// ─── Prompt Construction ──────────────────────────────────────────────────────

function formatMetric(label: string, m: NormalizedMetric | undefined): string {
  if (!m) return `  ${label}: no data`;
  const z = m.zScore.toFixed(2);
  const pct = m.percentile.toFixed(0);
  const roc = m.roc24h !== null ? `Δ24h ${(m.roc24h * 100).toFixed(1)}%` : "";
  const div =
    m.divergenceVsPrice !== null
      ? ` | div_vs_price ${(m.divergenceVsPrice * 100).toFixed(1)}%`
      : "";
  return `  ${label}: raw=${m.raw.toFixed(4)}  z=${z}  p${pct}  ${roc}${div}`;
}

function formatPlaybook(ps: PlaybookScore): string {
  const lines: string[] = [
    `  [${ps.playbook}] score=${ps.score.toFixed(3)} confidence=${ps.confidence.toFixed(2)}`,
  ];
  if (ps.signals.length > 0) {
    lines.push(`    supporting: ${ps.signals.join(" | ")}`);
  }
  if (ps.warnings.length > 0) {
    lines.push(`    warnings:   ${ps.warnings.join(" | ")}`);
  }
  return lines.join("\n");
}

function formatCandidate(asset: ScoredAsset, rank: number): string {
  const m = asset.normalizedSignals.metrics;
  const metricLines = [
    formatMetric("social_dominance", m.social_dominance_total),
    formatMetric("sentiment_weighted", m.sentiment_weighted_total),
    formatMetric("exchange_inflow_usd", m.exchange_inflow_usd),
    formatMetric("exchange_outflow_usd", m.exchange_outflow_usd),
    formatMetric("age_consumed", m.age_consumed),
    formatMetric("daily_active_addresses", m.daily_active_addresses),
    formatMetric("network_growth", m.network_growth),
    formatMetric("mvrv_usd", m.mvrv_usd),
    formatMetric(
      "whale_tx_count_100k+",
      m.whale_transaction_count_100k_usd_to_inf,
    ),
  ].join("\n");

  const playbookLines = asset.playbookScores.map(formatPlaybook).join("\n");

  return `
=== CANDIDATE #${rank}: ${asset.slug.toUpperCase()} ===
composite_score: ${asset.compositeScore.toFixed(4)}
top_playbook:    ${asset.topPlaybook}

NORMALIZED SIGNALS (z-score, percentile, 24h-roc, divergence-vs-price):
${metricLines}

PLAYBOOK SCORES:
${playbookLines}
`;
}

function buildSystemPrompt(): string {
  return `You are Murmur — an attested autonomous DeFi operator running on Base Mainnet.

Your role is to act as an investment committee that resolves signal ambiguity and produces a single, constrained trade decision. You are NOT a freeform trader. You operate within strict boundaries:

ASSET UNIVERSE (Base-tradable):
- ethereum (WETH)
- weth
- wrapped-bitcoin (cbBTC)
- aave
- uniswap (UNI)
- chainlink (LINK)
- aerodrome-finance (AERO)
- virtual-protocol (VIRTUAL)

ACTION SPACE:
- "buy"    → initiate or add to a position
- "reduce" → trim an existing position (partial exit)
- "exit"   → full exit to USDC
- "hold"   → no action this cycle

SIZE BUCKETS (% of portfolio USDC balance):
- "1pct"  → conservative, low-conviction or high-uncertainty
- "3pct"  → moderate conviction
- "5pct"  → high conviction, clean signal stack

HOLDING HORIZONS:
- "4h"  → short-term momentum trade
- "24h" → swing with clear thesis
- "72h" → narrative play with on-chain confirmation

YOUR JOB:
1. Review the scored candidates below.
2. Identify which ONE asset and action makes the most sense right now.
3. Resolve conflicting signals explicitly in your thesis.
4. Output a single JSON decision — nothing else.

PERSONALITY GUIDELINES:
- State confidence as a probability (0.0–1.0)
- Be probabilistic, not certain
- Always state what would INVALIDATE the thesis
- Never be reckless — when in doubt, hold or reduce
- Prefer 1pct size when signals conflict
- "hold" is always a valid and respectable decision

OUTPUT FORMAT — respond with ONLY this JSON, no markdown, no explanation outside it:
{
  "action": "buy" | "reduce" | "exit" | "hold",
  "slug": "<asset-slug or null if hold>",
  "sizeBucket": "1pct" | "3pct" | "5pct",
  "confidence": <0.0–1.0>,
  "holdingHorizon": "4h" | "24h" | "72h",
  "thesis": "<2–4 sentence plain-language reasoning>",
  "invalidationCondition": "<what would make this thesis wrong>",
  "risks": ["<risk 1>", "<risk 2>", "<risk 3>"]
}`;
}

function buildUserPrompt(
  candidates: ScoredAsset[],
  cycleId: string,
  timestamp: string,
  externalContext?: string | null,
): string {
  const candidateBlocks = candidates
    .map((c, i) => formatCandidate(c, i + 1))
    .join("\n");

  const externalBlock =
    externalContext && externalContext.trim().length > 0
      ? `\n\nEXTERNAL PAID CONTEXT (LOCUS):\n${externalContext.trim().slice(0, 4000)}`
      : "";

  return `CYCLE: ${cycleId}
TIMESTAMP: ${timestamp}
CANDIDATES FORWARDED FOR DELIBERATION: ${candidates.length}

${candidateBlocks}${externalBlock}

---
INSTRUCTION: Review all candidates above. Select ONE action and asset (or "hold").
Use external context only as supplemental evidence. Output only the JSON decision.`;
}

// ─── Venice AI Client ─────────────────────────────────────────────────────────

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  temperature: number;
  max_tokens: number;
  response_format?: { type: "json_object" };
}

interface LLMChoice {
  message: { role: string; content: string };
  finish_reason: string;
}

interface LLMResponse {
  id: string;
  model: string;
  choices: LLMChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function callLLM(params: {
  apiKey: string;
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<LLMResponse> {
  const {
    apiKey,
    model,
    messages,
    temperature = 0.2,
    maxTokens = 2048,
  } = params;

  const body: LLMRequest = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${VENICE_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "unknown error");
      throw new StrategistError(`Venice API error ${res.status}: ${errorText}`, {
        model,
        status: res.status,
      });
    }

    return (await res.json()) as LLMResponse;
  } finally {
    clearTimeout(timeout);
  }
}

async function callLLMWithRetry(params: {
  apiKey: string;
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<LLMResponse> {
  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callLLM(params);
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        console.warn(
          `[Strategist] Venice attempt ${attempt}/${MAX_RETRIES} failed — retrying in ${delay}ms: ${lastError.message}`,
        );
        await sleep(delay);
      }
    }
  }

  throw new StrategistError(
    `Venice API failed after ${MAX_RETRIES} attempts: ${lastError.message}`,
    { lastError: lastError.message },
  );
}

// ─── Response Parsing & Validation ───────────────────────────────────────────

interface RawLLMOutput {
  action?: unknown;
  slug?: unknown;
  sizeBucket?: unknown;
  confidence?: unknown;
  holdingHorizon?: unknown;
  thesis?: unknown;
  invalidationCondition?: unknown;
  risks?: unknown;
}

function parseAndValidateDecision(
  raw: string,
  candidates: ScoredAsset[],
): LLMDecision {
  let parsed: RawLLMOutput;

  try {
    parsed = JSON.parse(raw) as RawLLMOutput;
  } catch {
    // Try to extract JSON from response if it's wrapped in text
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new StrategistError("LLM output is not valid JSON", {
        raw: raw.slice(0, 500),
      });
    }
    try {
      parsed = JSON.parse(match[0]) as RawLLMOutput;
    } catch {
      throw new StrategistError(
        "Could not extract valid JSON from LLM output",
        {
          raw: raw.slice(0, 500),
        },
      );
    }
  }

  // Validate action
  const action = parsed.action as string;
  if (!VALID_ACTIONS.includes(action as TradeAction)) {
    throw new StrategistError(`Invalid action: ${action}`, {
      valid: VALID_ACTIONS,
    });
  }

  // Validate slug (null/undefined allowed for "hold")
  let slug: AssetSlug | null = null;
  if (action !== "hold") {
    const rawSlug = parsed.slug as string;
    const validSlugs = candidates.map((c) => c.slug);
    if (!rawSlug || !validSlugs.includes(rawSlug as AssetSlug)) {
      console.warn(
        `[Strategist] LLM chose slug "${rawSlug}" not in candidates — defaulting to hold`,
      );
      return buildHoldDecision("Slug not in candidate universe — safety hold");
    }
    slug = rawSlug as AssetSlug;
  }

  // Validate sizeBucket
  const sizeBucket = parsed.sizeBucket as string;
  if (!VALID_SIZE_BUCKETS.includes(sizeBucket as SizeBucket)) {
    console.warn(
      `[Strategist] Invalid sizeBucket "${sizeBucket}" — defaulting to 1pct`,
    );
  }
  const validatedSizeBucket: SizeBucket = VALID_SIZE_BUCKETS.includes(
    sizeBucket as SizeBucket,
  )
    ? (sizeBucket as SizeBucket)
    : "1pct";

  // Validate confidence
  const confidence = Number(parsed.confidence);
  const validatedConfidence = Number.isFinite(confidence)
    ? Math.max(0, Math.min(1, confidence))
    : 0.5;

  // Validate holdingHorizon
  const horizon = parsed.holdingHorizon as string;
  const validatedHorizon: HoldingHorizon = VALID_HORIZONS.includes(
    horizon as HoldingHorizon,
  )
    ? (horizon as HoldingHorizon)
    : "24h";

  // Validate thesis
  const thesis =
    typeof parsed.thesis === "string" && parsed.thesis.trim().length > 0
      ? parsed.thesis.trim()
      : "No thesis provided.";

  // Validate invalidation condition
  const invalidationCondition =
    typeof parsed.invalidationCondition === "string" &&
    parsed.invalidationCondition.trim().length > 0
      ? parsed.invalidationCondition.trim()
      : "Thesis conditions no longer hold.";

  // Validate risks
  const risks = Array.isArray(parsed.risks)
    ? ((parsed.risks as unknown[])
        .filter((r) => typeof r === "string")
        .slice(0, 5) as string[])
    : ["Unspecified risk"];

  return {
    action: action as TradeAction,
    slug: slug ?? ("ethereum" as AssetSlug), // fallback slug (only used if action != hold)
    sizeBucket: validatedSizeBucket,
    confidence: validatedConfidence,
    holdingHorizon: validatedHorizon,
    thesis,
    invalidationCondition,
    risks,
    rawResponse: raw,
  };
}

function buildHoldDecision(reason: string): LLMDecision {
  return {
    action: "hold",
    slug: "ethereum" as AssetSlug,
    sizeBucket: "1pct",
    confidence: 0,
    holdingHorizon: "24h",
    thesis: reason,
    invalidationCondition: "N/A — no position taken",
    risks: [],
    rawResponse: undefined,
  };
}

// ─── Model Selection ──────────────────────────────────────────────────────────

function selectModel(candidates: ScoredAsset[]): string {
  if (candidates.length === 0) return ROUTINE_MODEL;

  const topCandidate = candidates[0];
  if (!topCandidate) return ROUTINE_MODEL;

  // Escalate to a stronger model for very high-conviction, large decisions
  const isHighStakes =
    Math.abs(topCandidate.compositeScore) >= ESCALATION_SCORE_THRESHOLD;

  if (isHighStakes) {
    console.log(
      `[Strategist] High-stakes cycle (score=${topCandidate.compositeScore.toFixed(3)}) — escalating to ${HIGH_STAKES_MODEL}`,
    );
    return HIGH_STAKES_MODEL;
  }

  return ROUTINE_MODEL;
}

// ─── Main Deliberation ────────────────────────────────────────────────────────

/**
 * Run the deliberation step: take top candidates from the Analyst,
 * call the Venice AI LLM, and return a structured decision.
 */
export async function deliberate(params: {
  apiKey: string;
  candidates: ScoredAsset[];
  cycleId: string;
  forceHold?: boolean;
  externalContext?: string | null;
}): Promise<DeliberationResult> {
  const { apiKey, candidates, cycleId, forceHold = false, externalContext = null } = params;
  const deliberatedAt = new Date().toISOString();

  // Fast path: no candidates or forced hold
  if (candidates.length === 0 || forceHold) {
    const reason =
      candidates.length === 0
        ? "No candidates passed scoring threshold — holding"
        : "Force-hold flag set — no deliberation required";
    console.log(`[Strategist] ${reason}`);

    return {
      decision: buildHoldDecision(reason),
      candidatesConsidered: [],
      modelUsed: "none",
      promptTokens: 0,
      completionTokens: 0,
      deliberatedAt,
    };
  }

  const model = selectModel(candidates);
  const timestamp = deliberatedAt;

  const messages: LLMMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    {
      role: "user",
      content: buildUserPrompt(candidates, cycleId, timestamp, externalContext),
    },
  ];

  console.log(
    `[Strategist] Deliberating ${candidates.length} candidate(s) via ${model}...`,
  );

  let response: LLMResponse;
  try {
    response = await callLLMWithRetry({
      apiKey,
      model,
      messages,
      temperature: 0.1,
      maxTokens: 1024,
    });
  } catch (err) {
    console.error(
      `[Strategist] Venice call failed — defaulting to hold: ${(err as Error).message}`,
    );
    return {
      decision: buildHoldDecision(
        `LLM unavailable — safety hold. Error: ${(err as Error).message}`,
      ),
      candidatesConsidered: candidates.map((c) => c.slug),
      modelUsed: model,
      promptTokens: 0,
      completionTokens: 0,
      deliberatedAt,
    };
  }

  const rawContent = response.choices[0]?.message?.content ?? "";
  const usage = response.usage;

  let decision: LLMDecision;
  try {
    decision = parseAndValidateDecision(rawContent, candidates);
  } catch (err) {
    console.error(
      `[Strategist] Failed to parse LLM output — defaulting to hold: ${(err as Error).message}`,
    );
    decision = buildHoldDecision(
      `Parse error — safety hold. Raw: ${rawContent.slice(0, 200)}`,
    );
  }

  console.log(
    `[Strategist] Decision: ${decision.action.toUpperCase()} ${decision.action !== "hold" ? decision.slug : ""} | confidence=${decision.confidence.toFixed(2)} | model=${model}`,
  );
  console.log(`[Strategist] Thesis: ${decision.thesis}`);

  return {
    decision,
    candidatesConsidered: candidates.map((c) => c.slug),
    modelUsed: response.model ?? model,
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    deliberatedAt,
  };
}

// ─── Deliberation Summary ─────────────────────────────────────────────────────

export function summarizeDeliberation(result: DeliberationResult): string {
  const { decision: d, modelUsed, promptTokens, completionTokens } = result;
  return [
    `\n[Strategist] Deliberation Summary`,
    `  Model:        ${modelUsed}`,
    `  Tokens:       ${promptTokens} prompt / ${completionTokens} completion`,
    `  Action:       ${d.action.toUpperCase()}`,
    `  Asset:        ${d.action !== "hold" ? d.slug : "—"}`,
    `  Size:         ${d.sizeBucket}`,
    `  Confidence:   ${(d.confidence * 100).toFixed(1)}%`,
    `  Horizon:      ${d.holdingHorizon}`,
    `  Thesis:       ${d.thesis}`,
    `  Invalidation: ${d.invalidationCondition}`,
    `  Risks:        ${d.risks.join(" | ")}`,
  ].join("\n");
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Standalone runner ────────────────────────────────────────────────────────

if (process.argv[1]?.includes("strategist")) {
  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) {
    console.error("[Strategist] VENICE_API_KEY not set");
    process.exit(1);
  }

  // Construct a synthetic candidate for smoke-testing
  const mockCandidate: ScoredAsset = {
    slug: "ethereum",
    timestamp: new Date().toISOString(),
    normalizedSignals: {
      slug: "ethereum",
      timestamp: new Date().toISOString(),
      metrics: {
        social_dominance_total: {
          raw: 8.4,
          zScore: 1.8,
          percentile: 82,
          roc1h: 0.02,
          roc24h: 0.14,
          roc7d: 0.31,
          divergenceVsPrice: 0.06,
        },
        sentiment_weighted_total: {
          raw: 0.045,
          zScore: 1.2,
          percentile: 68,
          roc1h: 0.01,
          roc24h: 0.09,
          roc7d: 0.22,
          divergenceVsPrice: 0.03,
        },
        exchange_inflow_usd: {
          raw: 380_000_000,
          zScore: -0.5,
          percentile: 35,
          roc1h: null,
          roc24h: -0.08,
          roc7d: -0.12,
          divergenceVsPrice: null,
        },
        whale_transaction_count_100k_usd_to_inf: {
          raw: 9200,
          zScore: 0.9,
          percentile: 71,
          roc1h: null,
          roc24h: 0.11,
          roc7d: 0.18,
          divergenceVsPrice: null,
        },
        daily_active_addresses: {
          raw: 545_000,
          zScore: 0.7,
          percentile: 65,
          roc1h: null,
          roc24h: 0.04,
          roc7d: 0.09,
          divergenceVsPrice: null,
        },
        mvrv_usd: {
          raw: 1.29,
          zScore: 0.3,
          percentile: 55,
          roc1h: null,
          roc24h: 0.02,
          roc7d: 0.07,
          divergenceVsPrice: null,
        },
        age_consumed: {
          raw: 22_000_000,
          zScore: 0.1,
          percentile: 48,
          roc1h: null,
          roc24h: 0.03,
          roc7d: -0.05,
          divergenceVsPrice: null,
        },
      },
    },
    playbookScores: [
      {
        playbook: "early_narrative_breakout",
        score: 0.68,
        confidence: 0.74,
        signals: [
          "Social dominance rising +14.0% (24h)",
          "Sentiment positive but not euphoric",
          "Exchange inflows flat — no immediate sell pressure",
          "Whale transaction count rising",
        ],
        warnings: [],
      },
      {
        playbook: "euphoria_fade",
        score: 0.12,
        confidence: 0.4,
        signals: [],
        warnings: ["Sentiment not yet euphoric"],
      },
      {
        playbook: "capitulation_rebound",
        score: 0.05,
        confidence: 0.2,
        signals: [],
        warnings: ["Sentiment not bearish enough for rebound play"],
      },
    ],
    topPlaybook: "early_narrative_breakout",
    compositeScore: 0.52,
    isCandidate: true,
  };

  deliberate({
    apiKey,
    candidates: [mockCandidate],
    cycleId: "smoke-test-001",
  })
    .then((result) => {
      console.log(summarizeDeliberation(result));
      process.exit(0);
    })
    .catch((err) => {
      console.error("[Strategist] Fatal:", err);
      process.exit(1);
    });
}
