import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { prep } from "../db-statements.js";

export type OperatorAlertSeverity = "info" | "warning" | "critical";
export type OperatorAlertStatus = "open" | "resolved";
export type OperatorAlertDeliveryStatus = "pending" | "delivered" | "failed";
export type OperatorAlertIdAdapter = () => string;

export interface OperatorAlertRow {
  alert_id: string;
  alert_key: string;
  source: string;
  kind: string;
  severity: OperatorAlertSeverity;
  status: OperatorAlertStatus;
  title: string;
  description: string;
  payload_json: string;
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
  created_at: string;
  updated_at: string;
}

export interface OperatorAlertInput {
  alert_id?: string;
  alert_key: string;
  source: string;
  kind: string;
  severity: OperatorAlertSeverity;
  title: string;
  description: string;
  payload_json: string;
  seen_at: string;
}

export const operatorAlertsRepo = {
  upsertOpen(
    db: Database.Database,
    input: OperatorAlertInput,
    adapters: { newAlertId?: OperatorAlertIdAdapter } = {},
  ): OperatorAlertRow {
    const existing = this.byKey(db, input.alert_key);
    if (!existing) {
      const insertInput = {
        ...input,
        alert_id: input.alert_id ?? (adapters.newAlertId ?? randomUUID)(),
      };
      prep(
        db,
        `INSERT INTO operator_alerts
         (alert_id, alert_key, source, kind, severity, status, title, description,
          payload_json, first_seen_at, last_seen_at, occurrence_count, resolved_at,
          delivery_status, delivery_attempts, next_delivery_at, last_delivery_at,
          last_delivery_status, last_delivery_error, created_at, updated_at)
         VALUES
         (@alert_id, @alert_key, @source, @kind, @severity, 'open', @title, @description,
          @payload_json, @seen_at, @seen_at, 1, NULL,
          'pending', 0, @seen_at, NULL, NULL, NULL, @seen_at, @seen_at)`,
      ).run(insertInput);
      return this.byKeyOrThrow(db, input.alert_key);
    }

    prep(
      db,
      `UPDATE operator_alerts
       SET source = @source,
           kind = @kind,
           severity = @severity,
           status = 'open',
           title = @title,
           description = @description,
           payload_json = @payload_json,
           last_seen_at = @seen_at,
           occurrence_count = occurrence_count + 1,
           resolved_at = NULL,
           delivery_status = CASE
             WHEN status = 'resolved' THEN 'pending'
             ELSE delivery_status
           END,
           next_delivery_at = CASE
             WHEN status = 'resolved' THEN @seen_at
             ELSE next_delivery_at
           END,
           updated_at = @seen_at
       WHERE alert_key = @alert_key`,
    ).run(input);
    return this.byKeyOrThrow(db, input.alert_key);
  },

  byKey(db: Database.Database, alert_key: string): OperatorAlertRow | null {
    return (
      prep(
        db,
        "SELECT * FROM operator_alerts WHERE alert_key = ? LIMIT 1",
      ).get(alert_key) as OperatorAlertRow | undefined
    ) ?? null;
  },

  byKeyOrThrow(db: Database.Database, alert_key: string): OperatorAlertRow {
    const row = this.byKey(db, alert_key);
    if (!row) throw new Error(`operator alert missing after upsert: ${alert_key}`);
    return row;
  },

  resolveSourceExcept(
    db: Database.Database,
    source: string,
    activeKeys: string[],
    resolved_at: string,
  ): number {
    let sql = `UPDATE operator_alerts
       SET status = 'resolved',
           resolved_at = ?,
           updated_at = ?
       WHERE source = ?
         AND status = 'open'`;
    const params: unknown[] = [resolved_at, resolved_at, source];
    if (activeKeys.length > 0) {
      sql += ` AND alert_key NOT IN (${activeKeys.map(() => "?").join(",")})`;
      params.push(...activeKeys);
    }
    const info = prep(db, sql).run(...params);
    return info.changes;
  },

  list(
    db: Database.Database,
    opts: {
      status?: OperatorAlertStatus;
      source?: string;
      delivery_status?: OperatorAlertDeliveryStatus;
      limit?: number;
    } = {},
  ): OperatorAlertRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      clauses.push("status = ?");
      params.push(opts.status);
    }
    if (opts.source) {
      clauses.push("source = ?");
      params.push(opts.source);
    }
    if (opts.delivery_status) {
      clauses.push("delivery_status = ?");
      params.push(opts.delivery_status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    return prep(
      db,
      `SELECT * FROM operator_alerts
       ${where}
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
         last_seen_at DESC
       LIMIT ?`,
    ).all(...params, limit) as OperatorAlertRow[];
  },

  pendingDelivery(
    db: Database.Database,
    now_iso: string,
    limit = 50,
  ): OperatorAlertRow[] {
    return prep(
      db,
      `SELECT * FROM operator_alerts
       WHERE status = 'open'
         AND delivery_status IN ('pending','failed')
         AND (next_delivery_at IS NULL OR next_delivery_at <= ?)
       ORDER BY first_seen_at ASC
       LIMIT ?`,
    ).all(now_iso, Math.max(1, Math.min(100, Math.floor(limit)))) as OperatorAlertRow[];
  },

  markDelivered(
    db: Database.Database,
    input: {
      alert_id: string;
      delivered_at: string;
      status_code: number;
    },
  ): void {
    prep(
      db,
      `UPDATE operator_alerts
       SET delivery_status = 'delivered',
           delivery_attempts = delivery_attempts + 1,
           next_delivery_at = NULL,
           last_delivery_at = @delivered_at,
           last_delivery_status = @status_code,
           last_delivery_error = NULL,
           updated_at = @delivered_at
       WHERE alert_id = @alert_id`,
    ).run(input);
  },

  markDeliveryFailed(
    db: Database.Database,
    input: {
      alert_id: string;
      failed_at: string;
      status_code: number | null;
      error: string;
      next_delivery_at: string;
    },
  ): void {
    prep(
      db,
      `UPDATE operator_alerts
       SET delivery_status = 'failed',
           delivery_attempts = delivery_attempts + 1,
           next_delivery_at = @next_delivery_at,
           last_delivery_at = @failed_at,
           last_delivery_status = @status_code,
           last_delivery_error = @error,
           updated_at = @failed_at
       WHERE alert_id = @alert_id`,
    ).run(input);
  },

  counts(
    db: Database.Database,
  ): Array<{
    status: OperatorAlertStatus;
    severity: OperatorAlertSeverity;
    count: number;
  }> {
    return prep(
      db,
      `SELECT status, severity, COUNT(*) AS count
       FROM operator_alerts
       GROUP BY status, severity`,
    ).all() as Array<{
      status: OperatorAlertStatus;
      severity: OperatorAlertSeverity;
      count: number;
    }>;
  },
};
