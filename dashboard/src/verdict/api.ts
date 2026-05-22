// Thin typed client for the Murmur Verdict v1 API.
// Read endpoints are public. Dashboard writes use Privy bearer auth or
// account-scoped API keys depending on the route.

// When VITE_VERDICT_API_URL is unset the client defaults to RELATIVE
// URLs. In `npm run dashboard` (vite dev proxy) those resolve to the
// daemon via the vite.config.ts proxy block. In production hosts that
// serve dashboard/dist statically — Cloudflare Pages, Vercel, your
// own Nginx — relative URLs hit the static-host's own origin and the
// SPA silently fails every API call. ALWAYS set this explicitly for
// any non-local build. Pointing at the deployed daemon's URL is the
// split-deploy contract.
const API_URL = (import.meta.env.VITE_VERDICT_API_URL?.trim() || "") as string;

// Current agent taxonomy after removing scraping and public identity
// onboarding. Keep this in sync with the backend schema in
// src/verdict/schema.ts:AgentKindSchema.
export type AgentKind =
  | "benchmark"
  // Canonical Privy-owned default — was "casual" pre-Wave-3.
  | "agent"
  | "internal_test"
  // V2 §7.1 attested tier — Olas Service Registry bond + Safe multisig.
  | "attested";

export interface LeaderboardRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
  tier: "main" | "provisional";
  rank: number | null;
  verdict_score: number | null;
  verdict_score_lb?: number | null;
  resolved_calls: number;
  win_rate: number | null;
  pending_calls: number;
  last_resolved_at: string | null;
}

export interface MetaResponse {
  schema_version: number;
  scoring_version: number;
  strategy_tags: string[];
  assets: string[];
  verified_volume_24h: { count: number; since_iso: string };
  privacy?: {
    mode: "sealed_fhenix";
    threshold_network: string;
    pending_verdicts_private: boolean;
    public_reveal_after_horizon: boolean;
  };
  /** Present when the daemon has a Fhenix chain configured. The Controller
   *  Wallet binding MUST use this chain_id; the backend enforces equality
   *  with the Fhenix event chain. */
  fhenix?: {
    chain_id: string;
    chain_id_numeric: number;
    contract_address: string | null;
  };
}

export interface AgentProfile {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: LeaderboardRow["kind"];
  bio?: string;
  created_at: string;
  /** Lowercase 0x+40hex; top-level since P1.5 phase-1. */
  wallet_address?: string;
  /** CAIP-2, e.g. eip155:8453. */
  chain_id?: string;
}

export interface AgentCallRow {
  call_id: string;
  status: string;
  privacy_mode?: string;
  commit_hash?: string | null;
  acceptance_receipt_hash?: string | null;
  asset_id?: string;
  side?: "BUY" | "SELL";
  horizon_hours?: number;
  confidence?: number;
  submitted_at?: string;
  accepted_at: string;
  outcome: string | null;
  call_score: number | null;
  signed_return: string | null;
  resolved_at: string | null;
}

export interface FullCall {
  submission: {
    call_id: string;
    agent_id: string;
    client_order_id: string;
    privacy_mode?: string;
    commit_hash?: string | null;
    asset_id?: string;
    side?: "BUY" | "SELL";
    horizon_hours?: number;
    confidence?: number;
    submitted_at?: string;
    accepted_at: string;
    status: string;
    rationale?: string | null;
    strategy_tag?: string | null;
  };
  // Wave 4b — receipts subsystem dropped (acceptance_receipt no longer
  // returned by the daemon). Wave 4b-2 — preflight metadata
  // (murmur_score / murmur_playbook / risk_flags / market_regime /
  // data_freshness_seconds) was Santiment-derived and is no longer
  // emitted by the daemon either.
  t0: { t0: string; p0: string; feed: string } | null;
  resolution: {
    t1: string;
    p1: string;
    t1_feed: string;
    signed_return: string;
    outcome: string;
    call_score: number | null;
    resolved_at: string;
  } | null;
  // Sealed-Fhenix lifecycle projection. The daemon emits this sub-object
  // only when the call's privacy_mode is "sealed_fhenix" (see
  // src/verdict/api.ts:2254-2278). Pre-reveal it carries only opaque
  // ciphertext handles + lifecycle timestamps. Post-publish it gains a
  // `revealed_verdict` sub-object with plaintext binary_index /
  // confidence_bps. Field names + nullability mirror the daemon
  // projection verbatim — operator-blind invariant means revealed_verdict
  // is absent (not null) pre-reveal.
  fhenix?: {
    chain_id: number;
    contract_address: string;
    onchain_call_id: string;
    binary_index_ct_hash: string;
    confidence_ct_hash: string;
    reveal_open_at: string;
    reveal_status: "pending" | "revealed" | "invalid" | "missed";
    invalid_reason: string | null;
    terminal_at: string | null;
    revealed_at: string | null;
    revealed_verdict?: {
      binary_index: number;
      confidence_bps: number;
      confidence: number;
    };
  };
}

// Wave 4b-2 — MarketPreflightSnapshot dropped alongside the Santiment
// integration. The /v1/market/preflight endpoint no longer exists.

export interface TodayFeedRow {
  call_id: string;
  agent_id: string;
  agent_slug: string;
  agent_kind: string;
  privacy_mode: string;
  commit_hash?: string | null;
  acceptance_receipt_hash?: string | null;
  side?: "BUY" | "SELL";
  asset_id?: string;
  horizon_hours?: number;
  confidence?: number;
  submitted_at?: string;
  accepted_at: string;
  status: string;
  outcome?: string | null;
  signed_return?: string | null;
  call_score?: number | null;
  resolved_at?: string | null;
  t1_estimate?: string | null;
}

export interface TodayMover {
  agent_id: string;
  agent_slug: string;
  display_name: string;
  rank: number | null;
  verdict_score: number | null;
  delta_24h_calls: number;
  delta_24h_wins: number;
}

export interface TodayFeed {
  schema_version: 1;
  served_at: string;
  accepted_recent: TodayFeedRow[];
  pending_resolution: TodayFeedRow[];
  resolved_recent: TodayFeedRow[];
  movers: TodayMover[];
  totals: {
    accepted_24h: number;
    resolved_24h: number;
    wins_24h: number;
    losses_24h: number;
    void_24h: number;
  };
}

/* ── Phase 3b — markets registry + per-(agent, market) grid ─────────────── */

export type MarketStatus = "draft" | "listed" | "frozen" | "retired";
export type MarketResolutionClass =
  | "event_binary"
  | "event_basket"
  | "price_threshold"
  | "price_direction"
  | "range_prediction"
  | "sports_match"
  | "ranking_outcome"
  | "yield_or_savings"
  | "risk_avoidance";
export type MarketSupportStatus = "live" | "reserved";
export type MarketPayoffModel =
  | "binary"
  | "categorical"
  | "scalar"
  | "range"
  | "ranking";
export type MarketSettlementModel =
  | "price_oracle"
  | "venue_adapter"
  | "agent_feed"
  | "hybrid";

export interface MarketTaxonomyClass {
  resolution_class: MarketResolutionClass;
  label: string;
  support_status: MarketSupportStatus;
  payoff_model: MarketPayoffModel;
  settlement_model: MarketSettlementModel;
  default_scoring_kind: string;
  compatible_market_kinds: string[];
  compatible_market_families: string[];
  compatible_adapters: string[];
}

export interface MarketTaxonomyAssignment extends MarketTaxonomyClass {
  classification_source: "config" | "market_kind" | "fallback";
}

export interface MarketTaxonomyResponse {
  version: number;
  classes: MarketTaxonomyClass[];
  live_resolution_classes: MarketResolutionClass[];
  reserved_resolution_classes: MarketResolutionClass[];
}

export interface MarketRow {
  market_id: string; // e.g., "eth.1h"
  asset_id: string; // e.g., "base:ETH:USD"
  market_kind: string; // "direction_binary"
  horizon_seconds: number;
  primary_oracle_id: string;
  fallback_oracle_id: string | null;
  void_band: string; // decimal as string
  status: MarketStatus;
  market_config_version: number;
  market_taxonomy?: MarketTaxonomyAssignment;
  // Backend may include additional fields; preserve them through.
  [extra: string]: unknown;
}

// Phase 10 — per-family + cross-family LB row shapes. Keep aligned with
// src/verdict/leaderboard.ts AgentFamilyRow / AgentCrossFamilyRow.
export interface AgentFamilyRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: LeaderboardRow["kind"];
  market_family: string;
  verdict_score: number | null;
  verdict_score_lb: number | null;
  resolved_calls: number;
  pending_calls: number;
  win_rate: number | null;
  last_resolved_at: string | null;
  family_main_tier: boolean;
  distinct_markets: number;
}

export interface AgentCrossFamilyRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: LeaderboardRow["kind"];
  cross_family_score: number | null;
  families: Array<{
    market_family: string;
    verdict_score: number | null;
    resolved_calls: number;
    qualifies: boolean;
  }>;
  qualifying_families: number;
  cross_family_main_tier: boolean;
}

export interface AgentMarketRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
  market_id: string;
  verdict_score: number | null;
  verdict_score_lb: number | null;
  resolved_calls: number;
  pending_calls: number;
  win_rate: number | null;
  last_resolved_at: string | null;
  /** resolved_calls >= 20 */
  market_main_tier: boolean;
  /** Chronological per-call score series for this market. Nulls = void /
   * oracle_unavailable resolutions; render as gaps in the sparkline.
   * Optional in the type because older daemon versions don't project this
   * field — the consumer must `?.filter() ?? []` defensively. */
  call_scores?: (number | null)[];
}

export interface AgentGridSummary {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
}

/* ── Phase 7a — casual-tier account session + agent list ────────────────── */

/** Response shape for POST /v1/account/session (see src/verdict/routes/account.ts). */
export interface AccountSession {
  account_id: string;
  created: boolean;
  privy_user_id: string;
}

/**
 * One row from GET /v1/account/agents. Fields are nullable because the
 * agents bridge may exist before the agent row is fully hydrated, but
 * after Phase 4 the only nullable case in practice is `display_name`.
 */
export interface AccountAgent {
  agent_id: string;
  linked_at: string;
  display_slug: string | null;
  display_name: string | null;
  /**
   * Wave 3 — this is "agent" for accounts created via this flow (the
   * canonical Privy-owned default). Older legacy bridges may surface
   * other AgentKind values, or stale literals ("casual") from pre-Wave-3
   * rows; UI should treat null defensively and let TierBadge's `unknown`
   * fallback render anything outside the current 4-value enum.
  */
  kind: string | null;
  wallet_address: string | null;
  chain_id: string | null;
  controller_wallet: {
    wallet_address: string;
    chain_id: string;
    wallet_kind: "embedded" | "external";
    provider: string | null;
    created_at: string;
    last_attested_at: string;
    reattestation_due_at: string;
    reattestation_overdue: boolean;
    reattestation_interval_seconds: number;
  } | null;
  /**
   * Phase 7c — payout destination + last-change timestamp surfaced on
   * the account-scoped list so the settings UI can derive the §7.4 24h
   * cooldown without an extra round-trip. Null on agents that have never
   * had a destination_address set.
   */
  destination_address: string | null;
  destination_address_updated_at: string | null;
}

/* ── Phase 7b — agent creation + api-key mint request/response shapes ───── */

/**
 * Request body for POST /v1/account/agents. Validation mirrors the
 * server-side zod schema in src/verdict/routes/account.ts:CreateAgentSchema —
 *   · `display_slug` matches AgentSlugSchema (3–32 chars, lowercase alphanum
 *     segments joined by single dashes)
 *   · `display_name` 1–120 chars (UI clamps to 64 per design guidance)
 *   · `bio` optional, ≤500 chars on the server (UI clamps to 280)
 */
export interface CreateAgentRequest {
  display_slug: string;
  display_name: string;
  bio?: string;
}

/**
 * Response body for POST /v1/account/agents. The handler responds 201 with
 * the freshly-inserted row; the client uses `display_slug` to navigate
 * to the agent's integration page.
 */
export interface CreateAgentResponse {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: "agent";
  created_at: string;
}

export interface BindWalletResponse {
  agent_id: string;
  display_slug: string;
  wallet_address: string;
  chain_id: string;
  wallet_kind: "embedded" | "external";
  provider: string | null;
  created_at: string;
  last_attested_at: string;
  reattestation_due_at: string;
  reattestation_overdue: boolean;
  reattestation_interval_seconds: number;
  idempotent_hit: boolean;
}

export interface ControllerWalletChallengeResponse {
  agent_id: string;
  display_slug: string;
  wallet_address: string;
  chain_id: string;
  wallet_kind: "embedded" | "external";
  provider: string | null;
  authorization_issued_at: string;
  message: string;
}

export interface ControllerWalletReattestationChallengeResponse {
  agent_id: string;
  display_slug: string;
  controller_wallet_address: string;
  controller_chain_id: string;
  attestation_nonce: string;
  authorization_issued_at: string;
  previous_last_attested_at: string;
  previous_reattestation_due_at: string;
  reattestation_interval_seconds: number;
  message: string;
}

export interface ControllerWalletReattestationResponse {
  agent_id: string;
  display_slug: string;
  attestation_id: string;
  controller_wallet: NonNullable<AccountAgent["controller_wallet"]>;
}

export interface RuntimeKeyPolicy {
  allowed_market_ids?: string[];
  max_calls_per_hour?: number;
  max_calls_per_day?: number;
  feed_packets?: boolean;
  notes?: string;
}

export interface RuntimeKeyRow {
  runtime_key_id: string;
  runtime_key_prefix: string;
  label: string | null;
  policy: RuntimeKeyPolicy;
  policy_hash: string;
  controller_wallet_address: string;
  controller_chain_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface RuntimeKeyChallengeResponse {
  agent_id: string;
  display_slug: string;
  controller_wallet_address: string;
  controller_chain_id: string;
  policy_hash: string;
  authorization_nonce: string;
  authorization_issued_at: string;
  expires_at: string | null;
  message: string;
}

export interface RuntimeKeyMintResponse {
  runtime_key_id: string;
  secret: string;
  runtime_key_prefix: string;
  label: string | null;
  policy_hash: string;
  created_at: string;
  expires_at: string | null;
  warning?: string;
}

export type GatewayAttemptStatus =
  | "queued"
  | "submitted"
  | "confirmed"
  | "accepted"
  | "failed_retryable"
  | "failed_terminal";

export interface GatewayOperatorAttempt {
  attempt_id: string;
  status: GatewayAttemptStatus;
  account_id: string;
  agent_id: string;
  runtime_key_id: string | null;
  runtime_key_policy_hash: string;
  chain_id: number;
  contract_address: string;
  relayer_address: string;
  agent_wallet_address: string;
  market_id: string;
  market_id_hash: string;
  market_ref_protocol: string;
  market_config_version: number;
  client_order_id: string;
  client_nonce: string;
  tx_hash: string | null;
  submit_log_index: number | null;
  submit_block_number: number | null;
  onchain_call_id: string | null;
  call_id: string | null;
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  broadcast_started_at: string | null;
  broadcast_latency_ms: number | null;
  receipt_observed_at: string | null;
  receipt_latency_ms: number | null;
  latest_block_latency_ms: number | null;
  receipt_status: "success" | "reverted" | null;
  receipt_block_number: number | null;
  latest_block_number: number | null;
  confirmations_observed: number | null;
  gas_used: string | null;
  effective_gas_price_wei: string | null;
  last_rpc_error: string | null;
  submitted_at: string;
  accepted_at: string | null;
  reveal_open_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayOperatorFeedAttempt {
  attempt_id: string;
  status: GatewayAttemptStatus;
  account_id: string;
  agent_id: string;
  runtime_key_id: string | null;
  runtime_key_policy_hash: string;
  chain_id: number;
  contract_address: string;
  relayer_address: string;
  agent_wallet_address: string;
  feed_id: string;
  feed_id_hash: string;
  market_id: string | null;
  market_id_hash: string;
  packet_kind: string;
  sequence: number;
  payload_schema: string;
  client_order_id: string;
  client_nonce: string;
  tx_hash: string | null;
  submit_log_index: number | null;
  submit_block_number: number | null;
  onchain_packet_id: string | null;
  packet_id: string | null;
  action_ct_hash: string | null;
  signal_ct_hash: string | null;
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  broadcast_started_at: string | null;
  broadcast_latency_ms: number | null;
  receipt_observed_at: string | null;
  receipt_latency_ms: number | null;
  latest_block_latency_ms: number | null;
  receipt_status: "success" | "reverted" | null;
  receipt_block_number: number | null;
  latest_block_number: number | null;
  confirmations_observed: number | null;
  gas_used: string | null;
  effective_gas_price_wei: string | null;
  last_rpc_error: string | null;
  submitted_at: string;
  delivery_deadline_at: string | null;
  accepted_at: string | null;
  reveal_after: string;
  created_at: string;
  updated_at: string;
}

export interface GatewayTelemetrySummary {
  avg_broadcast_latency_ms: number | null;
  avg_receipt_latency_ms: number | null;
  avg_latest_block_latency_ms: number | null;
  max_confirmations_observed: number | null;
  rpc_errors: number;
  last_receipt_observed_at: string | null;
}

export interface GatewayOperatorSnapshot {
  schema_version: number;
  served_at: string;
  configured: boolean;
  config: {
    chain_id: number;
    contract_address: string;
    relayer_address: string;
    confirmations: number;
    retry_base_ms: number;
    retry_max_ms: number;
    max_attempts: number;
    stuck_after_ms: number;
  } | null;
  queues: {
    due_for_broadcast: number;
    submitted_awaiting_confirmation: number;
    confirmed_awaiting_acceptance: number;
    stuck: number;
    stale_before: string;
  };
  status_counts: Record<GatewayAttemptStatus, number>;
  telemetry: GatewayTelemetrySummary;
  recent_attempts: GatewayOperatorAttempt[];
  stuck_attempts: GatewayOperatorAttempt[];
  feed_queues: {
    due_for_broadcast: number;
    submitted_awaiting_confirmation: number;
    confirmed_awaiting_acceptance: number;
    stuck: number;
    stale_before: string;
  };
  feed_status_counts: Record<GatewayAttemptStatus, number>;
  feed_telemetry: GatewayTelemetrySummary;
  feed_recent_attempts: GatewayOperatorFeedAttempt[];
  feed_stuck_attempts: GatewayOperatorFeedAttempt[];
}

export interface GatewayTickResponse {
  schema_version: number;
  served_at: string;
  result: {
    broadcasted: number;
    confirmed: number;
    accepted: number;
    failed: number;
  };
  gateway: GatewayOperatorSnapshot;
}

export interface GatewayRetryResponse {
  schema_version: number;
  served_at: string;
  attempt_id: string;
  status: GatewayAttemptStatus;
  tx_hash: string | null;
  call_id: string | null;
  next_attempt_at: string;
  idempotent_hit: boolean;
}

export type LiveCanaryStatus = "ok" | "fail" | "disabled";
export type LiveCanaryName = "fhenix_rpc" | "polymarket_gamma";

export interface LiveCanaryCheck {
  name: LiveCanaryName;
  status: LiveCanaryStatus;
  checked_at: string;
  latency_ms: number | null;
  details: Record<string, string | number | boolean | null>;
  error: string | null;
}

export interface LiveCanarySnapshot {
  schema_version: number;
  served_at: string;
  ok: boolean;
  checks: LiveCanaryCheck[];
}

export type FhenixRevealStatus = "pending" | "revealed" | "invalid" | "missed";

export interface FhenixLifecycleRow {
  call_id: string;
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  reveal_status: FhenixRevealStatus;
  reveal_open_at: string;
  revealed_at: string | null;
  terminal_at: string | null;
  invalid_reason: string | null;
  reveal_tx_hash: string | null;
  reveal_block_number: number | null;
  agent_id: string;
  agent_slug: string | null;
  market_id: string | null;
  submission_status: string;
  overdue_grace: boolean;
  resolution: {
    outcome: string;
    call_score: number | null;
    resolved_at: string | null;
  } | null;
}

export interface FhenixLifecycleSnapshot {
  schema_version: number;
  served_at: string;
  configured: {
    verifier: boolean;
    watcher: boolean;
    reveal_grace_seconds: number;
  };
  counts: Record<FhenixRevealStatus, number>;
  queues: {
    pending_not_open: number;
    open_pending: number;
    overdue_grace: number;
    terminal_failures: number;
    needs_attention: number;
    grace_cutoff: string;
  };
  cursors: Array<{
    chain_id: number;
    contract_address: string;
    event_name: string;
    last_block_number: number;
    updated_at: string;
  }>;
  event_counts: Record<string, number>;
  needs_attention: FhenixLifecycleRow[];
  recent: FhenixLifecycleRow[];
}

export type ControllerIdentityStatus = "current" | "due_soon" | "overdue" | "missing_due_at";

export interface ControllerIdentityRow {
  agent_id: string;
  account_id: string;
  agent_slug: string | null;
  wallet_address: string;
  chain_id: string;
  wallet_kind: string;
  provider: string | null;
  created_at: string;
  last_attested_at: string | null;
  reattestation_due_at: string | null;
  total_runtime_keys: number;
  active_runtime_keys: number;
  revoked_runtime_keys: number;
  last_runtime_key_created_at: string | null;
  status: ControllerIdentityStatus;
  reattestation_overdue: boolean;
  reattestation_due_soon: boolean;
}

export interface ControllerIdentitySnapshot {
  schema_version: number;
  served_at: string;
  due_soon_at: string;
  counts: {
    controller_wallets: number;
    overdue: number;
    due_soon: number;
    active_runtime_keys: number;
    needs_attention: number;
  };
  needs_attention: ControllerIdentityRow[];
  rows: ControllerIdentityRow[];
}

export type OperatorAlertSeverity = "info" | "warning" | "critical";
export type OperatorAlertStatus = "open" | "resolved";
export type OperatorAlertDeliveryStatus = "pending" | "delivered" | "failed";

export interface OperatorAlert {
  alert_id: string;
  alert_key: string;
  source: string;
  kind: string;
  severity: OperatorAlertSeverity;
  status: OperatorAlertStatus;
  title: string;
  description: string;
  payload: unknown;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  resolved_at: string | null;
  delivery_status: OperatorAlertDeliveryStatus;
  delivery_attempts: number;
  next_delivery_at: string | null;
  last_delivery_at: string | null;
  last_delivery_status: number | null;
  last_delivery_error: string | null;
}

export interface OperatorAlertsSnapshot {
  schema_version: number;
  served_at: string;
  sink_configured: boolean;
  counts: Record<OperatorAlertStatus, {
    total: number;
    critical: number;
    warning: number;
    info: number;
  }>;
  alerts: OperatorAlert[];
}

export interface OperatorAlertTickResponse {
  schema_version: number;
  scan: {
    served_at: string;
    opened_or_seen: number;
    sources: Array<{
      source: string;
      active_alerts: number;
      resolved_alerts: number;
    }>;
  };
  delivery: {
    served_at: string;
    sink_configured: boolean;
    attempted: number;
    delivered: number;
    failed: number;
  };
  snapshot: OperatorAlertsSnapshot;
}

export type FeedSlaIncidentStatus = "open" | "fulfilled_late";

export interface FeedSlaIncident {
  incident_id: string;
  feed_id: string;
  agent_id: string;
  incident_kind: "missed_packet";
  status: FeedSlaIncidentStatus;
  expected_sequence: number;
  expected_delivery_deadline_at: string;
  detected_at: string;
  grace_seconds: number;
  refund_action: "none" | "credit" | "prorated";
  slash_action: "none" | "reputation" | "stake";
  fulfilled_packet_id: string | null;
  fulfilled_at: string | null;
  details: unknown;
  created_at: string;
  updated_at: string;
}

export interface FeedAvailabilitySummary {
  proof_version: 1;
  feed_id: string;
  health_status: "healthy" | "degraded" | "failing";
  reliability_score: number | null;
  scheduled_packets: number;
  on_time_packets: number;
  late_packets: number;
  missed_packets: number;
  open_missed_packets: number;
  fulfilled_missed_packets: number;
  next_expected_sequence: number | null;
  next_deadline_at: string | null;
  overdue: boolean;
  overdue_grace_seconds: number;
  refund_recommendations: Record<string, number>;
  slash_recommendations: Record<string, number>;
  payment_execution_enabled: false;
  proof_hash: string;
}

export interface FeedAvailabilityProof extends FeedAvailabilitySummary {
  generated_at: string;
  agent_id: string;
  feed: {
    status: string;
    venue: string;
    delivery_cadence_seconds: number | null;
    max_latency_seconds: number | null;
    refund_rule: Record<string, unknown>;
    slash_rule: Record<string, unknown>;
  };
  window: { from: string; to: string };
  evidence: {
    delivered_packets: unknown[];
    missed_packets: unknown[];
  };
}

export interface FeedSlaAdminResponse {
  schema_version: number;
  served_at: string;
  summary: {
    open_incidents: number;
    refund_recommendations: number;
    slash_recommendations: number;
    failing_feeds: number;
    degraded_feeds: number;
    payment_execution_enabled: false;
  };
  feed_health: FeedAvailabilitySummary[];
  incidents: FeedSlaIncident[];
}

export interface FeedSlaTickResponse {
  schema_version: number;
  result: {
    served_at: string;
    inspected_feeds: number;
    incidents_opened: number;
    max_incidents: number;
  };
  open_incidents: FeedSlaIncident[];
}

/**
 * Response body for POST /v1/account/agents/:slug/api-keys.
 *
 * SECURITY: `secret` is the ONE place this plaintext is ever returned by
 * the API. Subsequent reads return only the metadata (api_key_id,
 * created_at, label). UI MUST display this once and warn the user the
 * value is not recoverable.
 */
export interface MintApiKeyResponse {
  api_key_id: string;
  secret: string;
  created_at: string;
  warning?: string;
}

/* ── Phase 7c — api-key list + destination-address + cooldown shapes ────── */

/**
 * One row from GET /v1/account/agents/:slug/api-keys. Metadata only — the
 * plaintext secret is NEVER returned here (one-time mint reveal is the
 * sole source per V2 §7.5). `rotated_at` is null on active keys and an
 * ISO timestamp on soft-deleted ones.
 */
export interface ApiKeyRow {
  api_key_id: string;
  created_at: string;
  label?: string | null;
  rotated_at?: string | null;
}

/**
 * Response body for DELETE /v1/account/api-keys/:key_id. `rotated` is
 * boolean — false only when the key was already rotated (idempotent).
 */
export interface RotateApiKeyResponse {
  rotated: boolean;
}

/**
 * Response body for PATCH /v1/account/agents/:slug/destination-address.
 * Includes `destination_address_updated_at` so the client can start the
 * 24h cooldown countdown immediately on success.
 */
export interface PatchDestinationResponse {
  agent_id: string;
  destination_address: string;
  destination_address_updated_at: string;
}

/**
 * 429 body for PATCH /v1/account/agents/:slug/destination-address when
 * the §7.4 cooldown is still active. The handler surfaces
 * `retry_after_seconds` so the UI countdown is exact, not estimated.
 */
export interface DestinationCooldownError {
  error: string;
  code: string;
  retry_after_seconds: number;
}

/* ── Phase 7d — onboarding funnel event allowlist ───────────────────────── */

/**
 * Allowlisted funnel-event kinds. Mirrors the server-side
 * FunnelEventKindSchema in src/verdict/routes/account.ts. Anything outside
 * this union → server 400. Keep both lists synced.
 *
 * The `call.*` variants are server-reserved (no client emit site in 7d);
 * they're listed here so a future resolver-side hook can use the same
 * client signature without a type widening.
 */
export type FunnelEventKind =
  | "landing.viewed"
  | "compete.clicked"
  | "privy.modal_opened"
  | "privy.signed_in"
  | "agent.created"
  | "api_key.minted"
  | "destination.set"
  | "call.first_submitted"
  | "call.first_resolved"
  | "call.tenth_submitted";

// Phase 7a — `get`/`post` accept optional extra headers so account-area
// callers can attach `Authorization: Bearer <privy_jwt>` without breaking
// the existing call-sites (they continue to omit the second arg).
type HeaderMap = Record<string, string>;

async function get<T>(path: string, headers?: HeaderMap): Promise<T> {
  const init: RequestInit = headers ? { headers } : {};
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) throw new ApiError(`GET ${path} → ${res.status}`, res.status);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown, headers?: HeaderMap): Promise<T> {
  const merged: HeaderMap = { "content-type": "application/json", ...(headers ?? {}) };
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: merged,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`POST ${path} → ${res.status}: ${text}`, res.status, text);
  }
  return (await res.json()) as T;
}

// Phase 7c — PATCH + DELETE helpers, mirroring `post`/`get` so the
// account-settings page can issue payout updates + key rotations through
// the same headers-aware client surface.
async function patch<T>(path: string, body: unknown, headers?: HeaderMap): Promise<T> {
  const merged: HeaderMap = { "content-type": "application/json", ...(headers ?? {}) };
  const res = await fetch(`${API_URL}${path}`, {
    method: "PATCH",
    headers: merged,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`PATCH ${path} → ${res.status}: ${text}`, res.status, text);
  }
  return (await res.json()) as T;
}

/**
 * Phase 7d — POST helper for endpoints that return 204 No Content. The
 * generic `post<T>` always calls `.json()`, which throws on an empty
 * body. The funnel-emit route is the only 204-returning caller today.
 */
async function postNoContent(
  path: string,
  body: unknown,
  headers?: HeaderMap,
): Promise<void> {
  const merged: HeaderMap = { "content-type": "application/json", ...(headers ?? {}) };
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: merged,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`POST ${path} → ${res.status}: ${text}`, res.status, text);
  }
}

async function del<T>(path: string, headers?: HeaderMap, body?: unknown): Promise<T> {
  const merged: HeaderMap | undefined = body === undefined
    ? headers
    : { "content-type": "application/json", ...(headers ?? {}) };
  const init: RequestInit = {
    method: "DELETE",
    ...(merged ? { headers: merged } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`DELETE ${path} → ${res.status}: ${text}`, res.status, text);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  /**
   * Raw response body. Carried alongside the formatted message so callers
   * can JSON.parse it for structured fields (e.g. `retry_after_seconds`
   * on a 429 from PATCH /destination-address) without re-fetching.
   */
  readonly rawBody: string;
  constructor(message: string, public readonly status: number, rawBody = "") {
    super(message);
    this.name = "ApiError";
    this.rawBody = rawBody;
  }
}

export const verdictApi = {
  apiUrl: API_URL,
  meta: () => get<MetaResponse>("/v1/meta"),
  health: () => get<{ ok: boolean; schema_version: number; scoring_version: number; now: string }>("/v1/health"),
  leaderboard: (opts: { tier?: "main" | "provisional"; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.tier) params.set("tier", opts.tier);
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<{ schema_version: number; scoring_version: number; served_at: string; rows: LeaderboardRow[] }>(
      `/v1/leaderboard${q ? `?${q}` : ""}`,
    );
  },
  agentsByKind: (kind: AgentKind, limit = 50) =>
    get<{
      schema_version: number;
      served_at: string;
      kind: string;
      count: number;
      rows: AgentProfile[];
    }>(`/v1/agents?kind=${kind}&limit=${limit}`),
  agent: (slug: string) => get<AgentProfile>(`/v1/agents/${encodeURIComponent(slug)}`),
  agentCalls: (slug: string, limit = 50) =>
    get<{ agent_id: string; display_slug: string; kind: string; calls: AgentCallRow[] }>(
      `/v1/agents/${encodeURIComponent(slug)}/calls?limit=${limit}`,
    ),
  call: (call_id: string) => get<FullCall>(`/v1/calls/${encodeURIComponent(call_id)}`),
  // Wave 1 — claimInit / claimFinalize verdictApi methods removed
  // alongside the deleted /v1/agents/:slug/claim/* routes.
  todayFeed: () => get<TodayFeed>(`/v1/feed/today`),
  feedAvailability: (feed_id: string) =>
    get<{
      schema_version: number;
      served_at: string;
      proof: FeedAvailabilityProof;
    }>(`/v1/feeds/${encodeURIComponent(feed_id)}/availability`),
  discoverers: (slug: string, limit = 5) =>
    get<{
      schema_version: number;
      slug: string;
      discoverers: Array<{
        ref: string;
        agent_slug: string | null;
        total: number;
        first_at: string;
        last_at: string;
      }>;
    }>(`/v1/agents/${encodeURIComponent(slug)}/discoverers?limit=${limit}`),
  topRefs: (limit = 20) =>
    get<{
      schema_version: number;
      served_at: string;
      senders: Array<{
        ref: string;
        total: number;
        agents_touched: number;
        converted: number;
        last_at: string;
      }>;
    }>(`/v1/refs/top?limit=${limit}`),
  adminGateway: (
    token: string,
    opts: { status?: GatewayAttemptStatus; limit?: number; stuck_after_sec?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.stuck_after_sec) params.set("stuck_after_sec", String(opts.stuck_after_sec));
    const q = params.toString();
    return get<GatewayOperatorSnapshot>(
      `/v1/admin/fhenix/gateway${q ? `?${q}` : ""}`,
      { "X-Admin-Token": token },
    );
  },
  adminGatewayTick: (token: string) =>
    post<GatewayTickResponse>(
      "/v1/admin/fhenix/gateway/tick",
      {},
      { "X-Admin-Token": token },
    ),
  adminGatewayRetry: (token: string, attemptId: string) =>
    post<GatewayRetryResponse>(
      `/v1/admin/fhenix/gateway/attempts/${encodeURIComponent(attemptId)}/retry`,
      {},
      { "X-Admin-Token": token },
    ),
  adminCanaries: (token: string) =>
    get<LiveCanarySnapshot>(
      "/v1/admin/canaries",
      { "X-Admin-Token": token },
    ),
  adminCanariesTick: (token: string) =>
    post<LiveCanarySnapshot>(
      "/v1/admin/canaries/tick",
      {},
      { "X-Admin-Token": token },
    ),
  adminFhenixLifecycle: (
    token: string,
    opts: { status?: FhenixRevealStatus; limit?: number; grace_sec?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.grace_sec) params.set("grace_sec", String(opts.grace_sec));
    const q = params.toString();
    return get<FhenixLifecycleSnapshot>(
      `/v1/admin/fhenix/lifecycle${q ? `?${q}` : ""}`,
      { "X-Admin-Token": token },
    );
  },
  adminIdentityControllers: (
    token: string,
    opts: { limit?: number; due_soon_hours?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.due_soon_hours) params.set("due_soon_hours", String(opts.due_soon_hours));
    const q = params.toString();
    return get<ControllerIdentitySnapshot>(
      `/v1/admin/identity/controllers${q ? `?${q}` : ""}`,
      { "X-Admin-Token": token },
    );
  },
  adminOperatorAlerts: (
    token: string,
    opts: {
      status?: OperatorAlertStatus;
      source?: string;
      delivery_status?: OperatorAlertDeliveryStatus;
      limit?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.source) params.set("source", opts.source);
    if (opts.delivery_status) params.set("delivery_status", opts.delivery_status);
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<OperatorAlertsSnapshot>(
      `/v1/admin/alerts${q ? `?${q}` : ""}`,
      { "X-Admin-Token": token },
    );
  },
  adminOperatorAlertsTick: (
    token: string,
    opts: {
      gateway_stuck_after_sec?: number;
      fhenix_reveal_grace_sec?: number;
      identity_due_soon_hours?: number;
    } = {},
  ) =>
    post<OperatorAlertTickResponse>(
      "/v1/admin/alerts/tick",
      opts,
      { "X-Admin-Token": token },
    ),
  adminFeedSla: (
    token: string,
    opts: { status?: FeedSlaIncidentStatus; feed_id?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.feed_id) params.set("feed_id", opts.feed_id);
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<FeedSlaAdminResponse>(
      `/v1/admin/feeds/sla${q ? `?${q}` : ""}`,
      { "X-Admin-Token": token },
    );
  },
  adminFeedSlaTick: (
    token: string,
    opts: { max_incidents?: number; feed_limit?: number } = {},
  ) =>
    post<FeedSlaTickResponse>(
      "/v1/admin/feeds/sla/tick",
      opts,
      { "X-Admin-Token": token },
    ),
  markets: (opts: { status?: string; asset_id?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.asset_id) params.set("asset_id", opts.asset_id);
    const q = params.toString();
    return get<{
      markets: MarketRow[];
      taxonomy: MarketTaxonomyResponse;
      served_at: string;
    }>(
      `/v1/markets${q ? `?${q}` : ""}`,
    );
  },
  marketTaxonomy: () =>
    get<{
      schema_version: number;
      served_at: string;
      taxonomy: MarketTaxonomyResponse;
    }>("/v1/markets/taxonomy"),
  marketLeaderboard: (
    market_id: string,
    opts: { limit?: number; tier?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.tier) params.set("tier", opts.tier);
    const q = params.toString();
    return get<{ market_id: string; agents: AgentMarketRow[]; served_at: string }>(
      `/v1/markets/${encodeURIComponent(market_id)}/leaderboard${q ? `?${q}` : ""}`,
    );
  },
  // Phase 10 — family + cross-family LBs.
  families: () =>
    get<{
      families: Array<{
        market_family: string;
        submissions: number;
        resolved: number;
      }>;
      served_at: string;
    }>(`/v1/families`),
  familyLeaderboard: (
    family: string,
    opts: { limit?: number; tier?: "main" | "provisional" } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.tier) params.set("tier", opts.tier);
    const q = params.toString();
    return get<{
      market_family: string;
      agents: AgentFamilyRow[];
      served_at: string;
    }>(
      `/v1/families/${encodeURIComponent(family)}/leaderboard${q ? `?${q}` : ""}`,
    );
  },
  crossFamilyLeaderboard: (opts: { limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<{ agents: AgentCrossFamilyRow[]; served_at: string }>(
      `/v1/leaderboard/cross-family${q ? `?${q}` : ""}`,
    );
  },
  agentGrid: (slug: string) =>
    get<{ agent: AgentGridSummary; grid: AgentMarketRow[]; served_at: string }>(
      `/v1/agents/${encodeURIComponent(slug)}/grid`,
    ),

  /* ── Phase 7a — account-area endpoints (Privy bearer required) ─────── */

  /**
   * Exchange a Privy access token for a Murmur account session. Idempotent:
   * `created` is true only on the first call per Privy user. The dashboard
   * uses this to branch onboarding ("welcome" vs "back so soon").
   */
  postAccountSession: (privyToken: string) =>
    post<AccountSession>(
      "/v1/account/session",
      {},
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * List agents owned by the authenticated account. Empty array when the
   * user hasn't declared an agent yet — Phase 7b's AgentNewPage handles
   * that case.
   */
  getAccountAgents: (privyToken: string) =>
    get<{ agents: AccountAgent[] }>("/v1/account/agents", {
      Authorization: `Bearer ${privyToken}`,
    }),

  /* ── Phase 7b — agent creation + one-time api-key mint ───────────────── */

  /**
   * Create a casual-tier agent under the authenticated account. Backend
   * returns 409 with code `duplicate` if the slug is taken or reserved
   * (the reserved-slug check lives behind the same UNIQUE constraint
   * path in v0.2). Surfaces as ApiError(status=409) so the UI can swap
   * in an inline "× taken" error.
   */
  postCreateAgent: (privyToken: string, body: CreateAgentRequest) =>
    post<CreateAgentResponse>(
      "/v1/account/agents",
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * Mint a new API key for the given slug. The plaintext `secret` is the
   * ONLY field that ever returns the cleartext key; it is hashed at rest
   * and not retrievable later. Caller MUST display it once + warn the
   * user that it will not be shown again (see ApiKeyMintModal).
   */
  postMintApiKey: (privyToken: string, slug: string, label?: string) =>
    post<MintApiKeyResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/api-keys`,
      label ? { label } : {},
      { Authorization: `Bearer ${privyToken}` },
    ),

  /* ── Phase 7c — settings page (payout + key rotation) ──────────────── */

  /**
   * List API keys for an agent (metadata only — no plaintext). Returns
   * both active and rotated keys so the panel can show full history;
   * the caller decides what to render. Backed by the additive Phase 7c
   * GET /v1/account/agents/:slug/api-keys route.
   */
  getApiKeys: (privyToken: string, slug: string) =>
    get<{ keys: ApiKeyRow[] }>(
      `/v1/account/agents/${encodeURIComponent(slug)}/api-keys`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * Soft-rotate (invalidate) an API key by id. Idempotent — a second
   * call returns rotated=false but does NOT throw. Old keys 401 within
   * ~1s of this returning (the verify path checks rotated_at IS NULL).
   */
  deleteApiKey: (privyToken: string, key_id: string) =>
    del<RotateApiKeyResponse>(
      `/v1/account/api-keys/${encodeURIComponent(key_id)}`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * Set/update the casual-tier payout destination. Surfaces 429 with
   * `retry_after_seconds` when the §7.4 24h cooldown is still active;
   * caller should parse ApiError.rawBody for the JSON body.
   */
  patchDestinationAddress: (
    privyToken: string,
    slug: string,
    destination_address: string,
  ) =>
    patch<PatchDestinationResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/destination-address`,
      { destination_address },
      { Authorization: `Bearer ${privyToken}` },
    ),

  postControllerWalletChallenge: (
    privyToken: string,
    slug: string,
    body: {
      wallet_address: string;
      chain_id: string;
      wallet_kind?: "embedded" | "external";
      provider?: string;
    },
  ) =>
    post<ControllerWalletChallengeResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/wallet/challenge`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * Bind the human-controlled Controller Wallet once. The signature is
   * produced from postControllerWalletChallenge().message.
   */
  patchAgentWallet: (
    privyToken: string,
    slug: string,
    body: {
      wallet_address: string;
      chain_id: string;
      wallet_kind?: "embedded" | "external";
      provider?: string;
      authorization_issued_at: string;
      signature: string;
    },
  ) =>
    patch<BindWalletResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/wallet`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  postControllerWalletReattestationChallenge: (
    privyToken: string,
    slug: string,
  ) =>
    post<ControllerWalletReattestationChallengeResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/wallet/reattest/challenge`,
      {},
      { Authorization: `Bearer ${privyToken}` },
    ),

  postControllerWalletReattestation: (
    privyToken: string,
    slug: string,
    body: {
      attestation_nonce: string;
      authorization_issued_at: string;
      signature: string;
    },
  ) =>
    post<ControllerWalletReattestationResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/wallet/reattest`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  getRuntimeKeys: (privyToken: string, slug: string) =>
    get<{ keys: RuntimeKeyRow[] }>(
      `/v1/account/agents/${encodeURIComponent(slug)}/runtime-keys`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  postRuntimeKeyChallenge: (
    privyToken: string,
    slug: string,
    body: { policy?: RuntimeKeyPolicy; expires_at?: string },
  ) =>
    post<RuntimeKeyChallengeResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/runtime-keys/challenge`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  postRuntimeKey: (
    privyToken: string,
    slug: string,
    body: {
      label?: string;
      policy?: RuntimeKeyPolicy;
      expires_at?: string;
      authorization_nonce: string;
      authorization_issued_at: string;
      signature: string;
    },
  ) =>
    post<RuntimeKeyMintResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/runtime-keys`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  deleteRuntimeKey: (privyToken: string, key_id: string, reason?: string) =>
    del<{ revoked: boolean }>(
      `/v1/account/runtime-keys/${encodeURIComponent(key_id)}`,
      { Authorization: `Bearer ${privyToken}` },
      reason ? { reason } : {},
    ),

  /* ── Phase 7d — onboarding funnel emit (account-scoped audit trail) ──── */

  /**
   * Emit a single funnel event. Server-side allowlist rejects anything
   * outside FunnelEventKind with 400. The dashboard NEVER renders errors
   * from this endpoint — useFunnelEmit swallows ApiError so analytics
   * issues can't bubble into the UI.
   */
  postFunnelEvent: (
    privyToken: string,
    kind: FunnelEventKind,
    attributes?: Record<string, unknown>,
  ) =>
    postNoContent(
      "/v1/account/events",
      attributes ? { kind, attributes } : { kind },
      { Authorization: `Bearer ${privyToken}` },
    ),
};

/* ── Top-level convenience exports ─────────────────────────────────────── */
// Mirror the daemon-facing names from V14_HANDOFF so subagent-driven code
// can `import { fetchMarkets } from "../api"` without going through the
// `verdictApi.markets(…)` namespace. Both paths return the same payload.

export async function fetchMarkets(
  opts: { status?: string; asset_id?: string } = {},
): Promise<MarketRow[]> {
  const r = await verdictApi.markets(opts);
  return r.markets;
}

export async function fetchMarketTaxonomy(): Promise<MarketTaxonomyResponse> {
  const r = await verdictApi.marketTaxonomy();
  return r.taxonomy;
}

export async function fetchMarketLeaderboard(
  market_id: string,
  opts: { limit?: number; tier?: string } = {},
): Promise<{ market_id: string; agents: AgentMarketRow[] }> {
  const r = await verdictApi.marketLeaderboard(market_id, opts);
  return { market_id: r.market_id, agents: r.agents };
}

export async function fetchAgentGrid(
  slug: string,
): Promise<{ agent: AgentGridSummary; grid: AgentMarketRow[] }> {
  const r = await verdictApi.agentGrid(slug);
  return { agent: r.agent, grid: r.grid };
}
