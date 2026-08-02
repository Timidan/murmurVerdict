import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

// Durable state machine for Flow 2 (paid private decrypt-grant, grant-only v1).
// One row per (chain_id, contract_address, onchain_call_id, subscriber_address):
// a subscriber who pays off-chain to receive EARLY private decrypt access to an
// agent's sealed call, before the public reveal. The reservation is inserted
// BEFORE settlement so two concurrent payment nonces can never double-charge
// the same access. See:
//   - contracts/src/MurmurSealedVerdicts.sol  grantDecryptAccess (window enforce)
//   - src/verdict/entitlement-access-surface.ts (the payment→grant ordering)
//   - src/integrations/fhenix-grant-reconciler.ts (stuck-row recovery)
export type EntitlementStatus =
  | "payment_settling"
  | "grant_queued"
  | "grant_broadcast"
  | "granted"
  | "settlement_unknown"
  | "grant_failed_refund_due"
  | "refunded";

export type EntitlementRefundStatus = "refund_due" | "refunded" | null;

// Non-terminal statuses the reconciler keeps working. `granted` and `refunded`
// are terminal; `grant_failed_refund_due` stays due until a refund is recorded.
export const NON_TERMINAL_ENTITLEMENT_STATUSES: readonly EntitlementStatus[] = [
  "payment_settling",
  "grant_queued",
  "grant_broadcast",
  "settlement_unknown",
  "grant_failed_refund_due",
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
       currency, status, grant_tx_hash, grant_block_number, grant_attempts,
       last_error, refund_status, next_attempt_at, granted_at,
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
  now: string;
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
   * Insert the unique reservation in `payment_settling` state BEFORE settling
   * the payment. The UNIQUE index on (chain, contract, onchain_call, subscriber)
   * guards against concurrent double-buy; a racing identical insert throws
   * SQLITE_CONSTRAINT_UNIQUE, which the caller catches and resolves via
   * byReservation (treat as the same in-flight purchase). Returns the row id.
   */
  reserve(db: Database.Database, input: ReserveEntitlementInput): number {
    const result = prep(
      db,
      `INSERT INTO entitlements (
         chain_id, contract_address, call_id, onchain_call_id,
         subscriber_address, producer_agent_id, nanopay_receipt_id,
         amount, currency, status, grant_attempts, next_attempt_at,
         created_at, updated_at
       ) VALUES (
         @chain_id, @contract_address, @call_id, @onchain_call_id,
         @subscriber_address, @producer_agent_id, NULL,
         @amount, @currency, 'payment_settling', 0, NULL,
         @now, @now
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
   * Delete a reservation that never settled (payment definitively rejected, no
   * money moved) so a fresh payment nonce can retry the same (call, subscriber).
   * Guarded on status='payment_settling' so it can never drop a settled row.
   * Returns true iff a row was removed.
   */
  releaseReservation(db: Database.Database, id: number): boolean {
    const result = prep(
      db,
      `DELETE FROM entitlements WHERE id = ? AND status = 'payment_settling'`,
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
   * Non-terminal, due rows for the grant reconciler, ordered by next_attempt_at
   * (NULLs first — freshly reserved rows have never been scheduled). A single
   * write-enabled grantor process per key means no lease is needed; the
   * contract's window guard is the real safety boundary.
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
         'settlement_unknown','grant_failed_refund_due'
       )
         AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
       ORDER BY next_attempt_at IS NOT NULL, next_attempt_at
       LIMIT @limit`,
    ).all({ now: input.now, limit: input.limit }) as EntitlementRow[];
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
