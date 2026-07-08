import type Database from "better-sqlite3";

import { nowIso } from "../time.js";

/**
 * Per codex audit 2026-05-23: payer and source_domain identifiers
 * must be normalized to lowercase before insert AND lookup so case
 * variants don't bypass the prefix UNIQUE / break replay detection.
 * Payer addresses are EVM 0x... strings (case-insensitive); the
 * source_domain is `chainId:contractAddress` and the contract
 * address part is also case-insensitive.
 */
function normalizePayer(payer: string): string {
  return payer.toLowerCase();
}

function normalizeSourceDomain(sourceDomain: string): string {
  return sourceDomain.toLowerCase();
}

/**
 * Wave L.A — Nanopayments via Circle Gateway middleware. Receipts repo.
 *
 * Persists the composite idempotency key, status state machine, and
 * full Fhenix anchor binding for every paid-inference call served via
 * the `POST /v2/nanopay/infer` rail.
 *
 * Design notes:
 *   - Phase 1: docs/superpowers/specs/2026-05-23-wave-l-a-nanopayments-design.md
 *   - Phase 1b (this file's payment_handle rename):
 *     docs/superpowers/specs/2026-05-24-wave-l-a-phase-1b-design.md
 *
 * Phase 1 (testnet MVP) responsibilities:
 *   - insertSettlingIntent: write row BEFORE calling Circle /settle so
 *     a crash mid-settle leaves a row to reconcile.
 *   - markSettled: transition settling → settled, persist Circle's
 *     transaction UUID + reveal artifact (if reveal already open).
 *   - markFailed: transition settling → failed.
 *   - findByCompositeKey: exact composite-key lookup (cached-response
 *     path on replay).
 *   - findByPayerHandleDomain: partial-key lookup for pre-settle
 *     conflict detection (returns 0 or 1 row).
 *
 * Phase 3 will add:
 *   - findStuckSettlingOlderThan: reconciliation cron query.
 *   - markSettlementUnknown: terminal state after N failed reconciles.
 *   - patchRevealArtifact: update reveal_artifact_json when horizon opens.
 *
 * Phase 1b naming note: the column historically called `eip3009_nonce`
 * was renamed to `payment_handle` in migration v52 because the SDK
 * middleware consumes + verifies the EIP-3009 nonce before the daemon
 * handler runs — what we actually store is Circle's transaction UUID
 * (the "payment handle" / settlement handle). The repo's TypeScript
 * surface uses `paymentHandle` to match. The `NanopayBinding` wire
 * field returned in the route response keeps the legacy
 * `eip3009Nonce` name for backwards compatibility with any buyer that
 * already parses it; renaming the wire field is deferred to Phase 2.
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

/**
 * Insert directly in `settled` state — used by the SDK-pivot flow
 * where Circle's middleware verify+settle has already completed
 * before the row is written. Carries the Circle transaction UUID
 * up-front instead of marking it later.
 */
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
   * Insert a row in `settling` state BEFORE calling Circle /settle.
   * The composite UNIQUE index guards against double-insert under
   * race; concurrent insert of an identical composite key will throw
   * SQLITE_CONSTRAINT_UNIQUE, which the route layer must catch and
   * resolve via findByCompositeKey (treat as a same-payload replay).
   *
   * Returns the inserted row id.
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
   * Insert directly in `settled` state — for the SDK-pivot Phase 1
   * flow where Circle Gateway's middleware has already verified +
   * settled the payment before the row is written. Avoids the
   * awkward insertSettlingIntent → markSettled round-trip that
   * codex audit 2026-05-23 flagged as semantically misleading.
   *
   * Same race safety as `insertSettlingIntent`: the schema's prefix
   * UNIQUE on (payer, payment_handle, source_domain) prevents
   * duplicate rows; concurrent identical inserts throw
   * SQLITE_CONSTRAINT_UNIQUE and the caller should re-read via
   * `findByPayerHandleDomain` to serve cached.
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
   * Transition `settling` → `settled`. Persists Circle's transaction
   * UUID and (optionally) the reveal artifact if the sealed-Fhenix
   * horizon was already open at settle time.
   *
   * Conditional UPDATE on status='settling' prevents accidentally
   * re-settling an already-settled or failed row (e.g. a delayed
   * reconciler hit after the route handler already finalized state).
   *
   * Throws if no row updated (caller should re-read state).
   */
  markSettled(db: Database.Database, input: MarkSettledInput): void {
    const stmt = db.prepare(`
      UPDATE nanopay_receipts
      SET status = 'settled',
          circle_transaction_uuid = @circle_transaction_uuid,
          reveal_artifact_json = COALESCE(@reveal_artifact_json, reveal_artifact_json),
          settled_at = @settled_at
      WHERE id = @id AND status = 'settling'
    `);
    const result = stmt.run({
      id: input.id,
      circle_transaction_uuid: input.circleTransactionUuid,
      reveal_artifact_json: input.revealArtifactJson,
      settled_at: nowIso(input.settledAt),
    });
    if (result.changes === 0) {
      throw new Error(
        `nanopay_receipts.markSettled: row ${input.id} not in 'settling' state (concurrent reconciler or duplicate transition)`,
      );
    }
  },

  /**
   * Transition `settling` → `failed`. Records the failure reason
   * (Circle 4xx body, network error, etc.) for operator diagnostics.
   *
   * Conditional UPDATE on status='settling' prevents marking an
   * already-settled row as failed.
   */
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

  /**
   * Exact composite-key lookup. Returns the row if a replay-equivalent
   * settlement attempt was previously recorded. Route handler returns
   * a cached response when this returns a `settled` row.
   */
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
   * Partial-key lookup used by the pre-settle conflict-detection step.
   * Returns the unique row matching (payer, payment_handle, source_domain)
   * if one exists, else null.
   *
   * Per the v52 migration, `(payer, payment_handle, source_domain)` is
   * UNIQUE in the schema. So at most one row exists for any prefix.
   * The route handler:
   *   1. Calls this to find the existing row (if any).
   *   2. Compares payment_payload_hash + payment_requirements_hash:
   *      - identical → cached-replay branch (return cached response).
   *      - different → 409 Conflict (do NOT call Circle /settle again).
   *   3. If no row, INSERT settling_intent (may race; catch SQLITE_CONSTRAINT_UNIQUE
   *      and re-read via this helper to resolve).
   *
   * Codex audit 2026-05-23 corrected the v1 comment claiming the
   * composite UNIQUE alone prevented prefix conflicts — it doesn't;
   * the schema now has a separate prefix UNIQUE that does.
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

  /**
   * Debug/admin: read a single row by id. Phase 1 uses this in
   * integration tests; Phase 3 reconciler will use it after find-stuck
   * lookups.
   */
  findById(db: Database.Database, id: number): NanopayReceiptRow | null {
    const stmt = db.prepare(`
      SELECT ${COLUMNS}
      FROM nanopay_receipts
      WHERE id = @id
    `);
    return (stmt.get({ id }) as NanopayReceiptRow | undefined) ?? null;
  },
} as const;
