import type Database from "better-sqlite3";

import {
  fhenixGatewayTxRepo,
  type FhenixGatewayTxAttemptRow,
} from "./repos/fhenix-gateway-tx-repo.js";
import {
  fhenixGatewayFeedPacketTxRepo,
  type FhenixGatewayFeedPacketTxAttemptRow,
} from "./repos/fhenix-gateway-feed-packet-tx-repo.js";
import type {
  FhenixGatewayTelemetrySummary,
  FhenixGatewayTxStatus,
} from "./repos/fhenix-gateway-attempt-lifecycle.js";
import { GATEWAY_ATTEMPT_STATUSES } from "./operator-control-schemas.js";
import { isoFromMs, nowIso } from "./time.js";

export interface GatewayOperatorAttempt {
  attempt_id: string;
  status: FhenixGatewayTxStatus;
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
  status: FhenixGatewayTxStatus;
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

export interface GatewayOperatorSnapshotConfig {
  chain_id: number;
  contract_address: string;
  relayer_address: string;
  confirmations: number;
  retry_base_ms: number;
  retry_max_ms: number;
  max_attempts: number;
  stuck_after_ms: number;
}

export interface GatewayOperatorQueueSnapshot {
  due_for_broadcast: number;
  submitted_awaiting_confirmation: number;
  confirmed_awaiting_acceptance: number;
  stuck: number;
  stale_before: string;
}

interface GatewayOperatorSnapshotBase {
  served_at: string;
  queues: GatewayOperatorQueueSnapshot;
  status_counts: Record<FhenixGatewayTxStatus, number>;
  telemetry: FhenixGatewayTelemetrySummary;
  recent_attempts: GatewayOperatorAttempt[];
  stuck_attempts: GatewayOperatorAttempt[];
  feed_queues: GatewayOperatorQueueSnapshot;
  feed_status_counts: Record<FhenixGatewayTxStatus, number>;
  feed_telemetry: FhenixGatewayTelemetrySummary;
  feed_recent_attempts: GatewayOperatorFeedAttempt[];
  feed_stuck_attempts: GatewayOperatorFeedAttempt[];
}

export interface ConfiguredGatewayOperatorSnapshot
  extends GatewayOperatorSnapshotBase {
  configured: true;
  config: GatewayOperatorSnapshotConfig;
}

export interface UnconfiguredGatewayOperatorSnapshot
  extends GatewayOperatorSnapshotBase {
  configured: false;
  config: null;
}

export type GatewayOperatorSnapshot =
  | ConfiguredGatewayOperatorSnapshot
  | UnconfiguredGatewayOperatorSnapshot;

interface GatewayOperatorSnapshotParamsBase {
  db: Database.Database;
  servedAt: Date;
  status?: FhenixGatewayTxStatus;
  limit?: number;
  stuckAfterMs?: number;
}

interface ConfiguredGatewayOperatorSnapshotParams
  extends GatewayOperatorSnapshotParamsBase {
  config: GatewayOperatorSnapshotConfig;
}

interface UnconfiguredGatewayOperatorSnapshotParams
  extends GatewayOperatorSnapshotParamsBase {
  config: null;
}

export function unconfiguredGatewaySnapshot(
  db: Database.Database,
  opts: {
    servedAt: Date;
    status?: FhenixGatewayTxStatus;
    limit: number;
    stuckAfterMs?: number;
  },
): UnconfiguredGatewayOperatorSnapshot {
  return buildGatewayOperatorSnapshot({
    db,
    servedAt: opts.servedAt,
    status: opts.status,
    limit: opts.limit,
    stuckAfterMs: opts.stuckAfterMs,
    config: null,
  });
}

export function buildGatewayOperatorSnapshot(
  params: ConfiguredGatewayOperatorSnapshotParams,
): ConfiguredGatewayOperatorSnapshot;
export function buildGatewayOperatorSnapshot(
  params: UnconfiguredGatewayOperatorSnapshotParams,
): UnconfiguredGatewayOperatorSnapshot;
export function buildGatewayOperatorSnapshot(
  params: ConfiguredGatewayOperatorSnapshotParams | UnconfiguredGatewayOperatorSnapshotParams,
): GatewayOperatorSnapshot {
  const servedAt = nowIso(params.servedAt);
  const config = params.config;
  const defaultStuckAfterMs = config?.stuck_after_ms ?? 10 * 60_000;
  const stuckAfterMs = Math.max(
    60_000,
    Math.floor(params.stuckAfterMs ?? defaultStuckAfterMs),
  );
  const staleBefore = isoFromMs(params.servedAt.getTime() - stuckAfterMs);
  const limit = params.limit ?? 50;
  const stuck = fhenixGatewayTxRepo.listStuck(params.db, {
    stale_before: staleBefore,
    limit,
  });
  const feedStuck = fhenixGatewayFeedPacketTxRepo.listStuck(params.db, {
    stale_before: staleBefore,
    limit,
  });
  const snapshot = {
    served_at: servedAt,
    queues: {
      due_for_broadcast: fhenixGatewayTxRepo.countDueForBroadcast(params.db, servedAt),
      submitted_awaiting_confirmation: fhenixGatewayTxRepo.countSubmittedForConfirmation(params.db),
      confirmed_awaiting_acceptance: fhenixGatewayTxRepo.countConfirmedForAcceptance(params.db),
      stuck: stuck.length,
      stale_before: staleBefore,
    },
    status_counts: gatewayStatusCounts(params.db),
    telemetry: fhenixGatewayTxRepo.telemetrySummary(params.db),
    recent_attempts: fhenixGatewayTxRepo
      .listRecent(params.db, { status: params.status, limit })
      .map(gatewayAttemptSummary),
    stuck_attempts: stuck.map(gatewayAttemptSummary),
    feed_queues: {
      due_for_broadcast: fhenixGatewayFeedPacketTxRepo.countDueForBroadcast(params.db, servedAt),
      submitted_awaiting_confirmation: fhenixGatewayFeedPacketTxRepo.countSubmittedForConfirmation(params.db),
      confirmed_awaiting_acceptance: fhenixGatewayFeedPacketTxRepo.countConfirmedForAcceptance(params.db),
      stuck: feedStuck.length,
      stale_before: staleBefore,
    },
    feed_status_counts: gatewayFeedStatusCounts(params.db),
    feed_telemetry: fhenixGatewayFeedPacketTxRepo.telemetrySummary(params.db),
    feed_recent_attempts: fhenixGatewayFeedPacketTxRepo
      .listRecent(params.db, { status: params.status, limit })
      .map(gatewayFeedAttemptSummary),
    feed_stuck_attempts: feedStuck.map(gatewayFeedAttemptSummary),
  };
  if (config) {
    return {
      ...snapshot,
      configured: true,
      config: { ...config, stuck_after_ms: stuckAfterMs },
    };
  }
  return {
    ...snapshot,
    configured: false,
    config: null,
  };
}

export function gatewayStatusCounts(
  db: Database.Database,
): Record<FhenixGatewayTxStatus, number> {
  const counts = emptyGatewayStatusCounts();
  for (const row of fhenixGatewayTxRepo.statusCounts(db)) {
    counts[row.status] = row.count;
  }
  return counts;
}

export function gatewayFeedStatusCounts(
  db: Database.Database,
): Record<FhenixGatewayTxStatus, number> {
  const counts = emptyGatewayStatusCounts();
  for (const row of fhenixGatewayFeedPacketTxRepo.statusCounts(db)) {
    counts[row.status] = row.count;
  }
  return counts;
}

function emptyGatewayStatusCounts(): Record<FhenixGatewayTxStatus, number> {
  return Object.fromEntries(
    GATEWAY_ATTEMPT_STATUSES.map((status) => [status, 0]),
  ) as Record<FhenixGatewayTxStatus, number>;
}

export function gatewayAttemptSummary(
  row: FhenixGatewayTxAttemptRow,
): GatewayOperatorAttempt {
  return {
    attempt_id: row.attempt_id,
    status: row.status,
    account_id: row.account_id,
    agent_id: row.agent_id,
    runtime_key_id: row.runtime_key_id,
    runtime_key_policy_hash: row.runtime_key_policy_hash,
    chain_id: row.chain_id,
    contract_address: row.contract_address,
    relayer_address: row.relayer_address,
    agent_wallet_address: row.agent_wallet_address,
    market_id: row.market_id,
    market_id_hash: row.market_id_hash,
    market_ref_protocol: row.market_ref_protocol,
    market_config_version: row.market_config_version,
    client_order_id: row.client_order_id,
    client_nonce: row.client_nonce,
    tx_hash: row.tx_hash,
    submit_log_index: row.submit_log_index,
    submit_block_number: row.submit_block_number,
    onchain_call_id: row.onchain_call_id,
    call_id: row.call_id,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    last_error: row.last_error,
    broadcast_started_at: row.broadcast_started_at,
    broadcast_latency_ms: row.broadcast_latency_ms,
    receipt_observed_at: row.receipt_observed_at,
    receipt_latency_ms: row.receipt_latency_ms,
    latest_block_latency_ms: row.latest_block_latency_ms,
    receipt_status: row.receipt_status,
    receipt_block_number: row.receipt_block_number,
    latest_block_number: row.latest_block_number,
    confirmations_observed: row.confirmations_observed,
    gas_used: row.gas_used,
    effective_gas_price_wei: row.effective_gas_price_wei,
    last_rpc_error: row.last_rpc_error,
    submitted_at: row.submitted_at,
    accepted_at: row.accepted_at,
    reveal_open_at: row.reveal_open_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function gatewayFeedAttemptSummary(
  row: FhenixGatewayFeedPacketTxAttemptRow,
): GatewayOperatorFeedAttempt {
  return {
    attempt_id: row.attempt_id,
    status: row.status,
    account_id: row.account_id,
    agent_id: row.agent_id,
    runtime_key_id: row.runtime_key_id,
    runtime_key_policy_hash: row.runtime_key_policy_hash,
    chain_id: row.chain_id,
    contract_address: row.contract_address,
    relayer_address: row.relayer_address,
    agent_wallet_address: row.agent_wallet_address,
    feed_id: row.feed_id,
    feed_id_hash: row.feed_id_hash,
    market_id: row.market_id,
    market_id_hash: row.market_id_hash,
    packet_kind: row.packet_kind,
    sequence: row.sequence,
    payload_schema: row.payload_schema,
    client_order_id: row.client_order_id,
    client_nonce: row.client_nonce,
    tx_hash: row.tx_hash,
    submit_log_index: row.submit_log_index,
    submit_block_number: row.submit_block_number,
    onchain_packet_id: row.onchain_packet_id,
    packet_id: row.packet_id,
    action_ct_hash: row.action_ct_hash,
    signal_ct_hash: row.signal_ct_hash,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    last_error: row.last_error,
    broadcast_started_at: row.broadcast_started_at,
    broadcast_latency_ms: row.broadcast_latency_ms,
    receipt_observed_at: row.receipt_observed_at,
    receipt_latency_ms: row.receipt_latency_ms,
    latest_block_latency_ms: row.latest_block_latency_ms,
    receipt_status: row.receipt_status,
    receipt_block_number: row.receipt_block_number,
    latest_block_number: row.latest_block_number,
    confirmations_observed: row.confirmations_observed,
    gas_used: row.gas_used,
    effective_gas_price_wei: row.effective_gas_price_wei,
    last_rpc_error: row.last_rpc_error,
    submitted_at: row.submitted_at,
    delivery_deadline_at: row.delivery_deadline_at,
    accepted_at: row.accepted_at,
    reveal_after: row.reveal_after,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
