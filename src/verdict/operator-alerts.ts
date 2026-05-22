import { createHmac, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import {
  feedSlaIncidentsRepo,
  fhenixGatewayFeedPacketTxRepo,
  fhenixGatewayTxRepo,
  fhenixSealedCallsRepo,
  operatorAlertsRepo,
  type FhenixGatewayFeedPacketTxAttemptRow,
  type FhenixGatewayTxAttemptRow,
  type OperatorAlertInput,
  type OperatorAlertRow,
  type OperatorAlertStatus,
  type OperatorAlertDeliveryStatus,
  type OperatorAlertSeverity,
} from "./db.js";
import { isoFromMs, nowIso } from "./time.js";

const DEFAULT_STUCK_AFTER_MS = 10 * 60_000;
const DEFAULT_REVEAL_GRACE_SEC = 60 * 60;
const DEFAULT_IDENTITY_DUE_SOON_HOURS = 24;
const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;

export interface OperatorAlertSinkConfig {
  webhookUrl?: string;
  secret?: string;
  timeoutMs?: number;
}

export interface OperatorAlertScanOptions {
  db: Database.Database;
  now?: () => Date;
  liveCanaries?: LiveCanaryProvider | null;
  gatewayStuckAfterMs?: number;
  fhenixRevealGraceSec?: number;
  identityDueSoonHours?: number;
}

export interface OperatorAlertScanResult {
  served_at: string;
  sources: Array<{
    source: string;
    active_alerts: number;
    resolved_alerts: number;
  }>;
  opened_or_seen: number;
  open_counts: AlertCountSummary;
}

export interface OperatorAlertDeliveryResult {
  served_at: string;
  sink_configured: boolean;
  attempted: number;
  delivered: number;
  failed: number;
}

export interface OperatorAlertsSnapshot {
  served_at: string;
  sink_configured: boolean;
  counts: AlertCountSummary;
  alerts: PublicOperatorAlert[];
}

export interface OperatorAlertTickResult {
  scan: OperatorAlertScanResult;
  delivery: OperatorAlertDeliveryResult;
  snapshot: OperatorAlertsSnapshot;
}

export interface PublicOperatorAlert {
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

export interface AlertCountSummary {
  open: {
    total: number;
    critical: number;
    warning: number;
    info: number;
  };
  resolved: {
    total: number;
    critical: number;
    warning: number;
    info: number;
  };
}

export function runOperatorAlertTick(
  opts: OperatorAlertScanOptions & { sink?: OperatorAlertSinkConfig },
): Promise<OperatorAlertTickResult> {
  const scan = runOperatorAlertScan(opts);
  return deliverOperatorAlerts(opts.db, opts.sink, opts.now).then((delivery) => ({
    scan,
    delivery,
    snapshot: operatorAlertsSnapshot(opts.db, {
      status: "open",
      limit: 100,
      sink: opts.sink,
      now: opts.now,
    }),
  }));
}

export function runOperatorAlertScan(opts: OperatorAlertScanOptions): OperatorAlertScanResult {
  const now = opts.now ?? (() => new Date());
  const servedAt = nowIso(now());
  const sources: OperatorAlertScanResult["sources"] = [];
  let openedOrSeen = 0;

  const scanSource = (source: string, alerts: OperatorAlertInput[]) => {
    const keys = alerts.map((alert) => alert.alert_key);
    for (const alert of alerts) {
      operatorAlertsRepo.upsertOpen(opts.db, alert);
      openedOrSeen++;
    }
    const resolved = operatorAlertsRepo.resolveSourceExcept(opts.db, source, keys, servedAt);
    sources.push({ source, active_alerts: alerts.length, resolved_alerts: resolved });
  };

  scanSource("gateway", gatewayAlerts(opts.db, servedAt, opts.gatewayStuckAfterMs));
  scanSource("fhenix_lifecycle", fhenixLifecycleAlerts(
    opts.db,
    servedAt,
    opts.fhenixRevealGraceSec,
  ));
  scanSource("feed_sla", feedSlaAlerts(opts.db, servedAt));
  scanSource("identity", identityAlerts(
    opts.db,
    servedAt,
    opts.identityDueSoonHours,
  ));
  if (opts.liveCanaries) {
    scanSource("live_canary", liveCanaryAlerts(opts.liveCanaries, servedAt));
  }

  return {
    served_at: servedAt,
    sources,
    opened_or_seen: openedOrSeen,
    open_counts: alertCountSummary(opts.db),
  };
}

export async function deliverOperatorAlerts(
  db: Database.Database,
  sink: OperatorAlertSinkConfig | undefined,
  now: (() => Date) | undefined = undefined,
): Promise<OperatorAlertDeliveryResult> {
  const servedAt = nowIso((now ?? (() => new Date()))());
  const webhookUrl = sink?.webhookUrl?.trim();
  if (!webhookUrl) {
    return {
      served_at: servedAt,
      sink_configured: false,
      attempted: 0,
      delivered: 0,
      failed: 0,
    };
  }

  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  const rows = operatorAlertsRepo.pendingDelivery(db, servedAt, 50);
  for (const row of rows) {
    attempted++;
    const result = await deliverOne(row, {
      webhookUrl,
      secret: sink?.secret ?? "",
      timeoutMs: sink?.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS,
      deliveredAt: servedAt,
    });
    if (result.ok) {
      delivered++;
      operatorAlertsRepo.markDelivered(db, {
        alert_id: row.alert_id,
        delivered_at: servedAt,
        status_code: result.status,
      });
    } else {
      failed++;
      operatorAlertsRepo.markDeliveryFailed(db, {
        alert_id: row.alert_id,
        failed_at: servedAt,
        status_code: result.status,
        error: result.error.slice(0, 500),
        next_delivery_at: nextDeliveryAt(row.delivery_attempts + 1, servedAt),
      });
    }
  }

  return {
    served_at: servedAt,
    sink_configured: true,
    attempted,
    delivered,
    failed,
  };
}

export function operatorAlertsSnapshot(
  db: Database.Database,
  opts: {
    status?: OperatorAlertStatus;
    source?: string;
    delivery_status?: OperatorAlertDeliveryStatus;
    limit?: number;
    sink?: OperatorAlertSinkConfig;
    now?: () => Date;
  } = {},
): OperatorAlertsSnapshot {
  const now = opts.now ?? (() => new Date());
  return {
    served_at: nowIso(now()),
    sink_configured: Boolean(opts.sink?.webhookUrl?.trim()),
    counts: alertCountSummary(db),
    alerts: operatorAlertsRepo
      .list(db, {
        status: opts.status,
        source: opts.source,
        delivery_status: opts.delivery_status,
        limit: opts.limit,
      })
      .map(publicOperatorAlert),
  };
}

export function operatorAlertSinkFromEnv(): OperatorAlertSinkConfig {
  return {
    webhookUrl: process.env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL,
    secret: process.env.MURMUR_OPERATOR_ALERT_SECRET,
    timeoutMs: numberEnv("MURMUR_OPERATOR_ALERT_TIMEOUT_MS", DEFAULT_DELIVERY_TIMEOUT_MS),
  };
}

export function publicOperatorAlert(row: OperatorAlertRow): PublicOperatorAlert {
  return {
    alert_id: row.alert_id,
    alert_key: row.alert_key,
    source: row.source,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    payload: parseJson(row.payload_json),
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    occurrence_count: row.occurrence_count,
    resolved_at: row.resolved_at,
    delivery_status: row.delivery_status,
    delivery_attempts: row.delivery_attempts,
    next_delivery_at: row.next_delivery_at,
    last_delivery_at: row.last_delivery_at,
    last_delivery_status: row.last_delivery_status,
    last_delivery_error: row.last_delivery_error,
  };
}

function gatewayAlerts(
  db: Database.Database,
  servedAt: string,
  stuckAfterMs = DEFAULT_STUCK_AFTER_MS,
): OperatorAlertInput[] {
  const staleBefore = isoFromMs(Date.parse(servedAt) - Math.max(60_000, stuckAfterMs));
  const alerts: OperatorAlertInput[] = [];
  for (const attempt of fhenixGatewayTxRepo.listStuck(db, { stale_before: staleBefore, limit: 100 })) {
    alerts.push(gatewayAttemptAlert("call", "gateway_call_stuck", attempt, servedAt));
  }
  for (const attempt of fhenixGatewayFeedPacketTxRepo.listStuck(db, { stale_before: staleBefore, limit: 100 })) {
    alerts.push(gatewayAttemptAlert("feed_packet", "gateway_feed_packet_stuck", attempt, servedAt));
  }
  for (const attempt of fhenixGatewayTxRepo.listRecent(db, { status: "failed_terminal", limit: 100 })) {
    alerts.push(gatewayAttemptAlert("call", "gateway_call_terminal_failure", attempt, servedAt));
  }
  for (const attempt of fhenixGatewayFeedPacketTxRepo.listRecent(db, { status: "failed_terminal", limit: 100 })) {
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
  const cutoff = isoFromMs(Date.parse(servedAt) - Math.max(0, revealGraceSec) * 1_000);
  const alerts: OperatorAlertInput[] = [];
  for (const row of fhenixSealedCallsRepo.listMissable(db, cutoff, 100)) {
    alerts.push(alertInput({
      source: "fhenix_lifecycle",
      kind: "fhenix_reveal_overdue",
      key: `fhenix_lifecycle:overdue:${row.call_id}`,
      severity: "critical",
      title: "Fhenix reveal overdue",
      description: `Call ${row.call_id} passed reveal_open_at ${row.reveal_open_at} without a reveal.`,
      seenAt: servedAt,
      payload: row,
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
      payload: publicIncidentPayload(incident),
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
            c.last_attested_at, c.reattestation_due_at,
            (
              SELECT COUNT(*) FROM agent_runtime_keys k
              WHERE k.agent_id = c.agent_id
                AND k.revoked_at IS NULL
                AND (k.expires_at IS NULL OR k.expires_at > @served_at)
            ) AS active_runtime_keys
     FROM agent_controller_wallets c
     LEFT JOIN agents a ON a.agent_id = c.agent_id
     WHERE c.reattestation_due_at IS NULL
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
    last_attested_at: string | null;
    reattestation_due_at: string | null;
    active_runtime_keys: number;
  }>;
  return rows.map((row) => {
    const overdue = !row.reattestation_due_at || row.reattestation_due_at <= servedAt;
    return alertInput({
      source: "identity",
      kind: overdue ? "controller_reattestation_overdue" : "controller_reattestation_due_soon",
      key: `identity:controller:${overdue ? "overdue" : "due_soon"}:${row.agent_id}`,
      severity: overdue ? "critical" : "warning",
      title: overdue
        ? "Controller Wallet re-attestation overdue"
        : "Controller Wallet re-attestation due soon",
      description: overdue
        ? `Agent ${row.agent_slug ?? row.agent_id} has an overdue Controller Wallet re-attestation.`
        : `Agent ${row.agent_slug ?? row.agent_id} must re-attest by ${row.reattestation_due_at}.`,
      seenAt: servedAt,
      payload: row,
    });
  });
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
    alert_id: randomUUID(),
    alert_key: args.key,
    source: args.source,
    kind: args.kind,
    severity: args.severity,
    title: args.title,
    description: args.description,
    payload_json: JSON.stringify(args.payload),
    seen_at: args.seenAt,
  };
}

async function deliverOne(
  row: OperatorAlertRow,
  opts: {
    webhookUrl: string;
    secret: string;
    timeoutMs: number;
    deliveredAt: string;
  },
): Promise<{ ok: true; status: number } | { ok: false; status: number | null; error: string }> {
  const body = JSON.stringify({
    schema_version: 1,
    delivered_at: opts.deliveredAt,
    alert: publicOperatorAlert(row),
  });
  const signature = createHmac("sha256", opts.secret).update(body).digest("hex");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1_000, opts.timeoutMs));
  try {
    const res = await fetch(opts.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "murmur-operator-alert/0.1",
        "X-Murmur-Alert-Id": row.alert_id,
        "X-Murmur-Alert-Kind": row.kind,
        "X-Murmur-Signature": `sha256=${signature}`,
      },
      body,
      signal: ac.signal,
      redirect: "error",
    });
    await res.text().catch(() => "");
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `webhook status ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function nextDeliveryAt(attempts: number, fromIso: string): string {
  const baseMs = Date.parse(fromIso);
  const delayMs = Math.min(15 * 60_000, Math.max(30_000, 30_000 * 2 ** Math.max(0, attempts - 1)));
  return isoFromMs(baseMs + delayMs);
}

function alertCountSummary(db: Database.Database): AlertCountSummary {
  const summary: AlertCountSummary = {
    open: { total: 0, critical: 0, warning: 0, info: 0 },
    resolved: { total: 0, critical: 0, warning: 0, info: 0 },
  };
  for (const row of operatorAlertsRepo.counts(db)) {
    summary[row.status][row.severity] = row.count;
    summary[row.status].total += row.count;
  }
  return summary;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function publicIncidentPayload(row: {
  incident_id: string;
  feed_id: string;
  agent_id: string;
  incident_kind: string;
  expected_sequence: number;
  expected_delivery_deadline_at: string;
  detected_at: string;
  grace_seconds: number;
  refund_action: string;
  slash_action: string;
  details_json: string;
}): unknown {
  return {
    incident_id: row.incident_id,
    feed_id: row.feed_id,
    agent_id: row.agent_id,
    incident_kind: row.incident_kind,
    expected_sequence: row.expected_sequence,
    expected_delivery_deadline_at: row.expected_delivery_deadline_at,
    detected_at: row.detected_at,
    grace_seconds: row.grace_seconds,
    refund_action: row.refund_action,
    slash_action: row.slash_action,
    details: parseJson(row.details_json),
  };
}

function numberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
