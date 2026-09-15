import type Database from "better-sqlite3";

import { nowIso } from "../time.js";

/**
 * payer and source_domain must be lowercased before insert AND lookup, or a
 * case variant slips past the prefix UNIQUE and breaks replay detection. Both
 * carry case-insensitive EVM addresses.
 */
function normalizePayer(payer: string): string {
  return payer.toLowerCase();
}

function normalizeSourceDomain(sourceDomain: string): string {
  return sourceDomain.toLowerCase();
}

/**
 * Receipts for POST /v2/nanopay/infer: idempotency key, status machine, Fhenix anchor binding.
 * insertSettlingIntent writes BEFORE Circle /settle, so a crash leaves a row to reconcile.
 * `payment_handle` holds the signed nonce; Circle's transaction UUID has its own column.
 */
export interface NanopayReceiptRow {
  readonly id: number;
  readonly payer: string;
  readonly payment_handle: string;
  readonly source_domain: string;
  readonly payment_payload_hash: string;
  readonly payment_requirements_hash: string;
  readonly status: "settling" | "settled" | "failed" | "settlement_unknown";
  readonly circle_transaction_uuid: string | null;
  readonly pipeline_id: string;
  readonly request_signal_id: string;
  readonly paid_amount_usdc_atoms: string;
  readonly binding_json: string;
  readonly reveal_artifact_json: string | null;
  readonly created_at: string;
  readonly settled_at: string | null;
  readonly failed_at: string | null;
  readonly failure_reason: string | null;
}

export interface InsertSettlingIntentInput {
  readonly payer: string;
  readonly paymentHandle: string;
  readonly sourceDomain: string;
  readonly paymentPayloadHash: string;
  readonly paymentRequirementsHash: string;
  readonly pipelineId: string;
  readonly requestSignalId: string;
  readonly paidAmountUsdcAtoms: string;
  readonly bindingJson: string;
  readonly revealArtifactJson: string | null;
  readonly createdAt: Date;
}

/** Legacy import of an already-settled payment. The live rail uses insertSettlingIntent + markSettled. */
export interface InsertSettledInput {
  readonly payer: string;
  readonly paymentHandle: string;
  readonly sourceDomain: string;
  readonly paymentPayloadHash: string;
  readonly paymentRequirementsHash: string;
  readonly pipelineId: string;
  readonly requestSignalId: string;
  readonly paidAmountUsdcAtoms: string;
  readonly bindingJson: string;
  readonly revealArtifactJson: string | null;
  readonly circleTransactionUuid: string;
  readonly settledAt: Date;
}

export interface MarkSettledInput {
  readonly id: number;
  readonly circleTransactionUuid: string;
  /** Final binding with the Circle transaction UUID filled in. */
  readonly bindingJson: string;
  /** Set only if reveal was open at settle time; otherwise null. */
  readonly revealArtifactJson: string | null;
  readonly settledAt: Date;
}

export interface MarkFailedInput {
  readonly id: number;
  readonly reason: string;
  readonly failedAt: Date;
}

const COLUMNS = `id, payer, payment_handle, source_domain, payment_payload_hash,
       payment_requirements_hash, status, circle_transaction_uuid, pipeline_id,
       request_signal_id, paid_amount_usdc_atoms, binding_json,
       reveal_artifact_json, created_at, settled_at, failed_at, failure_reason`;

export const nanopayReceiptsRepo = {
  /**
   * Insert as `settling` BEFORE Circle /settle. A racing identical insert throws
   * SQLITE_CONSTRAINT_UNIQUE; the route resolves it via findByCompositeKey. Returns the id.
   */
  insertSettlingIntent(db: Database.Database, input: InsertSettlingIntentInput): number {
    const stmt = db.prepare(`
      INSERT INTO nanopay_receipts (
        payer, payment_handle, source_domain, payment_payload_hash,
        payment_requirements_hash, status, circle_transaction_uuid,
        pipeline_id, request_signal_id, paid_amount_usdc_atoms,
        binding_json, reveal_artifact_json,
        created_at, settled_at, failed_at, failure_reason
      ) VALUES (
        @payer, @payment_handle, @source_domain, @payment_payload_hash,
        @payment_requirements_hash, 'settling', NULL,
        @pipeline_id, @request_signal_id, @paid_amount_usdc_atoms,
        @binding_json, @reveal_artifact_json,
        @created_at, NULL, NULL, NULL
      )
    `);
    const result = stmt.run({
      payer: normalizePayer(input.payer),
      payment_handle: input.paymentHandle,
      source_domain: normalizeSourceDomain(input.sourceDomain),
      payment_payload_hash: input.paymentPayloadHash,
      payment_requirements_hash: input.paymentRequirementsHash,
      pipeline_id: input.pipelineId,
      request_signal_id: input.requestSignalId,
      paid_amount_usdc_atoms: input.paidAmountUsdcAtoms,
      binding_json: input.bindingJson,
      reveal_artifact_json: input.revealArtifactJson,
      created_at: nowIso(input.createdAt),
    });
    return Number(result.lastInsertRowid);
  },

  /**
   * Insert directly as `settled`, for legacy imports only. A duplicate prefix throws
   * SQLITE_CONSTRAINT_UNIQUE; re-read via findByPayerHandleDomain.
   */
  insertSettled(db: Database.Database, input: InsertSettledInput): number {
    const settledAt = nowIso(input.settledAt);
    const stmt = db.prepare(`
      INSERT INTO nanopay_receipts (
        payer, payment_handle, source_domain, payment_payload_hash,
        payment_requirements_hash, status, circle_transaction_uuid,
        pipeline_id, request_signal_id, paid_amount_usdc_atoms,
        binding_json, reveal_artifact_json,
        created_at, settled_at, failed_at, failure_reason
      ) VALUES (
        @payer, @payment_handle, @source_domain, @payment_payload_hash,
        @payment_requirements_hash, 'settled', @circle_transaction_uuid,
        @pipeline_id, @request_signal_id, @paid_amount_usdc_atoms,
        @binding_json, @reveal_artifact_json,
        @created_at, @settled_at, NULL, NULL
      )
    `);
    const result = stmt.run({
      payer: normalizePayer(input.payer),
      payment_handle: input.paymentHandle,
      source_domain: normalizeSourceDomain(input.sourceDomain),
      payment_payload_hash: input.paymentPayloadHash,
      payment_requirements_hash: input.paymentRequirementsHash,
      circle_transaction_uuid: input.circleTransactionUuid,
      pipeline_id: input.pipelineId,
      request_signal_id: input.requestSignalId,
      paid_amount_usdc_atoms: input.paidAmountUsdcAtoms,
      binding_json: input.bindingJson,
      reveal_artifact_json: input.revealArtifactJson,
      created_at: settledAt,
      settled_at: settledAt,
    });
    return Number(result.lastInsertRowid);
  },

  /**
   * `settling` → `settled`. Conditional on status, so a late reconciler cannot re-settle.
   * Throws if no row changed; the caller should re-read.
   */
  markSettled(db: Database.Database, input: MarkSettledInput): void {
    const stmt = db.prepare(`
      UPDATE nanopay_receipts
      SET status = 'settled',
          circle_transaction_uuid = @circle_transaction_uuid,
          binding_json = @binding_json,
          reveal_artifact_json = COALESCE(@reveal_artifact_json, reveal_artifact_json),
          settled_at = @settled_at
      WHERE id = @id AND status = 'settling'
    `);
    const result = stmt.run({
      id: input.id,
      circle_transaction_uuid: input.circleTransactionUuid,
      binding_json: input.bindingJson,
      reveal_artifact_json: input.revealArtifactJson,
      settled_at: nowIso(input.settledAt),
    });
    if (result.changes === 0) {
      throw new Error(
        `nanopay_receipts.markSettled: row ${input.id} not in 'settling' state (concurrent reconciler or duplicate transition)`,
      );
    }
  },

  /** `settling` → `failed`. Conditional on status, so a settled row is never marked failed. */
  markFailed(db: Database.Database, input: MarkFailedInput): void {
    const stmt = db.prepare(`
      UPDATE nanopay_receipts
      SET status = 'failed',
          failed_at = @failed_at,
          failure_reason = @failure_reason
      WHERE id = @id AND status = 'settling'
    `);
    const result = stmt.run({
      id: input.id,
      failed_at: nowIso(input.failedAt),
      failure_reason: input.reason,
    });
    if (result.changes === 0) {
      throw new Error(
        `nanopay_receipts.markFailed: row ${input.id} not in 'settling' state`,
      );
    }
  },

  /** Exact composite-key lookup; a `settled` hit is served as a cached replay. */
  findByCompositeKey(
    db: Database.Database,
    key: {
      payer: string;
      paymentHandle: string;
      sourceDomain: string;
      paymentPayloadHash: string;
      paymentRequirementsHash: string;
    },
  ): NanopayReceiptRow | null {
    const stmt = db.prepare(`
      SELECT ${COLUMNS}
      FROM nanopay_receipts
      WHERE payer = @payer
        AND payment_handle = @payment_handle
        AND source_domain = @source_domain
        AND payment_payload_hash = @payment_payload_hash
        AND payment_requirements_hash = @payment_requirements_hash
    `);
    const row = stmt.get({
      payer: normalizePayer(key.payer),
      payment_handle: key.paymentHandle,
      source_domain: normalizeSourceDomain(key.sourceDomain),
      payment_payload_hash: key.paymentPayloadHash,
      payment_requirements_hash: key.paymentRequirementsHash,
    }) as NanopayReceiptRow | undefined;
    return row ?? null;
  },

  /**
   * Pre-settle lookup by the UNIQUE prefix (payer, payment_handle, source_domain).
   * Same hashes → cached replay; different → 409, never call /settle again.
   * No row → insert the settling intent; on SQLITE_CONSTRAINT_UNIQUE, re-read here.
   */
  findByPayerHandleDomain(
    db: Database.Database,
    key: { payer: string; paymentHandle: string; sourceDomain: string },
  ): NanopayReceiptRow | null {
    const stmt = db.prepare(`
      SELECT ${COLUMNS}
      FROM nanopay_receipts
      WHERE payer = @payer
        AND payment_handle = @payment_handle
        AND source_domain = @source_domain
    `);
    const row = stmt.get({
      payer: normalizePayer(key.payer),
      payment_handle: key.paymentHandle,
      source_domain: normalizeSourceDomain(key.sourceDomain),
    }) as NanopayReceiptRow | undefined;
    return row ?? null;
  },

  findById(db: Database.Database, id: number): NanopayReceiptRow | null {
    const stmt = db.prepare(`
      SELECT ${COLUMNS}
      FROM nanopay_receipts
      WHERE id = @id
    `);
    return (stmt.get({ id }) as NanopayReceiptRow | undefined) ?? null;
  },
} as const;
