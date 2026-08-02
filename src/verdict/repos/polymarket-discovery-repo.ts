import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

export const POLYMARKET_DISCOVERY_STATUSES = [
  "draft",
  "broadcasting",
  "confirmed",
  "listed",
  "frozen",
  "failed",
] as const;
export type PolymarketDiscoveryStatus =
  (typeof POLYMARKET_DISCOVERY_STATUSES)[number];

export interface PolymarketDiscoveryStateRow {
  condition_id: string;
  question: string | null;
  slug: string | null;
  end_date_epoch_s: number;
  status: PolymarketDiscoveryStatus;
  attempt_count: number;
  tx_hash: string | null;
  gas_used: string | null;
  effective_gas_price_wei: string | null;
  last_error: string | null;
  registered_onchain_at: string | null;
  listed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PolymarketDiscoveryHealthRow {
  id: 1;
  enabled: 0 | 1;
  tick_interval_sec: number | null;
  last_tick_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  relayer_balance_wei: string | null;
  balance_status: "ok" | "warning" | "critical" | null;
  updated_at: string;
}

export const polymarketDiscoveryRepo = {
  get(
    db: Database.Database,
    condition_id: string,
  ): PolymarketDiscoveryStateRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM polymarket_discovery_state WHERE condition_id = ?`,
      ).get(condition_id) as PolymarketDiscoveryStateRow | undefined) ?? null
    );
  },

  /**
   * Create the ledger row (status 'draft') or refresh its Gamma metadata.
   * Terminal / in-flight statuses are preserved on conflict — re-discovering
   * a window we already acted on must never rewind the state machine.
   */
  upsertDraft(
    db: Database.Database,
    row: {
      condition_id: string;
      question: string | null;
      slug: string | null;
      end_date_epoch_s: number;
      now_iso: string;
    },
  ): void {
    prep(
      db,
      `INSERT INTO polymarket_discovery_state (
         condition_id, question, slug, end_date_epoch_s, status,
         attempt_count, created_at, updated_at
       ) VALUES (
         @condition_id, @question, @slug, @end_date_epoch_s, 'draft',
         0, @now_iso, @now_iso
       )
       ON CONFLICT(condition_id) DO UPDATE SET
         question         = excluded.question,
         slug             = excluded.slug,
         end_date_epoch_s = excluded.end_date_epoch_s,
         updated_at       = excluded.updated_at`,
    ).run(row);
  },

  markBroadcasting(
    db: Database.Database,
    args: { condition_id: string; now_iso: string },
  ): void {
    prep(
      db,
      `UPDATE polymarket_discovery_state
          SET status = 'broadcasting',
              attempt_count = attempt_count + 1,
              updated_at = @now_iso
        WHERE condition_id = @condition_id`,
    ).run(args);
  },

  /** Persist the tx hash the moment it exists, before the receipt wait. */
  recordBroadcastHash(
    db: Database.Database,
    args: { condition_id: string; tx_hash: string; now_iso: string },
  ): void {
    prep(
      db,
      `UPDATE polymarket_discovery_state
          SET tx_hash = @tx_hash, updated_at = @now_iso
        WHERE condition_id = @condition_id`,
    ).run(args);
  },

  markConfirmed(
    db: Database.Database,
    args: {
      condition_id: string;
      tx_hash: string | null;
      gas_used: string | null;
      effective_gas_price_wei: string | null;
      now_iso: string;
    },
  ): void {
    prep(
      db,
      `UPDATE polymarket_discovery_state
          SET status = 'confirmed',
              tx_hash = COALESCE(@tx_hash, tx_hash),
              gas_used = @gas_used,
              effective_gas_price_wei = @effective_gas_price_wei,
              registered_onchain_at = @now_iso,
              last_error = NULL,
              updated_at = @now_iso
        WHERE condition_id = @condition_id`,
    ).run(args);
  },

  markListed(
    db: Database.Database,
    args: { condition_id: string; now_iso: string },
  ): void {
    prep(
      db,
      `UPDATE polymarket_discovery_state
          SET status = 'listed',
              listed_at = @now_iso,
              last_error = NULL,
              updated_at = @now_iso
        WHERE condition_id = @condition_id`,
    ).run(args);
  },

  markFrozen(
    db: Database.Database,
    args: {
      condition_id: string;
      reason: string | null;
      /** Gas telemetry when the freeze settles a reverted receipt. */
      gas_used?: string | null;
      effective_gas_price_wei?: string | null;
      now_iso: string;
    },
  ): void {
    prep(
      db,
      `UPDATE polymarket_discovery_state
          SET status = 'frozen',
              last_error = @reason,
              gas_used = COALESCE(@gas_used, gas_used),
              effective_gas_price_wei = COALESCE(@effective_gas_price_wei, effective_gas_price_wei),
              updated_at = @now_iso
        WHERE condition_id = @condition_id`,
    ).run({
      ...args,
      gas_used: args.gas_used ?? null,
      effective_gas_price_wei: args.effective_gas_price_wei ?? null,
    });
  },

  /** Terminal registration failure — kept for the operator-alert scanner. */
  markFailed(
    db: Database.Database,
    args: {
      condition_id: string;
      error: string;
      /** Gas telemetry when the failure is a reverted receipt. */
      gas_used?: string | null;
      effective_gas_price_wei?: string | null;
      now_iso: string;
    },
  ): void {
    prep(
      db,
      `UPDATE polymarket_discovery_state
          SET status = 'failed',
              last_error = @error,
              gas_used = COALESCE(@gas_used, gas_used),
              effective_gas_price_wei = COALESCE(@effective_gas_price_wei, effective_gas_price_wei),
              updated_at = @now_iso
        WHERE condition_id = @condition_id`,
    ).run({
      ...args,
      gas_used: args.gas_used ?? null,
      effective_gas_price_wei: args.effective_gas_price_wei ?? null,
    });
  },

  /** Retryable failure — status stays where it is, error recorded. */
  recordError(
    db: Database.Database,
    args: { condition_id: string; error: string; now_iso: string },
  ): void {
    prep(
      db,
      `UPDATE polymarket_discovery_state
          SET last_error = @error, updated_at = @now_iso
        WHERE condition_id = @condition_id`,
    ).run(args);
  },

  listByStatus(
    db: Database.Database,
    status: PolymarketDiscoveryStatus,
    limit: number,
  ): PolymarketDiscoveryStateRow[] {
    return prep(
      db,
      `SELECT * FROM polymarket_discovery_state
        WHERE status = ?
        ORDER BY end_date_epoch_s ASC
        LIMIT ?`,
    ).all(status, limit) as PolymarketDiscoveryStateRow[];
  },

  /** In-flight rows the tick reconciles before touching new candidates. */
  listUnsettled(
    db: Database.Database,
    limit: number,
  ): PolymarketDiscoveryStateRow[] {
    return prep(
      db,
      `SELECT * FROM polymarket_discovery_state
        WHERE status IN ('draft','broadcasting','confirmed')
        ORDER BY end_date_epoch_s ASC
        LIMIT ?`,
    ).all(limit) as PolymarketDiscoveryStateRow[];
  },

  /** Spend-cap counter: on-chain registrations recorded since `since_iso`. */
  countRegisteredSince(db: Database.Database, since_iso: string): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM polymarket_discovery_state
        WHERE registered_onchain_at IS NOT NULL
          AND registered_onchain_at >= ?`,
    ).get(since_iso) as { n: number };
    return row.n;
  },

  /** Listed-by-discovery rows whose window is still open (coverage probe). */
  countListedEndingAfter(db: Database.Database, epoch_s: number): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM polymarket_discovery_state
        WHERE status = 'listed' AND end_date_epoch_s > ?`,
    ).get(epoch_s) as { n: number };
    return row.n;
  },

  getHealth(db: Database.Database): PolymarketDiscoveryHealthRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM polymarket_discovery_health WHERE id = 1`,
      ).get() as PolymarketDiscoveryHealthRow | undefined) ?? null
    );
  },

  recordHealth(
    db: Database.Database,
    args: {
      enabled: 0 | 1;
      tick_interval_sec: number;
      last_tick_at: string;
      /** null = keep the previous success stamp. */
      last_success_at: string | null;
      last_error: string | null;
      relayer_balance_wei: string | null;
      balance_status: "ok" | "warning" | "critical" | null;
    },
  ): void {
    prep(
      db,
      `INSERT INTO polymarket_discovery_health (
         id, enabled, tick_interval_sec, last_tick_at, last_success_at,
         last_error, relayer_balance_wei, balance_status, updated_at
       ) VALUES (
         1, @enabled, @tick_interval_sec, @last_tick_at, @last_success_at,
         @last_error, @relayer_balance_wei, @balance_status, @last_tick_at
       )
       ON CONFLICT(id) DO UPDATE SET
         enabled             = excluded.enabled,
         tick_interval_sec   = excluded.tick_interval_sec,
         last_tick_at        = excluded.last_tick_at,
         last_success_at     = COALESCE(excluded.last_success_at, polymarket_discovery_health.last_success_at),
         last_error          = excluded.last_error,
         relayer_balance_wei = COALESCE(excluded.relayer_balance_wei, polymarket_discovery_health.relayer_balance_wei),
         balance_status      = COALESCE(excluded.balance_status, polymarket_discovery_health.balance_status),
         updated_at          = excluded.updated_at`,
    ).run(args);
  },

  /**
   * Flip the health row to disabled when the daemon boots with discovery
   * off. Without this, a previously enabled row keeps the stale-tick alert
   * firing forever after the operator turns discovery off.
   */
  markDisabled(db: Database.Database, now_iso: string): void {
    prep(
      db,
      `UPDATE polymarket_discovery_health
          SET enabled = 0, updated_at = @now_iso
        WHERE id = 1 AND enabled = 1`,
    ).run({ now_iso });
  },
};
