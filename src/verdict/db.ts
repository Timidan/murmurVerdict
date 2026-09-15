export {
  applyTableRebuildMigration,
  openDb,
  VERDICT_DB_SCHEMA_VERSION,
} from "./db-bootstrap.js";
export type { OpenDbOptions } from "./db-bootstrap.js";
export { isUniqueViolation } from "./sqlite-errors.js";
export { agentsRepo } from "./repos/agents-repo.js";
export type { AgentRow } from "./repos/agents-repo.js";
export { agentSecurityEventsRepo } from "./repos/agent-security-events-repo.js";
export type {
  AgentSecurityEventRow,
} from "./repos/agent-security-events-repo.js";
export {
  feedContractsRepo,
  feedPacketsRepo,
  feedSlaIncidentsRepo,
} from "./repos/feed-availability-repo.js";
export type {
  FeedContractInsert,
  FeedContractRow,
  FeedPacketInsert,
  FeedPacketRow,
  FeedReliabilityRow,
  FeedSlaIncidentInsert,
  FeedSlaIncidentKind,
  FeedSlaIncidentRow,
  FeedSlaIncidentStatus,
} from "./repos/feed-availability-repo.js";
export { entitlementsRepo } from "./repos/entitlements-repo.js";
export type {
  EntitlementRefundStatus,
  EntitlementRow,
  EntitlementStatus,
  ReserveEntitlementInput,
} from "./repos/entitlements-repo.js";
export { fhenixEventsRepo } from "./repos/fhenix-event-index-repo.js";
export type {
  FhenixIndexedEventInput,
} from "./repos/fhenix-event-index-repo.js";
export { fhenixSealedCallsRepo } from "./repos/fhenix-sealed-calls-repo.js";
export type {
  FhenixInvalidRevealInput,
  FhenixRevealInput,
  FhenixRevealStatus,
  FhenixSealedCallInsert,
  FhenixSealedCallRow,
} from "./repos/fhenix-sealed-calls-repo.js";
export { fhenixGatewayTxRepo } from "./repos/fhenix-gateway-tx-repo.js";
export type {
  FhenixGatewayTxAttemptInsert,
  FhenixGatewayTxAttemptRow,
} from "./repos/fhenix-gateway-tx-repo.js";
export { fhenixGatewayFeedPacketTxRepo } from "./repos/fhenix-gateway-feed-packet-tx-repo.js";
export type {
  FhenixGatewayFeedPacketTxAttemptInsert,
  FhenixGatewayFeedPacketTxAttemptRow,
  FhenixGatewayFeedPacketTxStatus,
} from "./repos/fhenix-gateway-feed-packet-tx-repo.js";
export type {
  FhenixGatewayReceiptTelemetry,
  FhenixGatewayTelemetrySummary,
  FhenixGatewayTxStatus,
  FhenixGatewayTxStatusCount,
} from "./repos/fhenix-gateway-attempt-lifecycle.js";
export {
  assetsRepo,
  marketsRepo,
  oraclesRepo,
} from "./repos/market-registry-repo.js";
export type {
  AssetRow,
  MarketConfigSnapshot,
  MarketKind,
  MarketRow,
  OracleRow,
  RegistryStatus,
  ScoringKind,
} from "./repos/market-registry-repo.js";
export { operatorAlertsRepo } from "./repos/operator-alerts-repo.js";
export type {
  OperatorAlertDeliveryStatus,
  OperatorAlertInput,
  OperatorAlertRow,
  OperatorAlertSeverity,
  OperatorAlertStatus,
} from "./repos/operator-alerts-repo.js";
export { refsRepo } from "./repos/ref-attribution-repo.js";
export type {
  RefClickRow,
  RefTopSenderRow,
} from "./repos/ref-attribution-repo.js";
export { resolutionsRepo } from "./repos/resolution-repo.js";
export type {
  FullCallResolutionView,
  ResolutionWriteInput,
} from "./repos/resolution-repo.js";
export { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
export type {
  ResolverSubmissionContext,
  SealedFhenixAcceptanceInput,
} from "./repos/sealed-call-submissions-repo.js";
export { usageRepo } from "./repos/usage-events-repo.js";
export { webhooksRepo } from "./repos/webhooks-repo.js";
export type {
  WebhookInsertRow,
  WebhookRow,
} from "./repos/webhooks-repo.js";
