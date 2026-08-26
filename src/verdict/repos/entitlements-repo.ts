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

// Statuses the grant reconciler can still advance. `granted` and `refunded` are
// terminal. `grant_failed_refund_due` is terminal *for grant work* —
// reconcileEntitlement returns it unchanged — so it is deliberately absent here:
// leaving it in the reconciler's due query lets a backlog of dead rows consume
// every tick's budget and starve live grants. It is owed money, not work, and is
// served by `listRefundDue` instead.
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
   * The revenue split as of THE SALE, in basis points, stamped at reservation.
   *
   * The sale is where the split freezes. Reading the live protocol fee at grant
   * time instead would let an operator's mid-flight fee change re-cut a
   * purchase the subscriber had already answered a 402 for.
   *
   * NULL only on rows predating migration 071; those accrue at the current fee
   * and are labelled `legacy_fallback` in the ledger so the difference stays
   * visible.
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
   * The split this sale freezes, in basis points. Taken from the CALL's
   * snapshot, or from the current protocol fee when the call predates one.
   *
   * Omitted (undefined) only where no sale happens — an adopted on-chain grant
   * never accrues, so stamping it with a split would describe revenue that
   * does not exist.
   */
  feeBpsAtSale?: number | null;
  now: string;
  /**
   * When the reconciler may first treat this reservation as abandoned.
   *
   * Reserving with NULL put the row at the FRONT of the reconciler's queue
   * (`listDue` orders NULLs first) while the request that created it was still
   * awaiting the payment rail — so the recovery path for crashed requests kept
   * pre-empting live ones. Set it past a normal settle round-trip; a request
   * that really did die is picked up once the grace expires.
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
   * Delete a reservation that never settled (payment definitively rejected, no
   * money moved) so a fresh payment nonce can retry the same (call, subscriber).
   * Returns true iff a row was removed.
   *
   * `settlement_unknown` is released too. The reconciler applies that label
   * WITHOUT the payment result — it means "a reservation sat here and nobody
   * told me what happened". The request holding a definitive `rejected` from
   * the rail knows better, and it can arrive after the reconciler has already
   * relabelled the row. Refusing to release it then left a phantom reservation
   * that blocked the subscriber's retry and later healed into a refund_due for
   * money that never moved.
   *
   * `grant_failed_refund_due` is releasable too, but ONLY with no receipt.
   * When a settle stays pending past the unknown-resolution budget, the
   * reconciler terminalizes the row — and a definitive rejection arriving
   * after that left a refund_due demanding a refund for money nobody took,
   * while permanently blocking the subscriber's retry.
   *
   * The real guard is the receipt, not the state list: `nanopay_receipt_id IS
   * NULL` means no settlement evidence was ever recorded, so there is nothing
   * to refund and nothing to lose. Both conditions are kept, because an
   * adopted on-chain grant is also receipt-less and must never be deleted —
   * its state (`granted`) is what excludes it.
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
   * Attach settlement evidence to a row REGARDLESS of its status.
   *
   * The escape hatch for a payment that settled after another writer already
   * moved the row somewhere `transition` will not act on. Status is untouched
   * — this makes no claim about what should happen next — but the receipt,
   * amount and currency get written down, because a settled payment with no
   * local record of what was taken cannot be refunded correctly.
   *
   * COALESCE, so an existing receipt is never overwritten: two receipts on one
   * reservation is a discrepancy to investigate, not one to silently resolve
   * in favour of whoever wrote last.
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
   * Non-terminal, due rows for the grant reconciler, ordered by next_attempt_at
   * (NULLs first — freshly reserved rows have never been scheduled). A single
   * write-enabled grantor process per key means no lease is needed; the
   * contract's window guard is the real safety boundary.
   *
   * `grant_failed_refund_due` is intentionally excluded: the reconciler cannot
   * advance it, so including it would let terminal rows occupy the per-tick
   * budget indefinitely and starve live grants. Use `listRefundDue` for those.
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
   * Settled payments owed a refund, oldest first. Separate from `listDue` so the
   * refund path and the grant path cannot starve each other. Rows stay here until
   * a refund is recorded (status `refunded`).
   *
   * FOR WHOEVER BUILDS THE REFUND WORKER: re-read each row inside the refunding
   * transaction and require a non-null `nanopay_receipt_id` before paying out.
   * A row can appear here and then legitimately vanish — a settle that stayed
   * pending past the unknown-resolution budget is terminalized as refund_due,
   * and a definitive rejection arriving afterwards deletes it, because no money
   * ever moved. Refunding from this snapshot without re-checking would pay out
   * against a payment that never happened.
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
   * Live cohort size for one call: reservations that are still on their way to
   * a grant, plus those already granted. Excludes terminal failure/refund
   * states, which never consumed a cohort slot.
   *
   * Used to enforce the series' max_armed_per_call. Without a check here the
   * cap was decorative — persisted at registration with no runtime consumer —
   * so a cohort could grow past what the grantor can fund or confirm in time.
   */
  /**
   * Reserve a slot ONLY if the cohort is not already full, counting and
   * inserting under one write lock.
   *
   * The cap used to be checked in the caller and the insert issued afterwards,
   * with nothing serializing the two. Concurrent buyers on a cap-1 call each
   * counted zero, each inserted a distinct subscriber (the unique index is per
   * subscriber, so it does not serialize different buyers), and the call sold
   * twice — past what the grantor budgeted to fund and confirm.
   *
   * IMMEDIATE, not deferred: the transaction must hold the write lock from the
   * start, or two readers both pass the count before either upgrades.
   *
   * Returns null when the cohort is full. A unique violation still propagates
   * — that is the same subscriber racing itself, which the caller resolves to
   * the existing row.
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
   * Record an entitlement for access the payer ALREADY holds on-chain, in one
   * transaction, without any payment.
   *
   * Reached when the chain says `alreadyGranted` but we have no row: a
   * restored-from-backup database, a manual grant, a reconciler gap. Charging
   * again would take money for access the subscriber already owns, and the
   * contract treats the duplicate grant as a successful no-op, so nothing
   * downstream would notice.
   *
   * `amount`, `currency` and `nanopay_receipt_id` stay NULL — no payment
   * happened, and fabricating a receipt would put phantom revenue in the
   * ledger. IMMEDIATE so two concurrent adoptions cannot both see no row.
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
   * Seats reserved on MANY calls, in one grouped read.
   *
   * The storefront needs this for every row it lists; calling
   * `countActiveForCall` per row made a listing page cost one query per call.
   * Same status set, same lowercase normalization, one statement.
   *
   * Keys are the LOWERCASED on-chain call ids. Calls with no reservations are
   * absent from the map, so callers must default to 0 rather than assume a key
   * exists — a missing key means "nobody has bought this", not "unknown".
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
