import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

export interface FhenixSealedCallInsert {
  call_id: string;
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  submit_tx_hash: string;
  submit_log_index: number;
  binary_index_ct_hash: string;
  confidence_ct_hash: string;
  reveal_open_at: string;
  /**
   * On-chain SubmissionClass: 1 = EarlyAccess, 2 = LateUnsellable, 0 unknown.
   * Read it here, not from the gateway attempt row: direct intake creates none.
   */
  submission_class: number | null;
  created_at: string;
  /**
   * Provider terms as sold, snapshotted at acceptance and never updated, so a reprice cannot
   * reach a bought call. NULL is either a legacy call (use the deployment price) or "not
   * selling"; `provider_terms_snapshotted` tells them apart.
   */
  provider_price_atoms?: string | null;
  provider_currency?: string | null;
  provider_pricing_version?: string | null;
  /** Owner's business ceiling as sold; murmur still clamps to deliverability. */
  provider_max_subscribers?: number | null;
  /**
   * Murmur's cut of this call in bps, frozen at the seal so a fee change cannot re-cut it.
   * Always written with provider terms; NULL means not selling, or a legacy row.
   */
  provider_fee_bps?: number | null;
  /**
   * 1 = terms were snapshotted, so a NULL price means "not selling"; 0 only on legacy rows.
   * `insert` always writes 1; optional here only for callers.
   */
  provider_terms_snapshotted?: number;
}

// `reveal_source` comes from the successful publishReveal tx sender (classifyRevealSource).
export type FhenixRevealSource =
  | "agent"
  | "daemon_fallback"
  | "unattributed_external";

export interface FhenixRevealInput {
  call_id: string;
  revealed_binary_index: 0 | 1;
  revealed_confidence: number;
  revealed_confidence_bps: number;
  revealed_at: string;
  reveal_tx_hash: string;
  reveal_log_index: number;
  reveal_block_number?: number | null;
  reveal_sender?: string | null;
  reveal_source?: FhenixRevealSource | null;
}

export type FhenixRevealStatus = "pending" | "revealed" | "invalid" | "missed";

export interface FhenixInvalidRevealInput {
  call_id: string;
  revealed_binary_index: number;
  revealed_confidence_bps: number;
  invalid_reason: string;
  revealed_at: string;
  reveal_tx_hash: string;
  reveal_log_index: number;
  reveal_block_number?: number | null;
  reveal_sender?: string | null;
  reveal_source?: FhenixRevealSource | null;
}

export type FhenixSealedCallRow = FhenixSealedCallInsert & {
  opened_at: string | null;
  reveal_status: FhenixRevealStatus;
  invalid_reason: string | null;
  terminal_at: string | null;
  submit_block_number: number | null;
  reveal_block_number: number | null;
  revealed_at: string | null;
  reveal_tx_hash: string | null;
  reveal_log_index: number | null;
  revealed_binary_index: number | null;
  revealed_confidence: number | null;
  revealed_confidence_bps: number | null;
  reveal_sender: string | null;
  reveal_source: FhenixRevealSource | null;
};

const SEALED_CALL_COLUMNS = `call_id, chain_id, contract_address, onchain_call_id,
       submit_tx_hash, submit_log_index, binary_index_ct_hash, confidence_ct_hash,
       reveal_open_at, submission_class, created_at, opened_at, revealed_at,
       reveal_tx_hash, reveal_log_index, revealed_binary_index,
       revealed_confidence, revealed_confidence_bps,
       reveal_status, invalid_reason, terminal_at,
       submit_block_number, reveal_block_number,
       reveal_sender, reveal_source,
       provider_price_atoms, provider_currency, provider_pricing_version,
       provider_max_subscribers, provider_terms_snapshotted, provider_fee_bps`;

export const fhenixSealedCallsRepo = {
  insert(db: Database.Database, input: FhenixSealedCallInsert): void {
    // Absent terms bind as NULL: an agent that does not sell early access has
    // none, and better-sqlite3 requires every named parameter to be present.
    const row = {
      provider_price_atoms: null,
      provider_currency: null,
      provider_pricing_version: null,
      provider_max_subscribers: null,
      provider_fee_bps: null,
      ...input,
    };
    prep(
      db,
      `INSERT INTO fhenix_sealed_calls
       (call_id, chain_id, contract_address, onchain_call_id,
        submit_tx_hash, submit_log_index, binary_index_ct_hash, confidence_ct_hash,
        reveal_open_at, submission_class, created_at,
        provider_price_atoms, provider_currency, provider_pricing_version,
        provider_max_subscribers, provider_terms_snapshotted, provider_fee_bps)
       VALUES
       (@call_id, @chain_id, @contract_address, @onchain_call_id,
        @submit_tx_hash, @submit_log_index, @binary_index_ct_hash, @confidence_ct_hash,
        @reveal_open_at, @submission_class, @created_at,
        @provider_price_atoms, @provider_currency, @provider_pricing_version,
        @provider_max_subscribers, 1, @provider_fee_bps)`,
    ).run(row);
  },

  byCallId(
    db: Database.Database,
    call_id: string,
  ): FhenixSealedCallRow | null {
    return (
      (prep(
        db,
        `SELECT ${SEALED_CALL_COLUMNS}
         FROM fhenix_sealed_calls
         WHERE call_id = ?`,
      ).get(call_id) as FhenixSealedCallRow | undefined) ?? null
    );
  },

  byOnchainCall(
    db: Database.Database,
    input: {
      chain_id: number;
      contract_address: string;
      onchain_call_id: string;
    },
  ): FhenixSealedCallRow | null {
    return (
      (prep(
        db,
        `SELECT ${SEALED_CALL_COLUMNS}
         FROM fhenix_sealed_calls
         WHERE chain_id = @chain_id
           AND lower(contract_address) = lower(@contract_address)
           -- Routes accept mixed-case bytes32 while indexed ids are stored
           -- lowercase; an exact compare silently returns no row.
           AND lower(onchain_call_id) = lower(@onchain_call_id)
         LIMIT 1`,
      ).get(input) as FhenixSealedCallRow | undefined) ?? null
    );
  },

  /**
   * The agent that produced an on-chain call, for revenue attribution. Acceptance writes both
   * joined rows in one transaction. Null when unknown here: treat as "cannot attribute".
   */
  producerAgentIdByOnchainCall(
    db: Database.Database,
    input: {
      chain_id: number;
      contract_address: string;
      onchain_call_id: string;
    },
  ): string | null {
    const row = prep(
      db,
      `SELECT s.agent_id AS agent_id
       FROM fhenix_sealed_calls f
       JOIN submissions s ON s.call_id = f.call_id
       WHERE f.chain_id = @chain_id
         AND lower(f.contract_address) = lower(@contract_address)
         AND lower(f.onchain_call_id) = lower(@onchain_call_id)
       LIMIT 1`,
    ).get(input) as { agent_id?: string } | undefined;
    return row?.agent_id ?? null;
  },

  attachReveal(
    db: Database.Database,
    input: FhenixRevealInput,
  ): void {
    const result = prep(
      db,
      `UPDATE fhenix_sealed_calls
       SET opened_at = COALESCE(opened_at, @revealed_at),
           revealed_at = @revealed_at,
           reveal_tx_hash = @reveal_tx_hash,
           reveal_log_index = @reveal_log_index,
           revealed_binary_index = @revealed_binary_index,
           revealed_confidence = @revealed_confidence,
           revealed_confidence_bps = @revealed_confidence_bps,
           reveal_status = 'revealed',
           invalid_reason = NULL,
           terminal_at = @revealed_at,
           reveal_block_number = @reveal_block_number,
           reveal_sender = @reveal_sender,
           reveal_source = @reveal_source
       WHERE call_id = @call_id
         AND revealed_at IS NULL
         AND reveal_status = 'pending'`,
    ).run({
      ...input,
      reveal_block_number: input.reveal_block_number ?? null,
      reveal_sender: input.reveal_sender ?? null,
      reveal_source: input.reveal_source ?? null,
    });
    if (result.changes !== 1) {
      throw new Error(`fhenix reveal attach failed for call_id=${input.call_id}`);
    }
  },

  attachInvalidReveal(
    db: Database.Database,
    input: FhenixInvalidRevealInput,
  ): void {
    const result = prep(
      db,
      `UPDATE fhenix_sealed_calls
       SET opened_at = COALESCE(opened_at, @revealed_at),
           revealed_at = @revealed_at,
           reveal_tx_hash = @reveal_tx_hash,
           reveal_log_index = @reveal_log_index,
           revealed_binary_index = @revealed_binary_index,
           revealed_confidence = NULL,
           revealed_confidence_bps = @revealed_confidence_bps,
           reveal_status = 'invalid',
           invalid_reason = @invalid_reason,
           terminal_at = @revealed_at,
           reveal_block_number = @reveal_block_number,
           reveal_sender = @reveal_sender,
           reveal_source = @reveal_source
       WHERE call_id = @call_id
         AND revealed_at IS NULL
         AND reveal_status = 'pending'`,
    ).run({
      ...input,
      reveal_block_number: input.reveal_block_number ?? null,
      reveal_sender: input.reveal_sender ?? null,
      reveal_source: input.reveal_source ?? null,
    });
    if (result.changes !== 1) {
      throw new Error(`fhenix invalid reveal attach failed for call_id=${input.call_id}`);
    }
  },

  // Fallback-worker candidates: pending calls past the grace window. SQLite only nominates;
  // the worker decides from getCall(...) at the safe head. submissions.status is not joined:
  // the public-reveal obligation survives an inconsistent internal status.
  listRevealCandidates(
    db: Database.Database,
    input: {
      chain_id: number;
      contract_address: string;
      grace_cutoff_iso: string;
      limit: number;
    },
  ): Array<{
    call_id: string;
    onchain_call_id: string;
    reveal_open_at: string;
    binary_index_ct_hash: string;
    confidence_ct_hash: string;
  }> {
    return prep(
      db,
      `SELECT call_id, onchain_call_id, reveal_open_at,
              binary_index_ct_hash, confidence_ct_hash
       FROM fhenix_sealed_calls
       WHERE chain_id = @chain_id
         AND lower(contract_address) = lower(@contract_address)
         AND reveal_status = 'pending'
         AND revealed_at IS NULL
         AND reveal_open_at <= @grace_cutoff_iso
       ORDER BY reveal_open_at
       LIMIT @limit`,
    ).all(input) as Array<{
      call_id: string;
      onchain_call_id: string;
      reveal_open_at: string;
      binary_index_ct_hash: string;
      confidence_ct_hash: string;
    }>;
  },

  markMissedReveal(
    db: Database.Database,
    input: { call_id: string; terminal_at: string; invalid_reason: string },
  ): boolean {
    const result = prep(
      db,
      `UPDATE fhenix_sealed_calls
       SET reveal_status = 'missed',
           invalid_reason = @invalid_reason,
           terminal_at = @terminal_at
       WHERE call_id = @call_id
         AND reveal_status = 'pending'
         AND revealed_at IS NULL`,
    ).run(input);
    return result.changes === 1;
  },

  listMissable(
    db: Database.Database,
    cutoffIso: string,
    limit = 500,
  ): Array<{ call_id: string; agent_id: string; reveal_open_at: string }> {
    return prep(
      db,
      `SELECT f.call_id, s.agent_id, f.reveal_open_at
       FROM fhenix_sealed_calls f
       JOIN submissions s ON s.call_id = f.call_id
       WHERE f.reveal_status = 'pending'
         AND f.revealed_at IS NULL
         AND f.reveal_open_at <= ?
         AND s.status IN ('accepted','pending_t0','pending_t1')
       ORDER BY f.reveal_open_at
       LIMIT ?`,
    ).all(cutoffIso, limit) as Array<{ call_id: string; agent_id: string; reveal_open_at: string }>;
  },
};
