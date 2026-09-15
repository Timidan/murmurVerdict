import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import {
  operatorAlertsRepo,
  type OperatorAlertRow,
} from "./repos/operator-alerts-repo.js";
import { isoFromMs, nowIso } from "./time.js";
import { publicOperatorAlert } from "./operator-alert-presenters.js";
import {
  deliverOutboundJson,
  type OutboundJsonDeliveryFetch,
  type OutboundJsonDeliveryTimers,
} from "./outbound-json-delivery.js";

const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;

export interface OperatorAlertSinkConfig {
  webhookUrl?: string;
  secret?: string;
  timeoutMs?: number;
}

export interface OperatorAlertDeliveryResult {
  served_at: string;
  sink_configured: boolean;
  attempted: number;
  delivered: number;
  failed: number;
}

export type OperatorAlertDeliveryFetch = OutboundJsonDeliveryFetch;
export type OperatorAlertDeliveryTimers = OutboundJsonDeliveryTimers;

export interface OperatorAlertDeliveryInput {
  db: Database.Database;
  sink?: OperatorAlertSinkConfig;
  deliveredAt: Date;
  fetch?: OperatorAlertDeliveryFetch;
  timers?: OperatorAlertDeliveryTimers;
}

export class OperatorAlertSinkConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "OperatorAlertSinkConfigError";
    this.key = key;
  }
}

export async function deliverOperatorAlerts(
  input: OperatorAlertDeliveryInput,
): Promise<OperatorAlertDeliveryResult> {
  const servedAt = nowIso(input.deliveredAt);
  const webhookUrl = input.sink?.webhookUrl?.trim();
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

  // An empty HMAC secret makes signatures forgeable, so a webhook requires one.
  if (webhookUrl && !input.sink?.secret?.trim()) {
    throw new Error(
      "MURMUR_OPERATOR_ALERT_SECRET is required whenever an operator alert " +
        "webhook URL is configured — signing with an empty key means anyone " +
        "can forge alerts.",
    );
  }

  const rows = operatorAlertsRepo.pendingDelivery(input.db, servedAt, 50);
  for (const row of rows) {
    attempted++;
    const result = await deliverOne(row, {
      webhookUrl,
      secret: input.sink?.secret ?? "",
      timeoutMs: input.sink?.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS,
      deliveredAt: servedAt,
      fetch: input.fetch,
      timers: input.timers,
    });
    if (result.ok) {
      delivered++;
      operatorAlertsRepo.markDelivered(input.db, {
        alert_id: row.alert_id,
        delivered_at: servedAt,
        status_code: result.status,
      });
    } else {
      failed++;
      operatorAlertsRepo.markDeliveryFailed(input.db, {
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

export function loadOperatorAlertSinkConfig(
  env: NodeJS.ProcessEnv = process.env,
): OperatorAlertSinkConfig {
  return {
    webhookUrl: env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL,
    secret: env.MURMUR_OPERATOR_ALERT_SECRET,
    timeoutMs: numberEnv(env, "MURMUR_OPERATOR_ALERT_TIMEOUT_MS", DEFAULT_DELIVERY_TIMEOUT_MS),
  };
}

export function operatorAlertSinkFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OperatorAlertSinkConfig {
  return loadOperatorAlertSinkConfig(env);
}

async function deliverOne(
  row: OperatorAlertRow,
  opts: {
    webhookUrl: string;
    secret: string;
    timeoutMs: number;
    deliveredAt: string;
    fetch?: OperatorAlertDeliveryFetch;
    timers?: OperatorAlertDeliveryTimers;
  },
): Promise<{ ok: true; status: number } | { ok: false; status: number | null; error: string }> {
  const body = JSON.stringify({
    schema_version: 1,
    delivered_at: opts.deliveredAt,
    alert: publicOperatorAlert(row),
  });
  const signature = createHmac("sha256", opts.secret).update(body).digest("hex");
  const delivery = await deliverOutboundJson({
    url: opts.webhookUrl,
    body,
    headers: {
      "User-Agent": "murmur-operator-alert/0.1",
      "X-Murmur-Alert-Id": row.alert_id,
      "X-Murmur-Alert-Kind": row.kind,
      "X-Murmur-Signature": `sha256=${signature}`,
    },
    timeoutMs: Math.max(1_000, opts.timeoutMs),
    fetch: opts.fetch,
    timers: opts.timers,
  });
  if (delivery.ok) {
    return { ok: true, status: delivery.status };
  }
  if (delivery.status !== null) {
    return {
      ok: false,
      status: delivery.status,
      error: `webhook status ${delivery.status}`,
    };
  }
  return {
    ok: false,
    status: null,
    error: delivery.error,
  };
}

function nextDeliveryAt(attempts: number, fromIso: string): string {
  const baseMs = Date.parse(fromIso);
  const delayMs = Math.min(15 * 60_000, Math.max(30_000, 30_000 * 2 ** Math.max(0, attempts - 1)));
  return isoFromMs(baseMs + delayMs);
}

function numberEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return value;
  throw new OperatorAlertSinkConfigError(
    name,
    "must be a positive number of milliseconds",
  );
}
