import type Database from "better-sqlite3";
import { z } from "zod";
import {
  fhenixGatewayFeedPacketTxRepo,
  fhenixGatewayTxRepo,
  type FhenixGatewayFeedPacketTxAttemptRow,
  type FhenixGatewayTxAttemptRow,
  type FhenixGatewayTxStatus,
  type FhenixRevealStatus,
} from "./db.js";
import { fhenixLifecycleReadRepo } from "./repos/fhenix-lifecycle-read-repo.js";
import { isoFromMs, nowIso } from "./time.js";

export const GatewayAttemptStatusSchema = z.enum([
  "queued",
  "submitted",
  "confirmed",
  "accepted",
  "failed_retryable",
  "failed_terminal",
]);

export const FhenixRevealStatusSchema = z.enum([
  "pending",
  "revealed",
  "invalid",
  "missed",
]);

const GATEWAY_ATTEMPT_STATUSES = GatewayAttemptStatusSchema.options;
export function fhenixLifecycleSnapshot(
  db: Database.Database,
  opts: {
    now: () => Date;
    verifier_configured: boolean;
    status?: FhenixRevealStatus;
    limit: number;
    graceSeconds: number;
  },
) {
  const servedAt = nowIso(opts.now());
  const graceCutoff = isoFromMs(opts.now().getTime() - opts.graceSeconds * 1_000);
  const counts = fhenixLifecycleReadRepo.statusCounts(db);
  const cursors = fhenixLifecycleReadRepo.cursors(db);
  const pendingNotOpen = fhenixLifecycleReadRepo.pendingNotOpenCount(db, servedAt);
  const openPending = fhenixLifecycleReadRepo.openPendingCount(db, servedAt);
  const overdueGrace = fhenixLifecycleReadRepo.overdueGraceCount(db, graceCutoff);
  const invalid = counts.invalid ?? 0;
  const missed = counts.missed ?? 0;
  const needsAttention = overdueGrace + invalid + missed;
  return {
    served_at: servedAt,
    configured: {
      verifier: opts.verifier_configured,
      watcher: cursors.length > 0,
      reveal_grace_seconds: opts.graceSeconds,
    },
    counts,
    queues: {
      pending_not_open: pendingNotOpen,
      open_pending: openPending,
      overdue_grace: overdueGrace,
      terminal_failures: invalid + missed,
      needs_attention: needsAttention,
      grace_cutoff: graceCutoff,
    },
    cursors,
    event_counts: fhenixLifecycleReadRepo.eventCounts(db),
    needs_attention: fhenixLifecycleRows(db, {
      limit: opts.limit,
      graceCutoff,
      attentionOnly: true,
    }),
    recent: fhenixLifecycleRows(db, {
      limit: opts.limit,
      status: opts.status,
      graceCutoff,
    }),
  };
}

export function controllerIdentitySnapshot(
  db: Database.Database,
  opts: {
    now: () => Date;
    limit: number;
    dueSoonHours: number;
  },
) {
  const servedAt = nowIso(opts.now());
  const dueSoonAt = isoFromMs(
    opts.now().getTime() + opts.dueSoonHours * 60 * 60 * 1_000,
  );
  const totalControllers = scalarCount(
    db,
    "SELECT COUNT(*) AS count FROM agent_controller_wallets",
    [],
  );
  const overdue = scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM agent_controller_wallets
     WHERE reattestation_due_at IS NULL
        OR reattestation_due_at <= ?`,
    [servedAt],
  );
  const dueSoon = scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM agent_controller_wallets
     WHERE reattestation_due_at > ?
       AND reattestation_due_at <= ?`,
    [servedAt, dueSoonAt],
  );
  const activeRuntimeKeys = scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM agent_runtime_keys
     WHERE revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
    [servedAt],
  );
  const rows = controllerIdentityRows(db, {
    limit: opts.limit,
    nowIso: servedAt,
    dueSoonAt,
  });
  return {
    served_at: servedAt,
    due_soon_at: dueSoonAt,
    counts: {
      controller_wallets: totalControllers,
      overdue,
      due_soon: dueSoon,
      active_runtime_keys: activeRuntimeKeys,
      needs_attention: overdue + dueSoon,
    },
    needs_attention: rows.filter((row) => row.status !== "current"),
    rows,
  };
}

export function unconfiguredGatewaySnapshot(
  db: Database.Database,
  opts: {
    now: () => Date;
    status?: FhenixGatewayTxStatus;
    limit: number;
    stuckAfterMs?: number;
  },
) {
  const servedAt = nowIso(opts.now());
  const stuckAfterMs = Math.max(60_000, Math.floor(opts.stuckAfterMs ?? 10 * 60_000));
  const staleBefore = isoFromMs(opts.now().getTime() - stuckAfterMs);
  const stuck = fhenixGatewayTxRepo.listStuck(db, {
    stale_before: staleBefore,
    limit: opts.limit,
  });
  const feedStuck = fhenixGatewayFeedPacketTxRepo.listStuck(db, {
    stale_before: staleBefore,
    limit: opts.limit,
  });
  return {
    served_at: servedAt,
    configured: false as const,
    config: null,
    queues: {
      due_for_broadcast: fhenixGatewayTxRepo.countDueForBroadcast(db, servedAt),
      submitted_awaiting_confirmation: fhenixGatewayTxRepo.countSubmittedForConfirmation(db),
      confirmed_awaiting_acceptance: fhenixGatewayTxRepo.countConfirmedForAcceptance(db),
      stuck: stuck.length,
      stale_before: staleBefore,
    },
    status_counts: gatewayStatusCounts(db),
    telemetry: fhenixGatewayTxRepo.telemetrySummary(db),
    recent_attempts: fhenixGatewayTxRepo
      .listRecent(db, { status: opts.status, limit: opts.limit })
      .map(gatewayAttemptSummary),
    stuck_attempts: stuck.map(gatewayAttemptSummary),
    feed_queues: {
      due_for_broadcast: fhenixGatewayFeedPacketTxRepo.countDueForBroadcast(db, servedAt),
      submitted_awaiting_confirmation: fhenixGatewayFeedPacketTxRepo.countSubmittedForConfirmation(db),
      confirmed_awaiting_acceptance: fhenixGatewayFeedPacketTxRepo.countConfirmedForAcceptance(db),
      stuck: feedStuck.length,
      stale_before: staleBefore,
    },
    feed_status_counts: gatewayFeedStatusCounts(db),
    feed_telemetry: fhenixGatewayFeedPacketTxRepo.telemetrySummary(db),
    feed_recent_attempts: fhenixGatewayFeedPacketTxRepo
      .listRecent(db, { status: opts.status, limit: opts.limit })
      .map(gatewayFeedAttemptSummary),
    feed_stuck_attempts: feedStuck.map(gatewayFeedAttemptSummary),
  };
}

function fhenixLifecycleRows(
  db: Database.Database,
  opts: {
    limit: number;
    graceCutoff: string;
    status?: FhenixRevealStatus;
    attentionOnly?: boolean;
  },
) {
  const rows = fhenixLifecycleReadRepo.rows(db, opts);
  return rows.map((row) => ({
    call_id: row.call_id,
    chain_id: row.chain_id,
    contract_address: row.contract_address,
    onchain_call_id: row.onchain_call_id,
    reveal_status: row.reveal_status,
    reveal_open_at: row.reveal_open_at,
    revealed_at: row.revealed_at,
    terminal_at: row.terminal_at,
    invalid_reason: row.invalid_reason,
    reveal_tx_hash: row.reveal_tx_hash,
    reveal_block_number: row.reveal_block_number,
    agent_id: row.agent_id,
    agent_slug: row.agent_slug,
    market_id: row.market_id,
    submission_status: row.submission_status,
    resolution: row.resolution_outcome
      ? {
          outcome: row.resolution_outcome,
          call_score: row.call_score,
          resolved_at: row.resolved_at,
        }
      : null,
    overdue_grace:
      row.reveal_status === "pending" && row.reveal_open_at <= opts.graceCutoff,
  }));
}

function scalarCount(
  db: Database.Database,
  sql: string,
  params: unknown[],
): number {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

function controllerIdentityRows(
  db: Database.Database,
  opts: {
    limit: number;
    nowIso: string;
    dueSoonAt: string;
  },
) {
  const rows = db
    .prepare(
      `SELECT
        c.agent_id,
        c.account_id,
        a.display_slug AS agent_slug,
        c.wallet_address,
        c.chain_id,
        c.wallet_kind,
        c.provider,
        c.created_at,
        c.last_attested_at,
        c.reattestation_due_at,
        (
          SELECT COUNT(*) FROM agent_runtime_keys k
          WHERE k.agent_id = c.agent_id
        ) AS total_runtime_keys,
        (
          SELECT COUNT(*) FROM agent_runtime_keys k
          WHERE k.agent_id = c.agent_id
            AND k.revoked_at IS NULL
            AND (k.expires_at IS NULL OR k.expires_at > @now_iso)
        ) AS active_runtime_keys,
        (
          SELECT COUNT(*) FROM agent_runtime_keys k
          WHERE k.agent_id = c.agent_id
            AND k.revoked_at IS NOT NULL
        ) AS revoked_runtime_keys,
        (
          SELECT MAX(k.created_at) FROM agent_runtime_keys k
          WHERE k.agent_id = c.agent_id
        ) AS last_runtime_key_created_at
       FROM agent_controller_wallets c
       LEFT JOIN agents a ON a.agent_id = c.agent_id
       ORDER BY
         CASE WHEN c.reattestation_due_at IS NULL THEN 0 ELSE 1 END,
         c.reattestation_due_at ASC,
         c.created_at DESC
       LIMIT @limit`,
    )
    .all({ now_iso: opts.nowIso, limit: opts.limit }) as ControllerIdentityRow[];
  return rows.map((row) => {
    const status = controllerIdentityStatus(row.reattestation_due_at, {
      nowIso: opts.nowIso,
      dueSoonAt: opts.dueSoonAt,
    });
    return {
      ...row,
      status,
      reattestation_overdue: status === "overdue" || status === "missing_due_at",
      reattestation_due_soon: status === "due_soon",
    };
  });
}

function controllerIdentityStatus(
  dueAt: string | null,
  opts: { nowIso: string; dueSoonAt: string },
): ControllerIdentityStatus {
  if (!dueAt) return "missing_due_at";
  if (dueAt <= opts.nowIso) return "overdue";
  if (dueAt <= opts.dueSoonAt) return "due_soon";
  return "current";
}

function gatewayStatusCounts(
  db: Database.Database,
): Record<FhenixGatewayTxStatus, number> {
  const counts = Object.fromEntries(
    GATEWAY_ATTEMPT_STATUSES.map((status) => [status, 0]),
  ) as Record<FhenixGatewayTxStatus, number>;
  for (const row of fhenixGatewayTxRepo.statusCounts(db)) {
    counts[row.status] = row.count;
  }
  return counts;
}

function gatewayFeedStatusCounts(
  db: Database.Database,
): Record<FhenixGatewayTxStatus, number> {
  const counts = Object.fromEntries(
    GATEWAY_ATTEMPT_STATUSES.map((status) => [status, 0]),
  ) as Record<FhenixGatewayTxStatus, number>;
  for (const row of fhenixGatewayFeedPacketTxRepo.statusCounts(db)) {
    counts[row.status] = row.count;
  }
  return counts;
}

function gatewayAttemptSummary(row: FhenixGatewayTxAttemptRow) {
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

function gatewayFeedAttemptSummary(row: FhenixGatewayFeedPacketTxAttemptRow) {
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

type ControllerIdentityStatus = "current" | "due_soon" | "overdue" | "missing_due_at";

interface ControllerIdentityRow {
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
}
