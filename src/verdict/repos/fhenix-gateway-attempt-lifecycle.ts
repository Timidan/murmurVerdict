import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

/**
 * Status machine, claim-token protocol and telemetry shared by both Gateway Attempt tables
 * (sealed calls and feed packets). Entity-specific writes live in each table's own module.
 */

export type FhenixGatewayTxStatus =
  | "queued"
  | "submitted"
  | "confirmed"
  | "accepted"
  | "failed_retryable"
  | "failed_terminal";

/**
 * Statuses a Gateway Attempt may (re)enter broadcast from. The single source: guards use
 * {@link isBroadcastableStatus}, SQL uses {@link BROADCASTABLE_STATUS_SQL}. Do not re-declare it.
 */
export const BROADCASTABLE_STATUSES = [
  "queued",
  "failed_retryable",
] as const satisfies readonly FhenixGatewayTxStatus[];

export function isBroadcastableStatus(status: string): boolean {
  return (BROADCASTABLE_STATUSES as readonly string[]).includes(status);
}

/** SQL fragment for the broadcastable set. Compile-time literals, so interpolating is safe. */
const BROADCASTABLE_STATUS_SQL = BROADCASTABLE_STATUSES.map(
  (status) => `'${status}'`,
).join(",");

export interface FhenixGatewayTxStatusCount {
  status: FhenixGatewayTxStatus;
  count: number;
  oldest_updated_at: string | null;
  newest_updated_at: string | null;
}

export interface FhenixGatewayReceiptTelemetry {
  attempt_id: string;
  receipt_observed_at: string;
  receipt_latency_ms: number;
  latest_block_latency_ms: number | null;
  receipt_status: "success" | "reverted" | null;
  receipt_block_number: number | null;
  latest_block_number: number | null;
  confirmations_observed: number | null;
  gas_used: string | null;
  effective_gas_price_wei: string | null;
  last_rpc_error: string | null;
}

export interface FhenixGatewayTelemetrySummary {
  avg_broadcast_latency_ms: number | null;
  avg_receipt_latency_ms: number | null;
  avg_latest_block_latency_ms: number | null;
  max_confirmations_observed: number | null;
  rpc_errors: number;
  last_receipt_observed_at: string | null;
}

/** Lifecycle columns shared by both attempt tables; each row type extends this. */
export interface GatewayAttemptLifecycleRow {
  attempt_id: string;
  status: FhenixGatewayTxStatus;
  runtime_key_id: string | null;
  account_id: string;
  agent_wallet_address: string;
  tx_hash: string | null;
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: string;
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
  /** Non-null when a process has claimed this row for broadcast and has
   *  not yet recorded the result. Claims are released by markSubmitted /
   *  markRetryableFailure, or recovered by sweepStuckClaims. */
  broadcast_claim_token: string | null;
  created_at: string;
  updated_at: string;
}

export type GatewayAttemptTable =
  | "fhenix_gateway_tx_attempts"
  | "fhenix_gateway_feed_packet_tx_attempts";

/** The lifecycle store interface a Gateway Attempt kind hands to the
 *  Gateway Attempt Machine — exactly what the factory below returns. */
export type GatewayAttemptLifecycle<Row extends GatewayAttemptLifecycleRow> =
  ReturnType<typeof gatewayAttemptLifecycleRepo<Row>>;

export function gatewayAttemptLifecycleRepo<
  Row extends GatewayAttemptLifecycleRow,
>(table: GatewayAttemptTable) {
  return {
    byId(db: Database.Database, attempt_id: string): Row | null {
      return (
        (prep(
          db,
          `SELECT * FROM ${table} WHERE attempt_id = ?`,
        ).get(attempt_id) as Row | undefined) ?? null
      );
    },

    /**
     * Record a successful broadcast. With a claim_token, only while the row still holds it,
     * so a slow write returning after a sweep cannot clobber. True iff it moved to 'submitted'.
     */
    markSubmitted(
      db: Database.Database,
      input: {
        attempt_id: string;
        tx_hash: string;
        next_attempt_at: string;
        updated_at: string;
        broadcast_started_at: string;
        broadcast_latency_ms: number;
        claim_token?: string | null;
      },
    ): boolean {
      const claimToken = input.claim_token ?? null;
      const info = prep(
        db,
        `UPDATE ${table}
         SET status = 'submitted',
             tx_hash = @tx_hash,
             broadcast_started_at = @broadcast_started_at,
             broadcast_latency_ms = @broadcast_latency_ms,
             attempt_count = attempt_count + 1,
             next_attempt_at = @next_attempt_at,
             last_error = NULL,
             last_rpc_error = NULL,
             broadcast_claim_token = NULL,
             updated_at = @updated_at
         WHERE attempt_id = @attempt_id
           AND (@claim_token IS NULL OR broadcast_claim_token = @claim_token)
           -- FIRST-WINS on the hash. A row that already has one has a
           -- transaction out there; replacing it with a second, duplicate
           -- write's hash (which the contract rejects, so it reverts) strands
           -- the write that actually landed.
           --
           -- This is what makes the late-hash handoff race-safe: the
           -- preBroadcast check and journalLateTxHash are two operations, so a
           -- claimant can pass the check just before the hash appears. Here
           -- the loser simply fails and falls into the journal path.
           --
           -- Harmless in the normal flow: tx_hash is NULL until the first
           -- successful submit, and a row that has one is submitted, which is
           -- not broadcastable.
           AND tx_hash IS NULL`,
      ).run({ ...input, claim_token: claimToken });
      return info.changes === 1;
    },

    /**
     * Journal a hash that WAS sent but whose guarded write lost its claim race. Hash only,
     * no status or claim change, so a re-taken claim survives. Never overwrites a recorded hash.
     */
    journalLateTxHash(
      db: Database.Database,
      input: { attempt_id: string; tx_hash: string; updated_at: string },
    ): boolean {
      return (
        prep(
          db,
          `UPDATE ${table}
           SET tx_hash = @tx_hash,
               updated_at = @updated_at
           WHERE attempt_id = @attempt_id
             AND tx_hash IS NULL`,
        ).run(input).changes > 0
      );
    },

    /**
     * Promote a row that already has a journalled hash to `submitted` and release the caller's
     * claim; tx_hash is untouched. `claim_token: null` is the unclaimed form: a broadcastable
     * row with a hash must never be re-broadcast, or its landed tx is never confirmed.
     */
    adoptJournalledTxHash(
      db: Database.Database,
      input: {
        attempt_id: string;
        claim_token: string | null;
        next_attempt_at: string;
        updated_at: string;
      },
    ): boolean {
      const claimClause =
        input.claim_token === null
          ? "broadcast_claim_token IS NULL"
          : "broadcast_claim_token = @claim_token";
      return (
        prep(
          db,
          `UPDATE ${table}
           SET status = 'submitted',
               next_attempt_at = @next_attempt_at,
               last_error = NULL,
               last_rpc_error = NULL,
               broadcast_claim_token = NULL,
               updated_at = @updated_at
           WHERE attempt_id = @attempt_id
             AND ${claimClause}
             AND tx_hash IS NOT NULL`,
        ).run(input).changes === 1
      );
    },

    markReconciledSubmitted(
      db: Database.Database,
      input: {
        attempt_id: string;
        tx_hash: string;
        next_attempt_at: string;
        updated_at: string;
      },
    ): boolean {
      const info = prep(
        db,
        `UPDATE ${table}
         SET status = 'submitted',
             tx_hash = @tx_hash,
             next_attempt_at = @next_attempt_at,
             last_error = NULL,
             last_rpc_error = NULL,
             broadcast_claim_token = NULL,
             updated_at = @updated_at
         WHERE attempt_id = @attempt_id
           -- Pre-claim path: never clobber a live claim. Reconciliation
           -- awaits an RPC read, and another tick can claim the row in
           -- that window; clearing its token here would orphan a
           -- broadcast that is already in flight.
           AND broadcast_claim_token IS NULL
           AND tx_hash IS NULL`,
      ).run(input);
      return info.changes === 1;
    },

    /** Reconciliation read failed: retryable, without incrementing attempt_count (no write happened). */
    markReconciliationFailure(
      db: Database.Database,
      input: {
        attempt_id: string;
        last_error: string;
        next_attempt_at: string;
        updated_at: string;
      },
    ): boolean {
      const info = prep(
        db,
        `UPDATE ${table}
         SET status = 'failed_retryable',
             last_error = @last_error,
             next_attempt_at = @next_attempt_at,
             broadcast_claim_token = NULL,
             updated_at = @updated_at
         WHERE attempt_id = @attempt_id
           -- Pre-claim path: never clobber a live claim. Reconciliation
           -- awaits an RPC read, and another tick can claim the row in
           -- that window; clearing its token here would orphan a
           -- broadcast that is already in flight.
           AND broadcast_claim_token IS NULL
           AND tx_hash IS NULL`,
      ).run(input);
      return info.changes === 1;
    },

    /**
     * Record a retryable broadcast failure. Same token-ownership protection
     * as markSubmitted. Returns true iff the row transitioned.
     */
    markRetryableFailure(
      db: Database.Database,
      input: {
        attempt_id: string;
        last_error: string;
        next_attempt_at: string;
        updated_at: string;
        broadcast_started_at: string | null;
        broadcast_latency_ms: number | null;
        claim_token?: string | null;
      },
    ): boolean {
      const claimToken = input.claim_token ?? null;
      const info = prep(
        db,
        `UPDATE ${table}
         SET status = 'failed_retryable',
             broadcast_started_at = COALESCE(@broadcast_started_at, broadcast_started_at),
             broadcast_latency_ms = COALESCE(@broadcast_latency_ms, broadcast_latency_ms),
             attempt_count = attempt_count + 1,
             next_attempt_at = @next_attempt_at,
             last_error = @last_error,
             last_rpc_error = @last_error,
             broadcast_claim_token = NULL,
             updated_at = @updated_at
         WHERE attempt_id = @attempt_id
           AND (@claim_token IS NULL OR broadcast_claim_token = @claim_token)`,
      ).run({ ...input, claim_token: claimToken });
      return info.changes === 1;
    },

    /**
     * Atomic claim for broadcast. Returns true iff this caller won the race;
     * false if the row was already claimed by another writer (or moved out
     * of broadcastable status). The token is later cleared by markSubmitted /
     * markRetryableFailure / a stuck-claim sweep.
     */
    claimForBroadcast(
      db: Database.Database,
      input: { attempt_id: string; broadcast_started_at: string; updated_at: string; token: string },
    ): boolean {
      const info = prep(
        db,
        `UPDATE ${table}
         SET broadcast_claim_token = @token,
             broadcast_started_at = @broadcast_started_at,
             updated_at = @updated_at
         WHERE attempt_id = @attempt_id
           AND status IN (${BROADCASTABLE_STATUS_SQL})
           AND broadcast_claim_token IS NULL`,
      ).run(input);
      return info.changes === 1;
    },

    /**
     * Release claims older than stuckBeforeIso on still-broadcastable rows; they fall back to
     * failed_retryable. Returns the count released.
     */
    sweepStuckClaims(
      db: Database.Database,
      input: { stuckBeforeIso: string; updated_at: string; errorMessage: string },
    ): number {
      const info = prep(
        db,
        `UPDATE ${table}
         SET broadcast_claim_token = NULL,
             status = 'failed_retryable',
             last_error = @errorMessage,
             updated_at = @updated_at
         WHERE broadcast_claim_token IS NOT NULL
           AND broadcast_started_at IS NOT NULL
           AND broadcast_started_at < @stuckBeforeIso
           AND status IN (${BROADCASTABLE_STATUS_SQL})`,
      ).run(input);
      return info.changes;
    },

    recordReceiptTelemetry(
      db: Database.Database,
      input: FhenixGatewayReceiptTelemetry,
    ): void {
      prep(
        db,
        `UPDATE ${table}
         SET receipt_observed_at = @receipt_observed_at,
             receipt_latency_ms = @receipt_latency_ms,
             latest_block_latency_ms = @latest_block_latency_ms,
             receipt_status = @receipt_status,
             receipt_block_number = @receipt_block_number,
             latest_block_number = @latest_block_number,
             confirmations_observed = @confirmations_observed,
             gas_used = @gas_used,
             effective_gas_price_wei = @effective_gas_price_wei,
             last_rpc_error = @last_rpc_error
         WHERE attempt_id = @attempt_id`,
      ).run(input);
    },

    recordRpcError(
      db: Database.Database,
      input: {
        attempt_id: string;
        receipt_observed_at: string;
        receipt_latency_ms: number | null;
        last_rpc_error: string;
      },
    ): void {
      prep(
        db,
        `UPDATE ${table}
         SET receipt_observed_at = @receipt_observed_at,
             receipt_latency_ms = COALESCE(@receipt_latency_ms, receipt_latency_ms),
             last_rpc_error = @last_rpc_error
         WHERE attempt_id = @attempt_id`,
      ).run(input);
    },

    /**
     * Terminal failure, as a compare-and-set; returns whether a row changed.
     * - No options (pre-claim decision, e.g. revoked key): only if broadcastable AND unclaimed.
     *   A claimed row is left to its owner or the sweep; on false, skip.
     * - `expect_status` (post-broadcast, e.g. reverted receipt): only at that status; no claim held.
     * - `expect_claim_token` (caller owns the claim): only with that token; releases the claim.
     */
    markTerminalFailure(
      db: Database.Database,
      input: {
        attempt_id: string;
        last_error: string;
        updated_at: string;
        expect_claim_token?: string | null;
        expect_status?: FhenixGatewayTxStatus;
      },
    ): boolean {
      const token = input.expect_claim_token ?? null;
      if (token === null && input.expect_status) {
        return (
          prep(
            db,
            `UPDATE ${table}
             SET status = 'failed_terminal',
                 last_error = @last_error,
                 updated_at = @updated_at
             WHERE attempt_id = @attempt_id
               AND status = @expect_status`,
          ).run({
            attempt_id: input.attempt_id,
            last_error: input.last_error,
            updated_at: input.updated_at,
            expect_status: input.expect_status,
          }).changes > 0
        );
      }
      if (token === null) {
        return (
          prep(
            db,
            `UPDATE ${table}
             SET status = 'failed_terminal',
                 last_error = @last_error,
                 updated_at = @updated_at
             WHERE attempt_id = @attempt_id
               AND status IN (${BROADCASTABLE_STATUS_SQL})
               AND broadcast_claim_token IS NULL`,
          ).run({
            attempt_id: input.attempt_id,
            last_error: input.last_error,
            updated_at: input.updated_at,
          }).changes > 0
        );
      }
      return (
        prep(
          db,
          `UPDATE ${table}
           SET status = 'failed_terminal',
               last_error = @last_error,
               broadcast_claim_token = NULL,
               broadcast_started_at = NULL,
               updated_at = @updated_at
           WHERE attempt_id = @attempt_id
             AND broadcast_claim_token = @expect_claim_token`,
        ).run({
          attempt_id: input.attempt_id,
          last_error: input.last_error,
          updated_at: input.updated_at,
          expect_claim_token: token,
        }).changes > 0
      );
    },

    markRetryNow(
      db: Database.Database,
      input: { attempt_id: string; next_attempt_at: string; updated_at: string },
    ): boolean {
      const info = prep(
        db,
        `UPDATE ${table}
         SET status = 'queued',
             next_attempt_at = @next_attempt_at,
             last_error = NULL,
             updated_at = @updated_at
         WHERE attempt_id = @attempt_id
           AND status IN (${BROADCASTABLE_STATUS_SQL})`,
      ).run(input);
      return info.changes > 0;
    },

    listDueForBroadcast(
      db: Database.Database,
      nowIso: string,
      limit = 25,
    ): Row[] {
      const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
      return prep(
        db,
        `SELECT * FROM ${table}
         WHERE status IN (${BROADCASTABLE_STATUS_SQL})
           AND next_attempt_at <= ?
         ORDER BY next_attempt_at, created_at
         LIMIT ?`,
      ).all(nowIso, safeLimit) as Row[];
    },

    countDueForBroadcast(
      db: Database.Database,
      nowIso: string,
    ): number {
      const row = prep(
        db,
        `SELECT COUNT(*) AS count
         FROM ${table}
         WHERE status IN (${BROADCASTABLE_STATUS_SQL})
           AND next_attempt_at <= ?`,
      ).get(nowIso) as { count: number } | undefined;
      return row?.count ?? 0;
    },

    listSubmittedForConfirmation(
      db: Database.Database,
      limit = 50,
    ): Row[] {
      const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
      return prep(
        db,
        `SELECT * FROM ${table}
         WHERE status = 'submitted' AND tx_hash IS NOT NULL
         ORDER BY updated_at
         LIMIT ?`,
      ).all(safeLimit) as Row[];
    },

    countSubmittedForConfirmation(db: Database.Database): number {
      const row = prep(
        db,
        `SELECT COUNT(*) AS count
         FROM ${table}
         WHERE status = 'submitted' AND tx_hash IS NOT NULL`,
      ).get() as { count: number } | undefined;
      return row?.count ?? 0;
    },

    listConfirmedForAcceptance(
      db: Database.Database,
      limit = 50,
    ): Row[] {
      const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
      return prep(
        db,
        `SELECT * FROM ${table}
         WHERE status = 'confirmed'
         ORDER BY updated_at
         LIMIT ?`,
      ).all(safeLimit) as Row[];
    },

    countConfirmedForAcceptance(db: Database.Database): number {
      const row = prep(
        db,
        `SELECT COUNT(*) AS count
         FROM ${table}
         WHERE status = 'confirmed'`,
      ).get() as { count: number } | undefined;
      return row?.count ?? 0;
    },

    statusCounts(db: Database.Database): FhenixGatewayTxStatusCount[] {
      return prep(
        db,
        `SELECT status,
                COUNT(*) AS count,
                MIN(updated_at) AS oldest_updated_at,
                MAX(updated_at) AS newest_updated_at
         FROM ${table}
         GROUP BY status
         ORDER BY status`,
      ).all() as FhenixGatewayTxStatusCount[];
    },

    telemetrySummary(db: Database.Database): FhenixGatewayTelemetrySummary {
      const row = prep(
        db,
        `SELECT AVG(broadcast_latency_ms) AS avg_broadcast_latency_ms,
                AVG(receipt_latency_ms) AS avg_receipt_latency_ms,
                AVG(latest_block_latency_ms) AS avg_latest_block_latency_ms,
                MAX(confirmations_observed) AS max_confirmations_observed,
                SUM(CASE WHEN last_rpc_error IS NOT NULL THEN 1 ELSE 0 END) AS rpc_errors,
                MAX(receipt_observed_at) AS last_receipt_observed_at
         FROM ${table}`,
      ).get() as Partial<FhenixGatewayTelemetrySummary> | undefined;
      return {
        avg_broadcast_latency_ms: row?.avg_broadcast_latency_ms ?? null,
        avg_receipt_latency_ms: row?.avg_receipt_latency_ms ?? null,
        avg_latest_block_latency_ms: row?.avg_latest_block_latency_ms ?? null,
        max_confirmations_observed: row?.max_confirmations_observed ?? null,
        rpc_errors: row?.rpc_errors ?? 0,
        last_receipt_observed_at: row?.last_receipt_observed_at ?? null,
      };
    },

    listRecent(
      db: Database.Database,
      opts: { status?: FhenixGatewayTxStatus; limit?: number } = {},
    ): Row[] {
      const safeLimit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
      if (opts.status) {
        return prep(
          db,
          `SELECT * FROM ${table}
           WHERE status = ?
           ORDER BY updated_at DESC, created_at DESC
           LIMIT ?`,
        ).all(opts.status, safeLimit) as Row[];
      }
      return prep(
        db,
        `SELECT * FROM ${table}
         ORDER BY updated_at DESC, created_at DESC
         LIMIT ?`,
      ).all(safeLimit) as Row[];
    },

    listStuck(
      db: Database.Database,
      input: { stale_before: string; limit?: number },
    ): Row[] {
      const safeLimit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
      return prep(
        db,
        `SELECT * FROM ${table}
         WHERE status IN ('submitted','confirmed')
           AND updated_at <= @stale_before
         ORDER BY updated_at ASC
         LIMIT @limit`,
      ).all({ stale_before: input.stale_before, limit: safeLimit }) as Row[];
    },
  };
}
