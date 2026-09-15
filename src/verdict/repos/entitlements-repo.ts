import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

// Durable state machine for paid early decrypt grants on sealed calls. One row per
// (chain_id, contract_address, onchain_call_id, subscriber_address). The reservation is
// inserted BEFORE settlement so two concurrent payment nonces can never double-charge.
export type EntitlementStatus =
  | "payment_settling"
  | "grant_queued"
  | "grant_broadcast"
  | "granted"
  | "settlement_unknown"
  | "grant_failed_refund_due"
  | "refunded";

export type EntitlementRefundStatus = "refund_due" | "refunded" | null;

// Statuses the grant reconciler can still advance. `grant_failed_refund_due` is owed money,
// not work: listRefundDue serves it, so dead rows cannot starve live grants.
export const NON_TERMINAL_ENTITLEMENT_STATUSES: readonly EntitlementStatus[] = [
  "payment_settling",
  "grant_queued",
  "grant_broadcast",
  "settlement_unknown",
];

export interface EntitlementRow {
  id: number;
  chain_id: number;
  contract_address: string;
  call_id: string | null;
  onchain_call_id: string;
  subscriber_address: string;
  producer_agent_id: string | null;
  nanopay_receipt_id: string | null;
  amount: string | null;
  currency: string | null;
  /**
   * Revenue split in bps, frozen at the sale so a later fee change cannot re-cut it.
   * NULL on legacy rows, which accrue at the current fee as `legacy_fallback`.
   */
  fee_bps_at_sale: number | null;
  status: EntitlementStatus;
  grant_tx_hash: string | null;
  grant_block_number: number | null;
  grant_attempts: number;
  last_error: string | null;
  refund_status: EntitlementRefundStatus;
  next_attempt_at: string | null;
  granted_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, chain_id, contract_address, call_id, onchain_call_id,
       subscriber_address, producer_agent_id, nanopay_receipt_id, amount,
       currency, fee_bps_at_sale, status, grant_tx_hash, grant_block_number,
       grant_attempts, last_error, refund_status, next_attempt_at, granted_at,
       created_at, updated_at`;

// Contract + subscriber are case-insensitive EVM addresses; the on-chain call
// id is a bytes32 hex. Normalize to lowercase so case variants never bypass the
// UNIQUE reservation index or split lookups.
function norm(value: string): string {
  return value.toLowerCase();
}

export interface EntitlementReservationKey {
  chainId: number;
  contractAddress: string;
  onchainCallId: string;
  subscriberAddress: string;
}

export interface ReserveEntitlementInput extends EntitlementReservationKey {
  callId: string | null;
  producerAgentId: string | null;
  amount: string | null;
  currency: string | null;
  /**
   * Split this sale freezes, in bps: the call's snapshot, else the current fee.
   * Undefined only where no sale happens (an adopted on-chain grant).
   */
  feeBpsAtSale?: number | null;
  now: string;
  /**
   * When the reconciler may first treat this reservation as abandoned. Set past a normal
   * settle round-trip; NULL sorts first in listDue and would pre-empt live requests.
   */
  nextAttemptAt?: string | null;
}

export interface EntitlementPatch {
  status?: EntitlementStatus;
  callId?: string | null;
  producerAgentId?: string | null;
  nanopayReceiptId?: string | null;
  amount?: string | null;
  currency?: string | null;
  grantTxHash?: string | null;
  grantBlockNumber?: number | null;
  lastError?: string | null;
  refundStatus?: EntitlementRefundStatus;
  nextAttemptAt?: string | null;
  grantedAt?: string | null;
  incrementAttempts?: boolean;
  now: string;
}

export const entitlementsRepo = {
  /**
   * Insert the reservation as `payment_settling` BEFORE settling. A racing identical insert
   * throws SQLITE_CONSTRAINT_UNIQUE; the caller resolves it via byReservation. Returns the id.
   */
  reserve(db: Database.Database, input: ReserveEntitlementInput): number {
    const result = prep(
      db,
      `INSERT INTO entitlements (
         chain_id, contract_address, call_id, onchain_call_id,
         subscriber_address, producer_agent_id, nanopay_receipt_id,
         amount, currency, fee_bps_at_sale, status, grant_attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (
         @chain_id, @contract_address, @call_id, @onchain_call_id,
         @subscriber_address, @producer_agent_id, NULL,
         @amount, @currency, @fee_bps_at_sale, 'payment_settling', 0,
         @next_attempt_at, @now, @now
       )`,
    ).run({
      chain_id: input.chainId,
      contract_address: norm(input.contractAddress),
      call_id: input.callId,
      onchain_call_id: norm(input.onchainCallId),
      subscriber_address: norm(input.subscriberAddress),
      producer_agent_id: input.producerAgentId,
      amount: input.amount,
      currency: input.currency,
      fee_bps_at_sale: input.feeBpsAtSale ?? null,
      next_attempt_at: input.nextAttemptAt ?? null,
      now: input.now,
    });
    return Number(result.lastInsertRowid);
  },

  byReservation(
    db: Database.Database,
    key: EntitlementReservationKey,
  ): EntitlementRow | null {
    return (
      (prep(
        db,
        `SELECT ${COLUMNS} FROM entitlements
         WHERE chain_id = @chain_id
           AND contract_address = @contract_address
           AND onchain_call_id = @onchain_call_id
           AND subscriber_address = @subscriber_address`,
      ).get({
        chain_id: key.chainId,
        contract_address: norm(key.contractAddress),
        onchain_call_id: norm(key.onchainCallId),
        subscriber_address: norm(key.subscriberAddress),
      }) as EntitlementRow | undefined) ?? null
    );
  },

  /**
   * Delete a reservation whose payment was definitively rejected, so a new nonce can retry.
   * `settlement_unknown` and `grant_failed_refund_due` are releasable too: the reconciler may
   * relabel before the rejection arrives. The real guard is `nanopay_receipt_id IS NULL` (no
   * money moved); the status list keeps receipt-less adopted grants (`granted`) safe.
   */
  releaseReservation(db: Database.Database, id: number): boolean {
    const result = prep(
      db,
      `DELETE FROM entitlements
       WHERE id = ?
         AND nanopay_receipt_id IS NULL
         AND status IN (
           'payment_settling', 'settlement_unknown', 'grant_failed_refund_due'
         )`,
    ).run(id);
    return result.changes > 0;
  },

  byId(db: Database.Database, id: number): EntitlementRow | null {
    return (
      (prep(
        db,
        `SELECT ${COLUMNS} FROM entitlements WHERE id = ?`,
      ).get(id) as EntitlementRow | undefined) ?? null
    );
  },

  /**
   * Conditional state-machine transition. Updates the row only while its
   * current status is one of `from` (so a delayed reconciler can never
   * regress a row another writer already advanced), optionally advancing to
   * `patch.status` and overwriting any provided fields (COALESCE keeps the
   * prior value for omitted ones). Returns true iff a row changed.
   */
  transition(
    db: Database.Database,
    id: number,
    from: readonly EntitlementStatus[],
    patch: EntitlementPatch,
  ): boolean {
    const placeholders = from.map((_, i) => `@from${i}`).join(", ");
    const params: Record<string, unknown> = {
      id,
      status: patch.status ?? null,
      call_id: patch.callId ?? null,
      producer_agent_id: patch.producerAgentId ?? null,
      nanopay_receipt_id: patch.nanopayReceiptId ?? null,
      amount: patch.amount ?? null,
      currency: patch.currency ?? null,
      grant_tx_hash: patch.grantTxHash ?? null,
      grant_block_number: patch.grantBlockNumber ?? null,
      // last_error / refund_status / next_attempt_at / granted_at are written
      // straight through (settable back to NULL) rather than COALESCE-merged.
      last_error: patch.lastError ?? null,
      refund_status: patch.refundStatus ?? null,
      next_attempt_at: patch.nextAttemptAt ?? null,
      granted_at: patch.grantedAt ?? null,
      increment: patch.incrementAttempts ? 1 : 0,
      now: patch.now,
    };
    from.forEach((s, i) => {
      params[`from${i}`] = s;
    });
    const result = prep(
      db,
      `UPDATE entitlements SET
         status = COALESCE(@status, status),
         call_id = COALESCE(@call_id, call_id),
         producer_agent_id = COALESCE(@producer_agent_id, producer_agent_id),
         nanopay_receipt_id = COALESCE(@nanopay_receipt_id, nanopay_receipt_id),
         amount = COALESCE(@amount, amount),
         currency = COALESCE(@currency, currency),
         grant_tx_hash = COALESCE(@grant_tx_hash, grant_tx_hash),
         grant_block_number = COALESCE(@grant_block_number, grant_block_number),
         grant_attempts = grant_attempts + @increment,
         last_error = @last_error,
         refund_status = @refund_status,
         next_attempt_at = @next_attempt_at,
         granted_at = COALESCE(@granted_at, granted_at),
         updated_at = @now
       WHERE id = @id AND status IN (${placeholders})`,
    ).run(params);
    return result.changes > 0;
  },

  /**
   * Attach settlement evidence regardless of status, for a payment that settled after another
   * writer moved the row. Status is untouched. COALESCE: an existing receipt is never overwritten.
   */
  attachReceipt(
    db: Database.Database,
    id: number,
    input: {
      nanopayReceiptId: string;
      amount: string;
      currency: string;
      now: string;
    },
  ): boolean {
    const result = prep(
      db,
      `UPDATE entitlements SET
         nanopay_receipt_id = COALESCE(nanopay_receipt_id, @nanopay_receipt_id),
         amount = COALESCE(amount, @amount),
         currency = COALESCE(currency, @currency),
         updated_at = @now
       WHERE id = @id`,
    ).run({
      id,
      nanopay_receipt_id: input.nanopayReceiptId,
      amount: input.amount,
      currency: input.currency,
      now: input.now,
    });
    return result.changes > 0;
  },

  /**
   * Due, non-terminal rows for the grant reconciler, NULL next_attempt_at first. One grantor
   * per key, so no lease; the contract's window guard is the safety boundary.
   * Excludes grant_failed_refund_due (see listRefundDue).
   */
  listDue(
    db: Database.Database,
    input: { now: string; limit: number },
  ): EntitlementRow[] {
    return prep(
      db,
      `SELECT ${COLUMNS} FROM entitlements
       WHERE status IN (
         'payment_settling','grant_queued','grant_broadcast',
         'settlement_unknown'
       )
         AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
       ORDER BY next_attempt_at IS NOT NULL, next_attempt_at
       LIMIT @limit`,
    ).all({ now: input.now, limit: input.limit }) as EntitlementRow[];
  },

  /**
   * Settled payments owed a refund, oldest first; separate from listDue so neither starves.
   * A refund worker must re-read each row in its transaction and require a non-null
   * nanopay_receipt_id: a late rejection can delete a row after it is listed here.
   */
  listRefundDue(
    db: Database.Database,
    input: { limit: number },
  ): EntitlementRow[] {
    return prep(
      db,
      `SELECT ${COLUMNS} FROM entitlements
       WHERE status = 'grant_failed_refund_due' AND refund_status = 'refund_due'
       ORDER BY updated_at, id
       LIMIT @limit`,
    ).all({ limit: input.limit }) as EntitlementRow[];
  },

  /**
   * Reserve only if the cohort is below the cap, counting and inserting under one IMMEDIATE
   * write lock (deferred would let two buyers both pass the count). Null when full.
   * A unique violation still propagates: the same subscriber racing itself.
   */
  reserveWithinCap(
    db: Database.Database,
    input: ReserveEntitlementInput & { cap: number | undefined },
  ): number | null {
    const run = db.transaction((args: ReserveEntitlementInput & { cap: number | undefined }) => {
      if (args.cap !== undefined) {
        const armed = entitlementsRepo.countActiveForCall(db, {
          chainId: args.chainId,
          contractAddress: args.contractAddress,
          onchainCallId: args.onchainCallId,
        });
        if (armed >= args.cap) return null;
      }
      return entitlementsRepo.reserve(db, args);
    });
    return run.immediate(input);
  },

  /**
   * Record access the payer already holds on-chain but we have no row for, without charging again.
   * Amount, currency and receipt stay NULL: no payment happened. IMMEDIATE so two
   * concurrent adoptions cannot both see no row.
   */
  adoptOnchainGrant(
    db: Database.Database,
    input: {
      chainId: number;
      contractAddress: string;
      onchainCallId: string;
      subscriberAddress: string;
      producerAgentId: string | null;
      now: string;
    },
  ): EntitlementRow | null {
    const key = {
      chainId: input.chainId,
      contractAddress: input.contractAddress,
      onchainCallId: input.onchainCallId,
      subscriberAddress: input.subscriberAddress,
    };
    const run = db.transaction(() => {
      const existing = entitlementsRepo.byReservation(db, key);
      if (existing) return existing;
      const id = entitlementsRepo.reserve(db, {
        ...key,
        callId: null,
        producerAgentId: input.producerAgentId,
        amount: null,
        currency: null,
        now: input.now,
      });
      entitlementsRepo.transition(db, id, ["payment_settling"], {
        status: "granted",
        grantedAt: input.now,
        now: input.now,
      });
      return entitlementsRepo.byId(db, id);
    });
    return run.immediate();
  },

  countActiveForCall(
    db: Database.Database,
    input: { chainId: number; contractAddress: string; onchainCallId: string },
  ): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM entitlements
       WHERE chain_id = @chain_id
         AND lower(contract_address) = lower(@contract_address)
         AND lower(onchain_call_id) = lower(@onchain_call_id)
         AND status IN (
           'payment_settling','grant_queued','grant_broadcast',
           'settlement_unknown','granted'
         )`,
    ).get({
      chain_id: input.chainId,
      contract_address: input.contractAddress,
      onchain_call_id: input.onchainCallId,
    }) as { n: number };
    return row.n;
  },

  /**
   * countActiveForCall for many calls in one grouped read. Keys are lowercased on-chain
   * call ids; a missing key means 0 reservations.
   */
  countActiveForCalls(
    db: Database.Database,
    input: {
      chainId: number;
      contractAddress: string;
      onchainCallIds: readonly string[];
    },
  ): Map<string, number> {
    const counts = new Map<string, number>();
    const ids = [...new Set(input.onchainCallIds.map(norm))];
    if (ids.length === 0) return counts;
    // Chunked so a large page can never exceed SQLITE_MAX_VARIABLE_NUMBER
    // (999 on older builds); two bound params are already spent per chunk.
    const CHUNK = 400;
    for (let start = 0; start < ids.length; start += CHUNK) {
      const chunk = ids.slice(start, start + CHUNK);
      const rows = prep(
        db,
        `SELECT lower(onchain_call_id) AS onchain_call_id, COUNT(*) AS n
           FROM entitlements
          WHERE chain_id = ?
            AND lower(contract_address) = lower(?)
            AND lower(onchain_call_id) IN (${chunk.map(() => "?").join(",")})
            AND status IN (
              'payment_settling','grant_queued','grant_broadcast',
              'settlement_unknown','granted'
            )
          GROUP BY lower(onchain_call_id)`,
      ).all(input.chainId, input.contractAddress, ...chunk) as Array<{
        onchain_call_id: string;
        n: number;
      }>;
      for (const row of rows) counts.set(row.onchain_call_id, row.n);
    }
    return counts;
  },

  counts(db: Database.Database): Record<EntitlementStatus, number> {
    const rows = prep(
      db,
      `SELECT status, COUNT(*) AS n FROM entitlements GROUP BY status`,
    ).all() as Array<{ status: EntitlementStatus; n: number }>;
    const out: Record<EntitlementStatus, number> = {
      payment_settling: 0,
      grant_queued: 0,
      grant_broadcast: 0,
      granted: 0,
      settlement_unknown: 0,
      grant_failed_refund_due: 0,
      refunded: 0,
    };
    for (const row of rows) out[row.status] = row.n;
    return out;
  },
} as const;
