// Re-export all types needed by dashboard components.
// These mirror the types in src/types/index.ts and src/types/dashboard.ts
// but are re-exported here for convenient imports within the dashboard.

export type {
  DashboardSnapshot,
  DecisionLogEntry,
  WsMessage,
} from "../../src/types/dashboard.js";

export type {
  LoopPhase,
  TradeAction,
  AssetSlug,
  SantimentMetric,
  ScoredAsset,
  NormalizedAssetSignals,
  NormalizedMetric,
  RiskGateResult,
  RiskCheck,
  RiskCheckStatus,
  TreasuryState,
  Position,
} from "../../src/types/index.js";
