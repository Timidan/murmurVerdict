import type Database from "better-sqlite3";
import {
  operatorAlertsRepo,
  type OperatorAlertDeliveryStatus,
  type OperatorAlertRow,
  type OperatorAlertSeverity,
  type OperatorAlertStatus,
} from "./repos/operator-alerts-repo.js";
import { nowIso } from "./time.js";
import type { OperatorAlertSinkConfig } from "./operator-alert-delivery.js";
import { decodeOperatorAlertPayload } from "./operator-alert-payload.js";

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

export interface OperatorAlertsSnapshot {
  served_at: string;
  sink_configured: boolean;
  counts: AlertCountSummary;
  alerts: PublicOperatorAlert[];
}

export function operatorAlertsSnapshot(
  db: Database.Database,
  opts: {
    servedAt: Date;
    status?: OperatorAlertStatus;
    source?: string;
    delivery_status?: OperatorAlertDeliveryStatus;
    limit?: number;
    sink?: OperatorAlertSinkConfig;
  },
): OperatorAlertsSnapshot {
  return {
    served_at: nowIso(opts.servedAt),
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
    payload: decodeOperatorAlertPayload(row.payload_json),
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

export function alertCountSummary(db: Database.Database): AlertCountSummary {
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
