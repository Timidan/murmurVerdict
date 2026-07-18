// Shared REST wire types — operator / admin surfaces (token-gated): fhenix
// gateway, live canaries, fhenix lifecycle, controller identity, operator
// alerts, feed-SLA. Browser-safe; see wire-agent.ts for rules. Producer
// guards pin these against the daemon operator snapshots / presenters.

/* ── Fhenix gateway ──────────────────────────────────────────────────────── */

export type WireGatewayAttemptStatus =
  | "queued"
  | "submitted"
  | "confirmed"
  | "accepted"
  | "failed_retryable"
  | "failed_terminal";

export interface WireGatewayOperatorAttempt {
  attempt_id: string;
  status: WireGatewayAttemptStatus;
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

export interface WireGatewayOperatorFeedAttempt {
  attempt_id: string;
  status: WireGatewayAttemptStatus;
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

export interface WireGatewayTelemetrySummary {
  avg_broadcast_latency_ms: number | null;
  avg_receipt_latency_ms: number | null;
  avg_latest_block_latency_ms: number | null;
  max_confirmations_observed: number | null;
  rpc_errors: number;
  last_receipt_observed_at: string | null;
}

interface WireGatewayQueueSnapshot {
  due_for_broadcast: number;
  submitted_awaiting_confirmation: number;
  confirmed_awaiting_acceptance: number;
  stuck: number;
  stale_before: string;
}

export interface WireGatewayOperatorSnapshot {
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
  queues: WireGatewayQueueSnapshot;
  status_counts: Record<WireGatewayAttemptStatus, number>;
  telemetry: WireGatewayTelemetrySummary;
  recent_attempts: WireGatewayOperatorAttempt[];
  stuck_attempts: WireGatewayOperatorAttempt[];
  feed_queues: WireGatewayQueueSnapshot;
  feed_status_counts: Record<WireGatewayAttemptStatus, number>;
  feed_telemetry: WireGatewayTelemetrySummary;
  feed_recent_attempts: WireGatewayOperatorFeedAttempt[];
  feed_stuck_attempts: WireGatewayOperatorFeedAttempt[];
}

export interface WireGatewayTickResponse {
  schema_version: number;
  served_at: string;
  result: {
    broadcasted: number;
    confirmed: number;
    accepted: number;
    failed: number;
  };
  gateway: WireGatewayOperatorSnapshot;
}

export interface WireGatewayRetryResponse {
  schema_version: number;
  served_at: string;
  attempt_id: string;
  status: WireGatewayAttemptStatus;
  tx_hash: string | null;
  call_id: string | null;
  next_attempt_at: string;
  idempotent_hit: boolean;
}

/* ── Live canaries ───────────────────────────────────────────────────────── */

export type WireLiveCanaryStatus = "ok" | "fail" | "disabled";
export type WireLiveCanaryName = "fhenix_rpc" | "polymarket_gamma";

export interface WireLiveCanaryCheck {
  name: WireLiveCanaryName;
  status: WireLiveCanaryStatus;
  checked_at: string;
  latency_ms: number | null;
  details: Record<string, string | number | boolean | null>;
  error: string | null;
}

export interface WireLiveCanarySnapshot {
  schema_version: number;
  served_at: string;
  ok: boolean;
  checks: WireLiveCanaryCheck[];
}

/* ── Fhenix lifecycle ────────────────────────────────────────────────────── */

export type WireFhenixRevealStatus = "pending" | "revealed" | "invalid" | "missed";

export interface WireFhenixLifecycleRow {
  call_id: string;
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  reveal_status: WireFhenixRevealStatus;
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

export interface WireFhenixLifecycleSnapshot {
  schema_version: number;
  served_at: string;
  configured: {
    verifier: boolean;
    watcher: boolean;
    reveal_grace_seconds: number;
  };
  counts: Record<WireFhenixRevealStatus, number>;
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
  needs_attention: WireFhenixLifecycleRow[];
  recent: WireFhenixLifecycleRow[];
}

/* ── Controller identity ─────────────────────────────────────────────────── */

export type WireControllerIdentityStatus =
  | "current"
  | "due_soon"
  | "overdue"
  | "missing_due_at";

export interface WireControllerIdentityRow {
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
  status: WireControllerIdentityStatus;
  reattestation_overdue: boolean;
  reattestation_due_soon: boolean;
}

export interface WireControllerIdentitySnapshot {
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
  needs_attention: WireControllerIdentityRow[];
  rows: WireControllerIdentityRow[];
}

/* ── Operator alerts ─────────────────────────────────────────────────────── */

export type WireOperatorAlertSeverity = "info" | "warning" | "critical";
export type WireOperatorAlertStatus = "open" | "resolved";
export type WireOperatorAlertDeliveryStatus = "pending" | "delivered" | "failed";

export interface WireOperatorAlert {
  alert_id: string;
  alert_key: string;
  source: string;
  kind: string;
  severity: WireOperatorAlertSeverity;
  status: WireOperatorAlertStatus;
  title: string;
  description: string;
  payload: unknown;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  resolved_at: string | null;
  delivery_status: WireOperatorAlertDeliveryStatus;
  delivery_attempts: number;
  next_delivery_at: string | null;
  last_delivery_at: string | null;
  last_delivery_status: number | null;
  last_delivery_error: string | null;
}

export interface WireOperatorAlertsSnapshot {
  schema_version: number;
  served_at: string;
  sink_configured: boolean;
  counts: Record<
    WireOperatorAlertStatus,
    {
      total: number;
      critical: number;
      warning: number;
      info: number;
    }
  >;
  alerts: WireOperatorAlert[];
}

export interface WireOperatorAlertTickResponse {
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
  snapshot: WireOperatorAlertsSnapshot;
}

/* ── Feed SLA + availability ─────────────────────────────────────────────── */

export type WireFeedSlaIncidentStatus = "open" | "fulfilled_late";

export interface WireFeedSlaIncident {
  incident_id: string;
  feed_id: string;
  agent_id: string;
  // The daemon presenter (publicFeedSlaIncident) widens these enum-ish fields
  // to `string`, so the wire contract does too — see wire-contract-guards.ts.
  incident_kind: string;
  status: string;
  expected_sequence: number;
  expected_delivery_deadline_at: string;
  detected_at: string;
  grace_seconds: number;
  refund_action: string;
  slash_action: string;
  fulfilled_packet_id: string | null;
  fulfilled_at: string | null;
  details: unknown;
  created_at: string;
  updated_at: string;
}

export interface WireFeedAvailabilitySummary {
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

export interface WireFeedAvailabilityProof extends WireFeedAvailabilitySummary {
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

export interface WireFeedSlaAdminResponse {
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
  feed_health: WireFeedAvailabilitySummary[];
  incidents: WireFeedSlaIncident[];
}

export interface WireFeedSlaTickResponse {
  schema_version: number;
  result: {
    served_at: string;
    inspected_feeds: number;
    incidents_opened: number;
    max_incidents: number;
  };
  open_incidents: WireFeedSlaIncident[];
}
