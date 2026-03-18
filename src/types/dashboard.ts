import type {
  TreasuryState,
  ScoredAsset,
  RiskGateResult,
  LoopPhase,
  TradeAction,
  AssetSlug,
} from "./index.js";

export interface DecisionLogEntry {
  cycleId: string;
  timestamp: string;
  action: TradeAction;
  slug: AssetSlug | null;
  thesis: string;
  confidence: number;
  riskApproved: boolean;
  effectiveSizeUsd: number;
  result: "executed" | "blocked" | "hold" | "dry-run";
  pnlPct: number | null;
}

export interface DashboardSnapshot {
  treasury: TreasuryState;
  scoredAssets: ScoredAsset[];
  lastDecisions: DecisionLogEntry[];
  riskGate: RiskGateResult | null;
  currentCycle: {
    cycleId: string;
    phase: LoopPhase;
    startedAt: string;
  } | null;
  config: {
    network: string;
    cronSchedule: string;
    dryRun: boolean;
    maxNotionalUsd: number;
    maxDailyTurnoverUsd: number;
  };
  cycleCount: number;
  uptimeSince: string;
}

export type WsMessage =
  | { type: "snapshot"; data: DashboardSnapshot }
  | { type: "phase"; data: { cycleId: string; phase: LoopPhase; timestamp: string } }
  | { type: "trade"; data: { action: TradeAction; slug: AssetSlug; amount: number; txHash: string } };
