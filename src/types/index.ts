// ─── Asset Universe ────────────────────────────────────────────────────────────

export const ASSET_UNIVERSE = [
  "ethereum",
  "weth",
  "wrapped-bitcoin",
  "aave",
  "uniswap",
  "chainlink",
  "aerodrome-finance",
  "virtual-protocol",
] as const;

export type AssetSlug = (typeof ASSET_UNIVERSE)[number];

// On Base Sepolia, only WETH has a real token contract + Uniswap pool
export const TESTNET_UNIVERSE = ["ethereum"] as const satisfies readonly AssetSlug[];

export interface AssetConfig {
  slug: AssetSlug;
  ticker: string;
  baseAddress: `0x${string}`;
  decimals: number;
  uniswapPoolFee: number; // 500 | 3000 | 10000
}

// ─── Santiment / Scout ────────────────────────────────────────────────────────

export type SantimentMetric =
  | "social_dominance_total"
  | "sentiment_weighted_total"
  | "exchange_inflow_usd"
  | "exchange_outflow_usd"
  | "age_consumed"
  | "daily_active_addresses"
  | "network_growth"
  | "mvrv_usd"
  | "whale_transaction_count_100k_usd_to_inf";

export interface TimeseriesPoint {
  datetime: string;
  value: number;
}

export interface RawSignal {
  slug: AssetSlug;
  metric: SantimentMetric;
  data: TimeseriesPoint[];
  fetchedAt: string;
}

export interface AssetRawSignals {
  slug: AssetSlug;
  signals: Partial<Record<SantimentMetric, TimeseriesPoint[]>>;
  fetchedAt: string;
}

// ─── Analyst / Normalized ──────────────────────────────────────────────────────

export interface NormalizedMetric {
  raw: number;
  zScore: number;          // rolling z-score vs 30d window
  percentile: number;      // 0–100 vs 30d window
  roc1h: number | null;    // rate of change 1h
  roc24h: number | null;   // rate of change 24h
  roc7d: number | null;    // rate of change 7d
  divergenceVsPrice: number | null; // signal divergence vs price move
}

export interface NormalizedAssetSignals {
  slug: AssetSlug;
  timestamp: string;
  metrics: Partial<Record<SantimentMetric, NormalizedMetric>>;
}

// ─── Strategy / Scoring ───────────────────────────────────────────────────────

export type StrategyPlaybook =
  | "early_narrative_breakout"
  | "euphoria_fade"
  | "capitulation_rebound";

export interface PlaybookScore {
  playbook: StrategyPlaybook;
  score: number;        // -1.0 to 1.0
  confidence: number;   // 0.0 to 1.0
  signals: string[];    // human-readable contributing signals
  warnings: string[];   // conflicting or weak signals
}

export interface ScoredAsset {
  slug: AssetSlug;
  timestamp: string;
  normalizedSignals: NormalizedAssetSignals;
  playbookScores: PlaybookScore[];
  topPlaybook: StrategyPlaybook;
  compositeScore: number;  // -1.0 to 1.0
  isCandidate: boolean;    // passed threshold to go to deliberation
}

// ─── Deliberation (LLM) ──────────────────────────────────────────────────────

export type TradeAction = "buy" | "reduce" | "exit" | "hold";
export type SizeBucket = "1pct" | "3pct" | "5pct";
export type HoldingHorizon = "4h" | "24h" | "72h";

export interface LLMDecision {
  action: TradeAction;
  slug: AssetSlug;
  sizeBucket: SizeBucket;
  confidence: number;        // 0.0 to 1.0
  holdingHorizon: HoldingHorizon;
  thesis: string;            // plain-language reasoning
  invalidationCondition: string;
  risks: string[];
  rawResponse?: string;
}

export interface DeliberationResult {
  decision: LLMDecision;
  candidatesConsidered: AssetSlug[];
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  deliberatedAt: string;
}

// ─── Risk Gate ────────────────────────────────────────────────────────────────

export type RiskCheckStatus = "pass" | "fail" | "warn";

export interface RiskCheck {
  name: string;
  status: RiskCheckStatus;
  reason: string;
}

export interface RiskGateResult {
  approved: boolean;
  checks: RiskCheck[];
  effectiveSizeUsd: number;     // actual USD size after applying bucket %
  maxSlippageBps: number;
  delegationCapRemaining: number;
  evaluatedAt: string;
}

// ─── Quote & Execution ────────────────────────────────────────────────────────

export interface UniswapQuote {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  amountOut: bigint;
  priceImpactPct: number;
  route: string;
  quotedAt: string;
}

export interface ExecutionResult {
  txHash: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  amountOut: bigint;
  priceImpactPct: number;
  gasUsed: bigint;
  blockNumber: bigint;
  executedAt: string;
}

// ─── Decision Receipt (Notary / Attestation) ─────────────────────────────────

export interface DecisionReceipt {
  id: string;                         // UUID
  agentIdentity: `0x${string}`;       // ERC-8004 registered address
  cycleId: string;                    // unique loop cycle identifier

  // What it saw
  scoredAssets: ScoredAsset[];

  // Why it acted
  deliberation: DeliberationResult;

  // Risk evaluation
  riskGate: RiskGateResult;

  // What it executed (null if hold)
  execution: ExecutionResult | null;

  // Attestation
  receiptHash: `0x${string}`;         // keccak256 of canonical receipt JSON
  attestationTxHash?: `0x${string}`;  // on-chain ERC-8004 attestation tx
  filecoinCid?: string;               // full receipt stored on Filecoin

  // Delegation metadata
  delegationUsed?: `0x${string}`;
  delegationCapBefore: number;
  delegationCapAfter: number;

  createdAt: string;
  version: "1.0";
}

// ─── Portfolio / Treasury State ───────────────────────────────────────────────

export interface Position {
  slug: AssetSlug;
  tokenAddress: `0x${string}`;
  amountHeld: bigint;
  usdValueAtEntry: number;
  entryTxHash: `0x${string}`;
  entryAt: string;
  thesis: string;
  invalidationCondition: string;
}

export interface TreasuryState {
  usdcBalance: bigint;
  totalPortfolioUsd: number;
  positions: Position[];
  lastUpdatedAt: string;
}

// ─── Loop / Orchestration ─────────────────────────────────────────────────────

export type LoopPhase =
  | "sense"
  | "normalize"
  | "score"
  | "deliberate"
  | "risk_gate"
  | "quote"
  | "execute"
  | "attest"
  | "idle";

export interface LoopCycle {
  cycleId: string;
  startedAt: string;
  completedAt?: string;
  phase: LoopPhase;
  triggeredBy: "cron" | "event" | "manual";
  receipt?: DecisionReceipt;
  error?: string;
}

// ─── Price Feed ──────────────────────────────────────────────────────────────

export interface PriceBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
  closeTime: number;
}

export interface PriceFeedState {
  currentPrice: number;
  bars1m: PriceBar[];
  bars5m: PriceBar[];
  momentum1m: number;
  momentum5m: number;
  high5m: number;
  low5m: number;
  updatedAt: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MurmurConfig {
  // Santiment
  santimentApiKey: string;

  // Venice / LLM
  veniceApiKey: string;
  veniceBaseUrl: string;

  // Uniswap
  uniswapApiKey: string;

  // Chain
  baseRpcUrl: string;
  agentPrivateKey: `0x${string}`;
  agentAddress: `0x${string}`;

  // MetaMask Delegation
  delegationContractAddress: `0x${string}`;
  delegationMaxNotionalUsd: number;
  delegationDailyTurnoverUsd: number;

  // Filecoin
  filecoinApiToken: string;

  // Loop
  cronSchedule: string;         // e.g. "*/15 * * * *"
  signalWindowDays: number;     // lookback window for normalization
  candidateTopN: number;        // top N assets sent to deliberation
  minCompositeScore: number;    // minimum score to be a candidate
  maxPositions: number;         // max concurrent open positions
  maxSlippageBps: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class MurmurError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "MurmurError";
  }
}

export class ScoutError extends MurmurError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "SCOUT_ERROR", context);
    this.name = "ScoutError";
  }
}

export class RiskGateError extends MurmurError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "RISK_GATE_ERROR", context);
    this.name = "RiskGateError";
  }
}

export class ExecutionError extends MurmurError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "EXECUTION_ERROR", context);
    this.name = "ExecutionError";
  }
}

export type {
  DecisionLogEntry,
  DashboardSnapshot,
  WsMessage,
} from "./dashboard.js";
