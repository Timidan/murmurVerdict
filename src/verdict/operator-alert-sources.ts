import type Database from "better-sqlite3";

import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import { controllerWalletReattestationHealth } from "./auth/controller-wallets.js";
import {
  fhenixGatewayTxRepo,
  type FhenixGatewayTxAttemptRow,
} from "./repos/fhenix-gateway-tx-repo.js";
import {
  fhenixGatewayFeedPacketTxRepo,
  type FhenixGatewayFeedPacketTxAttemptRow,
} from "./repos/fhenix-gateway-feed-packet-tx-repo.js";
import { feedSlaIncidentsRepo } from "./repos/feed-availability-repo.js";
import { fhenixSealedCallsRepo } from "./repos/fhenix-sealed-calls-repo.js";
import { polymarketDiscoveryRepo } from "./repos/polymarket-discovery-repo.js";
import type {
  OperatorAlertInput,
  OperatorAlertSeverity,
} from "./repos/operator-alerts-repo.js";
import {
  encodeOperatorAlertPayload,
  feedSlaIncidentAlertPayload,
} from "./operator-alert-payload.js";
import { isoFromMs } from "./time.js";

const DEFAULT_STUCK_AFTER_MS = 10 * 60_000;
const DEFAULT_REVEAL_GRACE_SEC = 60 * 60;
// Additional overdue window past the grace before an unrevealed sealed call
// escalates from warning to critical. A call is revealable forever, so this is
// a worker-HEALTH escalation, never a terminal `missed` marking.
const REVEAL_ESCALATE_AFTER_SEC = 30 * 60;
const DEFAULT_IDENTITY_DUE_SOON_HOURS = 24;

export interface OperatorAlertSourceOptions {
  db: Database.Database;
  servedAt: string;
  liveCanaries?: LiveCanaryProvider | null;
  gatewayStuckAfterMs?: number;
  /** Contract this deployment runs; gateway alerts are scoped to it. Unset = no scoping. */
  fhenixContractAddress?: string | null;
  fhenixRevealGraceSec?: number;
  identityDueSoonHours?: number;
}

export interface OperatorAlertSourceBatch {
  source: string;
  alerts: OperatorAlertInput[];
}

// A registration tx unconfirmed this long is stuck, not slow. Base blocks are
// ~2s, so minutes without a receipt means the nonce is not progressing.
const STUCK_REGISTRATION_WARN_MS = 10 * 60_000;
const STUCK_REGISTRATION_CRITICAL_MS = 30 * 60_000;

export function collectOperatorAlertSources(
  opts: OperatorAlertSourceOptions,
): OperatorAlertSourceBatch[] {
  const batches: OperatorAlertSourceBatch[] = [
    {
      source: "gateway",
      alerts: gatewayAlerts(
        opts.db,
        opts.servedAt,
        opts.gatewayStuckAfterMs,
        opts.fhenixContractAddress ?? null,
      ),
    },
    {
      source: "fhenix_lifecycle",
      alerts: fhenixLifecycleAlerts(
        opts.db,
        opts.servedAt,
        opts.fhenixRevealGraceSec,
      ),
    },
    {
      source: "feed_sla",
      alerts: feedSlaAlerts(opts.db, opts.servedAt),
    },
    {
      source: "identity",
      alerts: identityAlerts(
        opts.db,
        opts.servedAt,
        opts.identityDueSoonHours,
      ),
    },
    {
      source: "polymarket_discovery",
      alerts: polymarketDiscoveryAlerts(opts.db, opts.servedAt),
    },
  ];
  if (opts.liveCanaries) {
    batches.push({
      source: "live_canary",
      alerts: liveCanaryAlerts(opts.liveCanaries, opts.servedAt),
    });
  }
  return batches;
}

function gatewayAlerts(
  db: Database.Database,
  servedAt: string,
  stuckAfterMs = DEFAULT_STUCK_AFTER_MS,
  contractAddress: string | null = null,
): OperatorAlertInput[] {
  const staleBefore = isoFromMs(Date.parse(servedAt) - Math.max(60_000, stuckAfterMs));
  const alerts: OperatorAlertInput[] = [];
  // Case-insensitive: addresses are stored lowercase but configured checksummed.
  const wanted = contractAddress?.toLowerCase() ?? null;
  const live = (a: { contract_address?: string | null }): boolean =>
    wanted === null || (a.contract_address ?? "").toLowerCase() === wanted;
  for (const attempt of fhenixGatewayTxRepo.listStuck(db, { stale_before: staleBefore, limit: 100 })) {
    if (!live(attempt)) continue;
    alerts.push(gatewayAttemptAlert("call", "gateway_call_stuck", attempt, servedAt));
  }
  for (const attempt of fhenixGatewayFeedPacketTxRepo.listStuck(db, { stale_before: staleBefore, limit: 100 })) {
    if (!live(attempt)) continue;
    alerts.push(gatewayAttemptAlert("feed_packet", "gateway_feed_packet_stuck", attempt, servedAt));
  }
  for (const attempt of fhenixGatewayTxRepo.listRecent(db, { status: "failed_terminal", limit: 100 })) {
    if (!live(attempt)) continue;
    alerts.push(gatewayAttemptAlert("call", "gateway_call_terminal_failure", attempt, servedAt));
  }
  for (const attempt of fhenixGatewayFeedPacketTxRepo.listRecent(db, { status: "failed_terminal", limit: 100 })) {
    if (!live(attempt)) continue;
    alerts.push(gatewayAttemptAlert("feed_packet", "gateway_feed_packet_terminal_failure", attempt, servedAt));
  }
  return alerts;
}

function gatewayAttemptAlert(
  target: "call" | "feed_packet",
  kind: string,
  attempt: FhenixGatewayTxAttemptRow | FhenixGatewayFeedPacketTxAttemptRow,
  seenAt: string,
): OperatorAlertInput {
  const isTerminal = attempt.status === "failed_terminal";
  const noun = target === "call" ? "sealed-call" : "feed-packet";
  return alertInput({
    source: "gateway",
    kind,
    key: `gateway:${target}:${kind}:${attempt.attempt_id}`,
    severity: isTerminal ? "critical" : "warning",
    title: isTerminal
      ? `Gateway ${noun} attempt failed terminally`
      : `Gateway ${noun} attempt is stuck`,
    description: isTerminal
      ? `Gateway ${noun} attempt ${attempt.attempt_id} reached failed_terminal.`
      : `Gateway ${noun} attempt ${attempt.attempt_id} has been ${attempt.status} since ${attempt.updated_at}.`,
    seenAt,
    payload: {
      attempt_id: attempt.attempt_id,
      status: attempt.status,
      agent_id: attempt.agent_id,
      chain_id: attempt.chain_id,
      contract_address: attempt.contract_address,
      relayer_address: attempt.relayer_address,
      tx_hash: attempt.tx_hash,
      attempt_count: attempt.attempt_count,
      last_error: attempt.last_error,
      last_rpc_error: attempt.last_rpc_error,
      updated_at: attempt.updated_at,
    },
  });
}

function liveCanaryAlerts(
  liveCanaries: LiveCanaryProvider,
  servedAt: string,
): OperatorAlertInput[] {
  const snapshot = liveCanaries.snapshot();
  return snapshot.checks
    .filter((check) => check.status === "fail")
    .map((check) => alertInput({
      source: "live_canary",
      kind: "live_canary_failed",
      key: `live_canary:${check.name}`,
      severity: "critical",
      title: `Live canary failed: ${check.name}`,
      description: check.error ?? `Live canary ${check.name} is failing.`,
      seenAt: servedAt,
      payload: {
        name: check.name,
        checked_at: check.checked_at,
        latency_ms: check.latency_ms,
        details: check.details,
        error: check.error,
      },
    }));
}

function fhenixLifecycleAlerts(
  db: Database.Database,
  servedAt: string,
  revealGraceSec = DEFAULT_REVEAL_GRACE_SEC,
): OperatorAlertInput[] {
  // Overdue past grace warns; REVEAL_ESCALATE_AFTER_SEC later it's critical.
  // Fires whether or not the fallback worker is enabled.
  const servedMs = Date.parse(servedAt);
  const warnCutoff = isoFromMs(servedMs - Math.max(0, revealGraceSec) * 1_000);
  const escalateCutoffMs =
    servedMs - (Math.max(0, revealGraceSec) + REVEAL_ESCALATE_AFTER_SEC) * 1_000;
  const alerts: OperatorAlertInput[] = [];
  for (const row of fhenixSealedCallsRepo.listMissable(db, warnCutoff, 100)) {
    const escalated = Date.parse(row.reveal_open_at) <= escalateCutoffMs;
    alerts.push(alertInput({
      source: "fhenix_lifecycle",
      kind: "fhenix_reveal_fallback_overdue",
      key: `fhenix_lifecycle:overdue:${row.call_id}`,
      severity: escalated ? "critical" : "warning",
      title: escalated ? "Fhenix fallback reveal escalated" : "Fhenix fallback reveal overdue",
      description: `Call ${row.call_id} passed reveal_open_at ${row.reveal_open_at} and is still unrevealed; the fallback reveal worker keeps retrying (the call is never auto-marked missed).`,
      seenAt: servedAt,
      payload: { ...row, escalated },
    }));
  }
  const terminalRows = db.prepare(
    `SELECT f.call_id, s.agent_id, a.display_slug AS agent_slug,
            f.reveal_status, f.invalid_reason, f.terminal_at, f.reveal_open_at
     FROM fhenix_sealed_calls f
     JOIN submissions s ON s.call_id = f.call_id
     LEFT JOIN agents a ON a.agent_id = s.agent_id
     WHERE f.reveal_status IN ('invalid','missed')
     ORDER BY f.terminal_at DESC
     LIMIT 100`,
  ).all() as Array<{
    call_id: string;
    agent_id: string;
    agent_slug: string | null;
    reveal_status: "invalid" | "missed";
    invalid_reason: string | null;
    terminal_at: string | null;
    reveal_open_at: string;
  }>;
  for (const row of terminalRows) {
    alerts.push(alertInput({
      source: "fhenix_lifecycle",
      kind: `fhenix_reveal_${row.reveal_status}`,
      key: `fhenix_lifecycle:${row.reveal_status}:${row.call_id}`,
      severity: row.reveal_status === "invalid" ? "critical" : "warning",
      title: row.reveal_status === "invalid" ? "Fhenix reveal invalid" : "Fhenix reveal missed",
      description: `Call ${row.call_id} terminalized as ${row.reveal_status}.`,
      seenAt: servedAt,
      payload: row,
    }));
  }
  return alerts;
}

// Minimum staleness before the "no successful tick" alert fires, so a
// single slow tick doesn't page anyone.
const DISCOVERY_STALE_FLOOR_MS = 5 * 60_000;

function polymarketDiscoveryAlerts(
  db: Database.Database,
  servedAt: string,
): OperatorAlertInput[] {
  const alerts: OperatorAlertInput[] = [];
  const health = polymarketDiscoveryRepo.getHealth(db);
  const servedAtMs = Date.parse(servedAt);
  if (health && health.enabled === 1) {
    if (health.balance_status === "warning" || health.balance_status === "critical") {
      alerts.push(alertInput({
        source: "polymarket_discovery",
        kind: "polymarket_discovery_balance_low",
        key: `polymarket_discovery:balance:${health.balance_status}`,
        severity: health.balance_status === "critical" ? "critical" : "warning",
        title: health.balance_status === "critical"
          ? "Polymarket discovery relayer balance below hard stop"
          : "Polymarket discovery relayer balance low",
        description: health.balance_status === "critical"
          ? `Relayer balance ${health.relayer_balance_wei ?? "?"} wei is under the registration hard stop; on-chain market registration is halted.`
          : `Relayer balance ${health.relayer_balance_wei ?? "?"} wei is under the warning reserve.`,
        seenAt: servedAt,
        payload: health,
      }));
    }
    const staleAfterMs = Math.max(
      DISCOVERY_STALE_FLOOR_MS,
      (health.tick_interval_sec ?? 60) * 5 * 1000,
    );
    const lastSuccessMs = health.last_success_at
      ? Date.parse(health.last_success_at)
      : Number.NaN;
    if (!Number.isFinite(lastSuccessMs) || servedAtMs - lastSuccessMs > staleAfterMs) {
      alerts.push(alertInput({
        source: "polymarket_discovery",
        kind: "polymarket_discovery_stale",
        key: "polymarket_discovery:stale",
        severity: "critical",
        title: "Polymarket discovery has no recent successful tick",
        description: health.last_success_at
          ? `Last successful discovery tick was ${health.last_success_at}; last error: ${health.last_error ?? "unknown"}.`
          : `Discovery is enabled but has never completed a successful tick; last error: ${health.last_error ?? "unknown"}.`,
        seenAt: servedAt,
        payload: health,
      }));
    }
    const listedOpen = polymarketDiscoveryRepo.countListedEndingAfter(
      db,
      Math.floor(servedAtMs / 1000),
    );
    if (listedOpen === 0) {
      alerts.push(alertInput({
        source: "polymarket_discovery",
        kind: "polymarket_discovery_no_coverage",
        key: "polymarket_discovery:no_coverage",
        severity: "warning",
        title: "No fresh Polymarket five-minute coverage",
        description:
          "Discovery is enabled but no discovery-listed market has an end time in the future; agents have nothing imminent to call.",
        seenAt: servedAt,
        payload: health,
      }));
    }
  }
  // An unconfirmed registration stays `broadcasting`: no rebroadcast at a fresh nonce (it could
  // stall the shared relayer lane) and no same-nonce replacement yet, so alert on it.
  for (const row of polymarketDiscoveryRepo.listByStatus(db, "broadcasting", 50)) {
    const startedAt = row.broadcast_started_at ?? row.updated_at;
    const stuckMs = Date.parse(servedAt) - Date.parse(startedAt);
    if (!Number.isFinite(stuckMs) || stuckMs < STUCK_REGISTRATION_WARN_MS) continue;
    const stuckMin = Math.floor(stuckMs / 60_000);
    alerts.push(alertInput({
      source: "polymarket_discovery",
      kind: "polymarket_discovery_registration_stuck",
      key: `polymarket_discovery:stuck:${row.condition_id}`,
      severity: stuckMs >= STUCK_REGISTRATION_CRITICAL_MS ? "critical" : "warning",
      title: "Polymarket discovery registration stuck unconfirmed",
      description:
        `Registration for ${row.condition_id} has been broadcasting for ${stuckMin} min ` +
        `without a receipt (tx=${row.tx_hash ?? "unknown"}). Murmur will not rebroadcast: a ` +
        `replacement takes the next nonce on the shared relayer lane and can stall unrelated ` +
        `writes. Resolve by replacing the transaction at its ORIGINAL nonce with a fee bump.`,
      seenAt: servedAt,
      payload: row,
    }));
  }
  for (const row of polymarketDiscoveryRepo.listByStatus(db, "failed", 50)) {
    alerts.push(alertInput({
      source: "polymarket_discovery",
      kind: "polymarket_discovery_registration_failed",
      key: `polymarket_discovery:failed:${row.condition_id}`,
      severity: "critical",
      title: "Polymarket discovery registration failed terminally",
      description: `Registration for ${row.condition_id} failed after ${row.attempt_count} attempt(s): ${row.last_error ?? "unknown"}.`,
      seenAt: servedAt,
      payload: row,
    }));
  }
  return alerts;
}

function feedSlaAlerts(db: Database.Database, servedAt: string): OperatorAlertInput[] {
  return feedSlaIncidentsRepo
    .list(db, { status: "open", limit: 200 })
    .map((incident) => alertInput({
      source: "feed_sla",
      kind: "feed_sla_missed_packet",
      key: `feed_sla:missed_packet:${incident.incident_id}`,
      severity: incident.slash_action === "stake" ? "critical" : "warning",
      title: "Feed SLA missed packet",
      description: `Feed ${incident.feed_id} missed expected sequence ${incident.expected_sequence}.`,
      seenAt: servedAt,
      payload: feedSlaIncidentAlertPayload(incident),
    }));
}

function identityAlerts(
  db: Database.Database,
  servedAt: string,
  dueSoonHours = DEFAULT_IDENTITY_DUE_SOON_HOURS,
): OperatorAlertInput[] {
  const dueSoonAt = isoFromMs(Date.parse(servedAt) + Math.max(1, dueSoonHours) * 60 * 60 * 1_000);
  const rows = db.prepare(
    `SELECT c.agent_id, c.account_id, a.display_slug AS agent_slug,
            c.wallet_address, c.chain_id, c.wallet_kind, c.provider,
            c.created_at, c.last_attested_at, c.reattestation_due_at,
            (
              SELECT COUNT(*) FROM agent_runtime_keys k
              WHERE k.agent_id = c.agent_id
                AND k.revoked_at IS NULL
                AND (k.expires_at IS NULL OR k.expires_at > @served_at)
            ) AS active_runtime_keys
     FROM agent_controller_wallets c
     LEFT JOIN agents a ON a.agent_id = c.agent_id
     WHERE c.reattestation_due_at IS NULL
        OR julianday(c.reattestation_due_at) IS NULL
        OR c.reattestation_due_at <= @due_soon_at
     ORDER BY c.reattestation_due_at ASC
     LIMIT 200`,
  ).all({ served_at: servedAt, due_soon_at: dueSoonAt }) as Array<{
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
    active_runtime_keys: number;
  }>;
  const alerts: OperatorAlertInput[] = [];
  const checkedAt = new Date(servedAt);
  for (const row of rows) {
    const health = controllerWalletReattestationHealth(row, {
      checkedAt,
      dueSoonAt,
    });
    if (health.status === "current") continue;
    const overdue = health.status === "overdue";
    alerts.push(alertInput({
      source: "identity",
      kind: overdue ? "controller_reattestation_overdue" : "controller_reattestation_due_soon",
      key: `identity:controller:${overdue ? "overdue" : "due_soon"}:${row.agent_id}`,
      severity: overdue ? "critical" : "warning",
      title: overdue
        ? "Controller Wallet re-attestation overdue"
        : "Controller Wallet re-attestation due soon",
      description: overdue
        ? `Agent ${row.agent_slug ?? row.agent_id} has an overdue Controller Wallet re-attestation.`
        : `Agent ${row.agent_slug ?? row.agent_id} must re-attest by ${health.reattestation_due_at}.`,
      seenAt: servedAt,
      payload: {
        ...row,
        last_attested_at: health.last_attested_at,
        reattestation_due_at: health.reattestation_due_at,
        reattestation_status: health.status,
        reattestation_overdue: health.reattestation_overdue,
        reattestation_due_soon: health.reattestation_due_soon,
      },
    }));
  }
  return alerts;
}

function alertInput(args: {
  source: string;
  kind: string;
  key: string;
  severity: OperatorAlertSeverity;
  title: string;
  description: string;
  seenAt: string;
  payload: unknown;
}): OperatorAlertInput {
  return {
    alert_key: args.key,
    source: args.source,
    kind: args.kind,
    severity: args.severity,
    title: args.title,
    description: args.description,
    payload_json: encodeOperatorAlertPayload(args.payload),
    seen_at: args.seenAt,
  };
}
