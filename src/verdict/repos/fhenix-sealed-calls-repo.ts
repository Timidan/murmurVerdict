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
  created_at: string;
}

// Normalized reveal attribution (migration 057). `reveal_source` is derived
// from the successful publishReveal tx `from` — see classifyRevealSource in
// src/verdict/fhenix-reveal-attribution.ts.
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
       reveal_open_at, created_at, opened_at, revealed_at,
       reveal_tx_hash, reveal_log_index, revealed_binary_index,
       revealed_confidence, revealed_confidence_bps,
       reveal_status, invalid_reason, terminal_at,
       submit_block_number, reveal_block_number,
       reveal_sender, reveal_source`;

export const fhenixSealedCallsRepo = {
  insert(db: Database.Database, input: FhenixSealedCallInsert): void {
    prep(
      db,
      `INSERT INTO fhenix_sealed_calls
       (call_id, chain_id, contract_address, onchain_call_id,
        submit_tx_hash, submit_log_index, binary_index_ct_hash, confidence_ct_hash,
        reveal_open_at, created_at)
       VALUES
       (@call_id, @chain_id, @contract_address, @onchain_call_id,
        @submit_tx_hash, @submit_log_index, @binary_index_ct_hash, @confidence_ct_hash,
        @reveal_open_at, @created_at)`,
    ).run(input);
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
           AND contract_address = @contract_address
           AND onchain_call_id = @onchain_call_id
         LIMIT 1`,
      ).get(input) as FhenixSealedCallRow | undefined) ?? null
    );
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

  // Fallback-worker candidate set: pending calls whose agent grace window has
  // elapsed at the confirmed safe head. SQLite only NOMINATES candidates — the
  // worker decides the action from getCall(...) at the safe head (verifying the
  // stored ct handles), never from these columns. `submissions.status` is NOT
  // joined here: the public-reveal obligation survives an inconsistent internal
  // status (Codex review §1).
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
