import * as dotenv from "dotenv";
dotenv.config();

import { randomUUID } from "crypto";
import cron from "node-cron";

import { fetchUniverse, validateApiKey } from "../scout/index.js";
import {
  normalizeUniverse,
  scoreUniverse,
  getTopCandidates,
} from "../analyst/index.js";
import { deliberate, summarizeDeliberation } from "../strategist/index.js";
import {
  runRiskGate,
  defaultPolicy,
  updatePolicyAfterTrade,
  resetDailyTurnover,
  summarizeRiskGate,
  type RiskPolicy,
} from "../risk/index.js";
import {
  execute,
  getUsdcBalance,
  createClients,
  BASE_TOKENS,
  refreshPortfolio,
} from "../executor/index.js";
import {
  buildReceipt,
  notarize,
  summarizeNotarization,
} from "../notary/index.js";

import {
  type AssetSlug,
  type TreasuryState,
  type LoopCycle,
  type LoopPhase,
  type DecisionReceipt,
  type ScoredAsset,
  type DashboardSnapshot,
  type DecisionLogEntry,
  ASSET_UNIVERSE,
  TESTNET_UNIVERSE,
  MurmurError,
} from "../types/index.js";

import { startWsServer, broadcastPhase, broadcastSnapshot } from "../ws/index.js";
import { startPriceFeed, stopPriceFeed, getPriceState, hasPriceData } from "../price/index.js";
import type { PriceFeedState, AssetRawSignals } from "../types/index.js";
import {
  DEFAULT_AGENT_WALLET,
  createDefaultEnsResolution,
  resolveAgentEns,
} from "../integrations/ens.js";
import { fetchLocusMarketContext } from "../integrations/locus.js";
import { startX402Server } from "../api/x402.js";

// ─── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  const required = ["SANTIMENT_API_KEY", "BASE_RPC_URL"];

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new MurmurError(
      `Missing required environment variables: ${missing.join(", ")}`,
      "CONFIG_ERROR",
    );
  }

  const rawAgentPrivateKey = process.env.AGENT_PRIVATE_KEY?.trim() ?? "";
  const rawAgentAddress = process.env.AGENT_ADDRESS?.trim() ?? "";

  return {
    santimentApiKey: process.env.SANTIMENT_API_KEY!,
    veniceApiKey: process.env.VENICE_API_KEY ?? "",
    uniswapApiKey: process.env.UNISWAP_API_KEY ?? "",
    baseRpcUrl: process.env.BASE_RPC_URL!,
    agentPrivateKey: rawAgentPrivateKey.startsWith("0x")
      ? (rawAgentPrivateKey as `0x${string}`)
      : null,
    agentAddress: rawAgentAddress.startsWith("0x")
      ? (rawAgentAddress as `0x${string}`)
      : null,
    filecoinApiKey: process.env.FILECOIN_API_TOKEN ?? "",
    delegationMaxNotionalUsd: Number(
      process.env.DELEGATION_MAX_NOTIONAL_USD ?? 500,
    ),
    delegationDailyTurnoverUsd: Number(
      process.env.DELEGATION_DAILY_TURNOVER_USD ?? 1000,
    ),
    signalWindowDays: Number(process.env.SIGNAL_WINDOW_DAYS ?? 30),
    candidateTopN: Number(process.env.CANDIDATE_TOP_N ?? 1),
    cronSchedule: process.env.CRON_SCHEDULE ?? "*/2 * * * *",
    dryRun: process.env.DRY_RUN === "true",
    skipOnChain: process.env.SKIP_ON_CHAIN === "true",
    skipFilecoin: process.env.SKIP_FILECOIN === "true",
    locusApiKey: process.env.LOCUS_API_KEY ?? "",
  };
}

// ─── State ─────────────────────────────────────────────────────────────────────

let policy: RiskPolicy;
let treasuryState: TreasuryState;
let receipts: DecisionReceipt[] = [];
let isRunning = false;
let lastResetDate = new Date().toUTCString().slice(0, 16); // "Day, DD Mon YYYY"

let decisionLog: DecisionLogEntry[] = [];
let lastScoredAssets: ScoredAsset[] = [];
let lastRiskGate: import("../types/index.js").RiskGateResult | null = null;
let cycleCount = 0;
const uptimeSince = new Date().toISOString();

// Santiment cache — refreshed every 30 minutes, not every cycle
let cachedSantimentData: Map<AssetSlug, AssetRawSignals> | null = null;
let lastSantimentFetch = 0;
const SANTIMENT_REFRESH_MS = 30 * 60 * 1000;

// ENS identity
let ensResolution = createDefaultEnsResolution(DEFAULT_AGENT_WALLET);

function buildSnapshot(
  config: ReturnType<typeof loadConfig>,
  currentCycle: DashboardSnapshot["currentCycle"] = null,
): DashboardSnapshot {
  return {
    treasury: treasuryState ?? {
      usdcBalance: BigInt(0),
      totalPortfolioUsd: 0,
      positions: [],
      lastUpdatedAt: new Date().toISOString(),
    },
    scoredAssets: lastScoredAssets,
    lastDecisions: decisionLog.slice(-20),
    riskGate: lastRiskGate,
    currentCycle,
    config: {
      network: "Base Sepolia",
      cronSchedule: config.cronSchedule,
      dryRun: config.dryRun,
      maxNotionalUsd: config.delegationMaxNotionalUsd,
      maxDailyTurnoverUsd: config.delegationDailyTurnoverUsd,
    },
    cycleCount,
    uptimeSince,
  };
}

function initPolicy(config: ReturnType<typeof loadConfig>): RiskPolicy {
  return defaultPolicy({
    maxNotionalUsd: config.delegationMaxNotionalUsd,
    maxDailyTurnoverUsd: config.delegationDailyTurnoverUsd,
    maxDelegationSpendUsd: config.delegationDailyTurnoverUsd,
  });
}

async function refreshTreasuryState(
  config: ReturnType<typeof loadConfig>,
): Promise<TreasuryState> {
  if (!config.agentPrivateKey || !config.agentAddress) {
    return {
      usdcBalance: BigInt(1000 * 1e6),
      totalPortfolioUsd: 1000,
      positions: treasuryState?.positions ?? [],
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  try {
    const { publicClient } = createClients({
      rpcUrl: config.baseRpcUrl,
      privateKey: config.agentPrivateKey,
    });

    return await refreshPortfolio(publicClient, config.agentAddress);
  } catch (err) {
    console.warn(
      `[Loop] Could not refresh treasury state: ${(err as Error).message}`,
    );
    return (
      treasuryState ?? {
        usdcBalance: BigInt(0),
        totalPortfolioUsd: 0,
        positions: [],
        lastUpdatedAt: new Date().toISOString(),
      }
    );
  }
}

// ─── Logging ───────────────────────────────────────────────────────────────────

function log(phase: LoopPhase, message: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${phase.toUpperCase().padEnd(12)}] ${message}`);
}

function separator(label?: string) {
  const line = "─".repeat(60);
  if (label) {
    const pad = Math.max(0, 60 - label.length - 4);
    const left = Math.floor(pad / 2);
    const right = pad - left;
    console.log(`${"─".repeat(left)} ${label} ${"─".repeat(right)}`);
  } else {
    console.log(line);
  }
}

// ─── Daily Reset ───────────────────────────────────────────────────────────────

function checkDailyReset() {
  const currentDate = new Date().toUTCString().slice(0, 16);
  if (currentDate !== lastResetDate) {
    log("idle", "Daily reset — resetting turnover counters");
    policy = resetDailyTurnover(policy);
    lastResetDate = currentDate;
  }
}

// ─── Phase: Sense ─────────────────────────────────────────────────────────────

async function runSense(config: ReturnType<typeof loadConfig>) {
  log(
    "sense",
    `Fetching ${TESTNET_UNIVERSE.length} asset(s) over ${config.signalWindowDays}d window...`,
  );

  const universe = await fetchUniverse({
    apiKey: config.santimentApiKey,
    windowDays: config.signalWindowDays,
    interval: "1d",
    assets: [...TESTNET_UNIVERSE],
  });

  log("sense", `Universe fetched — ${universe.size} assets`);
  return universe;
}

// ─── Phase: Normalize + Score ─────────────────────────────────────────────────

function runNormalizeAndScore(
  universe: Awaited<ReturnType<typeof runSense>>,
  topN: number,
) {
  log("normalize", "Normalizing signals...");
  const normalized = normalizeUniverse(universe);

  log("score", "Scoring across 3 playbooks...");
  const scored = scoreUniverse(normalized);

  for (const asset of scored) {
    const candidateFlag = asset.isCandidate ? "✓ candidate" : "  skipped";
    log(
      "score",
      `${asset.slug.padEnd(22)} composite=${asset.compositeScore.toFixed(3).padStart(7)}  top=${asset.topPlaybook}  ${candidateFlag}`,
    );
  }

  const candidates = getTopCandidates(scored, topN);
  log("score", `${candidates.length} candidate(s) forwarded to deliberation`);

  return { scored, candidates };
}

// ─── Santiment Cache ─────────────────────────────────────────────────────────

async function refreshSantimentCache(config: ReturnType<typeof loadConfig>) {
  const now = Date.now();
  if (cachedSantimentData && now - lastSantimentFetch < SANTIMENT_REFRESH_MS) {
    log("sense", `Using cached Santiment data (${Math.round((now - lastSantimentFetch) / 60000)}m old)`);
    return cachedSantimentData;
  }

  log("sense", "Refreshing Santiment data cache...");
  cachedSantimentData = await runSense(config);
  lastSantimentFetch = now;
  return cachedSantimentData;
}

// ─── Regime Detection (from Santiment scores) ────────────────────────────────

function detectRegime(scored: ScoredAsset[]): "bullish" | "bearish" | "neutral" {
  if (scored.length === 0) return "neutral";
  const eth = scored.find(s => s.slug === "ethereum") ?? scored[0]!;

  if (eth.topPlaybook === "early_narrative_breakout" && eth.compositeScore > 0.15) {
    return "bullish";
  }
  if (eth.topPlaybook === "euphoria_fade" && eth.compositeScore < -0.15) {
    return "bearish";
  }
  if (eth.topPlaybook === "capitulation_rebound" && eth.compositeScore > 0.15) {
    return "bullish";
  }
  return "neutral";
}

// ─── Price-Driven Trading Decision ───────────────────────────────────────────

function shouldTradeOnPrice(
  priceState: PriceFeedState,
  regime: "bullish" | "bearish" | "neutral",
): { action: "buy" | "exit" | "hold"; reason: string; confidence: number } {
  const { momentum1m, momentum5m, currentPrice, high5m, low5m } = priceState;

  // BUY: price breaking 5m high + positive momentum + not bearish regime
  if (
    regime !== "bearish" &&
    momentum1m > 0.03 &&
    momentum5m > 0.02 &&
    currentPrice >= high5m * 0.999
  ) {
    return {
      action: "buy",
      confidence: Math.min(0.5 + Math.abs(momentum5m) * 2, 0.85),
      reason: `Price breaking 5m high ($${currentPrice.toFixed(2)}) | 1m: +${momentum1m.toFixed(3)}% | 5m: +${momentum5m.toFixed(3)}% | regime: ${regime}`,
    };
  }

  // EXIT: price breaking 5m low + negative momentum
  if (
    momentum1m < -0.03 &&
    momentum5m < -0.02 &&
    currentPrice <= low5m * 1.001
  ) {
    return {
      action: "exit",
      confidence: Math.min(0.5 + Math.abs(momentum5m) * 2, 0.85),
      reason: `Price breaking 5m low ($${currentPrice.toFixed(2)}) | 1m: ${momentum1m.toFixed(3)}% | 5m: ${momentum5m.toFixed(3)}% | regime: ${regime}`,
    };
  }

  // Bullish regime + any positive momentum → buy
  if (regime === "bullish" && momentum1m > 0.01) {
    return {
      action: "buy",
      confidence: 0.45,
      reason: `Bullish regime + positive momentum ($${currentPrice.toFixed(2)}) | 1m: +${momentum1m.toFixed(3)}%`,
    };
  }

  return { action: "hold", confidence: 0, reason: "No price trigger" };
}

// ─── Phase: Deliberate ────────────────────────────────────────────────────────

async function runDeliberate(
  candidates: ScoredAsset[],
  cycleId: string,
  config: ReturnType<typeof loadConfig>,
  forceHold = false,
  externalContext?: string | null,
) {
  if (!config.veniceApiKey) {
    log("deliberate", "VENICE_API_KEY not set — defaulting to hold");
    return await deliberate({
      apiKey: "",
      candidates,
      cycleId,
      forceHold: true,
      externalContext,
    });
  }

  const result = await deliberate({
    apiKey: config.veniceApiKey,
    candidates,
    cycleId,
    forceHold,
    externalContext,
  });

  console.log(summarizeDeliberation(result));
  return result;
}

// ─── Phase: Risk Gate ─────────────────────────────────────────────────────────

function runRiskGatePhase(
  deliberationResult: Awaited<ReturnType<typeof runDeliberate>>,
  scored: ScoredAsset[],
) {
  const decision = deliberationResult.decision;
  const scoredAsset = scored.find((s) => s.slug === decision.slug);

  const result = runRiskGate({
    decision,
    treasury: treasuryState,
    policy,
    scoredAsset,
  });

  console.log(summarizeRiskGate(result));
  return result;
}

// ─── Phase: Execute ───────────────────────────────────────────────────────────

async function runExecute(
  deliberationResult: Awaited<ReturnType<typeof runDeliberate>>,
  riskGateResult: ReturnType<typeof runRiskGatePhase>,
  config: ReturnType<typeof loadConfig>,
) {
  const { decision } = deliberationResult;

  if (decision.action === "hold") {
    log("execute", "Action is hold — no execution");
    return null;
  }

  if (!riskGateResult.approved) {
    log("execute", "Risk gate blocked execution — skipping");
    return null;
  }

  if (config.dryRun) {
    log(
      "execute",
      `DRY RUN — would execute: ${decision.action.toUpperCase()} ${decision.slug} ($${riskGateResult.effectiveSizeUsd.toFixed(2)})`,
    );
    return null;
  }

  if (!config.agentPrivateKey) {
    log("execute", "No AGENT_PRIVATE_KEY configured — skipping live execution");
    return null;
  }

  log(
    "execute",
    `Executing: ${decision.action.toUpperCase()} ${decision.slug} | $${riskGateResult.effectiveSizeUsd.toFixed(2)}`,
  );

  const result = await execute({
    decision,
    riskGate: riskGateResult,
    uniswapApiKey: config.uniswapApiKey,
    rpcUrl: config.baseRpcUrl,
    privateKey: config.agentPrivateKey,
  });

  log("execute", `✅ Swap confirmed — tx: ${result.txHash}`);
  log("execute", `   BaseScan: https://sepolia.basescan.org/tx/${result.txHash}`);

  // Update policy counters
  policy = updatePolicyAfterTrade(policy, riskGateResult.effectiveSizeUsd);

  return result;
}

// ─── Phase: Attest ────────────────────────────────────────────────────────────

async function runAttest(
  cycleId: string,
  scored: ScoredAsset[],
  deliberationResult: Awaited<ReturnType<typeof runDeliberate>>,
  riskGateResult: ReturnType<typeof runRiskGatePhase>,
  executionResult: Awaited<ReturnType<typeof runExecute>>,
  config: ReturnType<typeof loadConfig>,
): Promise<DecisionReceipt> {
  if (!config.agentAddress) {
    throw new MurmurError(
      "AGENT_ADDRESS is required to build an attested receipt",
      "CONFIG_ERROR",
    );
  }

  const capBefore = policy.maxDelegationSpendUsd - policy.delegationSpentUsd;
  const capAfter = capBefore - riskGateResult.effectiveSizeUsd;

  const receipt = buildReceipt({
    cycleId,
    agentAddress: config.agentAddress,
    scoredAssets: scored,
    deliberation: deliberationResult,
    riskGate: riskGateResult,
    execution: executionResult,
    delegationCapBefore: capBefore,
    delegationCapAfter: capAfter,
  });

  log("attest", `Receipt built — hash: ${receipt.receiptHash.slice(0, 18)}...`);

  const notarized = await notarize({
    receipt,
    filecoinApiKey: config.filecoinApiKey,
    rpcUrl: config.baseRpcUrl,
    privateKey: config.agentPrivateKey,
    agentAddress: config.agentAddress,
    skipOnChain: config.skipOnChain || !config.agentPrivateKey,
    skipFilecoin: config.skipFilecoin || !config.filecoinApiKey,
  });

  console.log(summarizeNotarization(notarized));

  receipts.push(notarized.receipt);

  // Keep only last 100 receipts in memory
  if (receipts.length > 100) {
    receipts = receipts.slice(-100);
  }

  return notarized.receipt;
}

// ─── Full Cycle ───────────────────────────────────────────────────────────────

async function runCycle(
  config: ReturnType<typeof loadConfig>,
  triggeredBy: LoopCycle["triggeredBy"] = "cron",
): Promise<LoopCycle> {
  const cycleId = randomUUID();
  const startedAt = new Date().toISOString();

  const cycle: LoopCycle = {
    cycleId,
    startedAt,
    phase: "sense",
    triggeredBy,
  };

  separator(`CYCLE ${cycleId.slice(0, 8)} — ${startedAt}`);

  try {
    // ── 1. Daily reset check
    checkDailyReset();

    // ── 2. Refresh treasury
    treasuryState = await refreshTreasuryState(config);
    log(
      "sense",
      `Treasury: $${treasuryState.totalPortfolioUsd.toFixed(2)} total | USDC: $${(Number(treasuryState.usdcBalance) / 1e6).toFixed(2)}`,
    );

    // ── 3. Santiment (cached, refreshed every 30 min)
    cycle.phase = "sense";
    broadcastPhase(cycleId, "sense", new Date().toISOString());
    const universe = await refreshSantimentCache(config);

    // ── 4. Normalize + Score
    cycle.phase = "normalize";
    broadcastPhase(cycleId, "normalize", new Date().toISOString());
    const { scored, candidates } = runNormalizeAndScore(
      universe,
      config.candidateTopN,
    );
    lastScoredAssets = scored;
    broadcastPhase(cycleId, "score", new Date().toISOString());

    // ── 5. Detect regime from Santiment
    const regime = detectRegime(scored);
    log("score", `Regime: ${regime.toUpperCase()} | top candidate: ${candidates[0]?.slug ?? "none"}`);

    // ── 5b. Fetch paid external context via Locus
    const locusContext = await fetchLocusMarketContext({
      apiKey: config.locusApiKey,
      candidates: candidates.length > 0 ? candidates : scored.slice(0, 1),
      cycleId,
    });
    const externalContext = locusContext.promptContext;
    if (locusContext.status === "ready") {
      log("deliberate", `Locus context ready — ${locusContext.sources.length} source(s)`);
    } else if (locusContext.status !== "disabled") {
      log("deliberate", `Locus: ${locusContext.error ?? "unavailable"}`);
    }

    // ── 6. Price-driven deliberation (dual-lane)
    cycle.phase = "deliberate";
    broadcastPhase(cycleId, "deliberate", new Date().toISOString());

    let finalDeliberation;
    const priceState = getPriceState();

    if (hasPriceData()) {
      log("deliberate", `ETH/USD: $${priceState.currentPrice.toFixed(2)} | 1m: ${priceState.momentum1m.toFixed(3)}% | 5m: ${priceState.momentum5m.toFixed(3)}%`);

      const priceTrigger = shouldTradeOnPrice(priceState, regime);

      if (priceTrigger.action !== "hold") {
        log("deliberate", `Price trigger: ${priceTrigger.action.toUpperCase()} — ${priceTrigger.reason}`);

        // Use Venice AI to narrate/validate
        const result = await runDeliberate(candidates, cycleId, config, false, externalContext);
        finalDeliberation = result;

        // Override with price-driven action if strong or LLM agrees
        if (priceTrigger.confidence >= 0.6 || result.decision.action === priceTrigger.action) {
          finalDeliberation = {
            ...result,
            decision: {
              ...result.decision,
              action: priceTrigger.action,
              slug: "ethereum" as AssetSlug,
              sizeBucket: (priceTrigger.confidence >= 0.7 ? "3pct" : "1pct") as "1pct" | "3pct" | "5pct",
              confidence: priceTrigger.confidence,
              thesis: `${priceTrigger.reason} | LLM: ${result.decision.thesis}`,
              invalidationCondition: priceTrigger.action === "buy"
                ? "Price drops below 5m low or momentum reverses"
                : "Price recovers above 5m high",
              risks: ["Price momentum can reverse quickly", "Testnet liquidity may cause slippage"],
            },
          };
        }
      } else {
        log("deliberate", `No price trigger — using Santiment + LLM deliberation`);
        finalDeliberation = await runDeliberate(candidates, cycleId, config, false, externalContext);
      }
    } else {
      log("deliberate", "No price data yet — using Santiment-only deliberation");
      finalDeliberation = await runDeliberate(candidates, cycleId, config, false, externalContext);
    }

    // ── 7. Risk gate
    cycle.phase = "risk_gate";
    broadcastPhase(cycleId, "risk_gate", new Date().toISOString());
    const riskGateResult = runRiskGatePhase(finalDeliberation, scored);
    lastRiskGate = riskGateResult;

    // ── 8. Quote (embedded in execute)
    cycle.phase = "quote";
    log("quote", "Requesting Uniswap quote...");

    // ── 9. Execute
    cycle.phase = "execute";
    broadcastPhase(cycleId, "execute", new Date().toISOString());
    const executionResult = await runExecute(
      finalDeliberation,
      riskGateResult,
      config,
    );

    // ── 9.5 Refresh treasury after trade
    if (executionResult) {
      treasuryState = await refreshTreasuryState(config);
      log("execute", `Treasury refreshed — $${treasuryState.totalPortfolioUsd.toFixed(2)} total | ${treasuryState.positions.length} positions`);
    }

    // ── 10. Attest (skip if no agent address configured)
    let receipt: DecisionReceipt | undefined;
    if (config.agentAddress) {
      cycle.phase = "attest";
      receipt = await runAttest(
        cycleId,
        scored,
        finalDeliberation,
        riskGateResult,
        executionResult,
        config,
      );
    } else {
      log("attest", "No AGENT_ADDRESS configured — skipping attestation");
    }

    cycle.phase = "idle";
    cycle.completedAt = new Date().toISOString();
    cycle.receipt = receipt;

    const elapsed = Date.now() - new Date(startedAt).getTime();
    separator();
    log(
      "idle",
      `✅ Cycle complete in ${(elapsed / 1000).toFixed(1)}s | action=${finalDeliberation.decision.action.toUpperCase()} | next cycle in ~${config.cronSchedule.includes("15") ? "15" : "?"}m`,
    );
    separator();

    // ── Dashboard: log decision and broadcast snapshot
    cycleCount++;
    const logEntry: DecisionLogEntry = {
      cycleId,
      timestamp: new Date().toISOString(),
      action: finalDeliberation.decision.action,
      slug: finalDeliberation.decision.action === "hold" ? null : finalDeliberation.decision.slug,
      thesis: finalDeliberation.decision.thesis,
      confidence: finalDeliberation.decision.confidence,
      riskApproved: riskGateResult.approved,
      effectiveSizeUsd: riskGateResult.effectiveSizeUsd,
      result: executionResult ? "executed" : riskGateResult.approved ? (config.dryRun ? "dry-run" : "hold") : "blocked",
      pnlPct: null,
    };
    decisionLog.push(logEntry);
    if (decisionLog.length > 50) decisionLog = decisionLog.slice(-50);

    broadcastSnapshot(buildSnapshot(config));

    return cycle;
  } catch (err) {
    const message = (err as Error).message;
    cycle.error = message;
    cycle.phase = "idle";
    cycle.completedAt = new Date().toISOString();

    separator();
    log("idle", `❌ Cycle failed: ${message}`);
    separator();

    console.error("[Loop] Cycle error details:", err);

    return cycle;
  }
}

// ─── Startup Checks ───────────────────────────────────────────────────────────

async function runStartupChecks(config: ReturnType<typeof loadConfig>) {
  separator("MURMUR STARTUP");
  console.log(`  Agent:       Murmur`);
  console.log(`  Model:       Venice AI (openai-gpt-54)`);
  console.log(`  Price Feed:  Binance ETH/USDT WebSocket`);
  console.log(`  Network:     Base Sepolia`);
  console.log(`  Schedule:    ${config.cronSchedule}`);
  console.log(`  Dry run:     ${config.dryRun}`);
  console.log(`  Skip chain:  ${config.skipOnChain}`);
  console.log(`  Skip IPFS:   ${config.skipFilecoin}`);
  separator();

  // Validate Santiment key
  const santimentValid = await validateApiKey(config.santimentApiKey);
  if (!santimentValid) {
    throw new MurmurError("Santiment API key is invalid", "STARTUP_ERROR");
  }

  // Log optional integrations status
  if (!config.veniceApiKey) {
    console.warn(
      "[Startup] ⚠️  VENICE_API_KEY not set — will default to hold on every cycle",
    );
  }
  if (!config.uniswapApiKey) {
    console.warn(
      "[Startup] ⚠️  UNISWAP_API_KEY not set — on-chain quote fallback will be used",
    );
  }
  if (!config.agentPrivateKey) {
    console.warn(
      "[Startup] ⚠️  AGENT_PRIVATE_KEY not set — running in observation mode (no execution)",
    );
  }
  if (!config.filecoinApiKey) {
    console.warn(
      "[Startup] ⚠️  FILECOIN_API_TOKEN not set — receipts will not be stored on Filecoin",
    );
  }
  if (config.dryRun) {
    console.warn(
      "[Startup] 🔶 DRY RUN MODE — no real transactions will be submitted",
    );
  }

  separator();
}

// ─── Signal Handling ──────────────────────────────────────────────────────────

function registerSignalHandlers() {
  const shutdown = (signal: string) => {
    console.log(`\n[Loop] ${signal} received — shutting down gracefully`);
    console.log(`[Loop] Total cycles completed: ${receipts.length}`);
    stopPriceFeed();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    console.error("[Loop] Uncaught exception:", err);
    // Don't exit — let the cron continue
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[Loop] Unhandled rejection:", reason);
  });
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();

  await runStartupChecks(config);

  policy = initPolicy(config);
  treasuryState = await refreshTreasuryState(config);

  registerSignalHandlers();

  // Resolve ENS identity
  const agentWallet = (config.agentAddress ?? DEFAULT_AGENT_WALLET) as `0x${string}`;
  ensResolution = await resolveAgentEns({ address: agentWallet });
  log("idle", `ENS: ${ensResolution.displayName}`);

  // Start real-time price feed
  startPriceFeed();

  // Start WebSocket server for dashboard
  const wsPort = Number(process.env.WS_PORT ?? 3001);
  startWsServer(wsPort);

  // Start x402 API server for paid data access
  startX402Server({
    agentAddress: agentWallet,
    getLatestReceipts: () => receipts,
    getLatestSignalSnapshot: () => ({
      updatedAt: new Date().toISOString(),
      cycleCount,
      treasury: treasuryState ?? null,
      scoredAssets: lastScoredAssets,
      riskGate: lastRiskGate,
    }),
  });

  // Run one cycle immediately on startup
  log("idle", "Running initial cycle on startup...");
  await runCycle(config, "manual");

  // Schedule recurring cycles
  log("idle", `Scheduling cron: "${config.cronSchedule}"`);

  cron.schedule(config.cronSchedule, async () => {
    if (isRunning) {
      log("idle", "Previous cycle still running — skipping this tick");
      return;
    }

    isRunning = true;
    try {
      await runCycle(config, "cron");
    } finally {
      isRunning = false;
    }
  });

  log("idle", "Murmur is running. Press Ctrl+C to stop.");
}

// ─── Run ───────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("[Loop] Fatal startup error:", err);
  process.exit(1);
});
