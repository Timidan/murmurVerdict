import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

// Durable state machine for the murmur-owned fallback reveal worker. Exactly
// ONE row per sealed call the worker has taken responsibility for; the phase
// column is the crash-recovery boundary so a restart never re-opens or
// re-publishes a call whose tx receipt was lost. See
// src/integrations/fhenix-reveal-worker.ts for the transition logic and
// contracts/src/MurmurSealedVerdicts.sol for the on-chain CallState this
// mirrors.
export type FhenixRevealJobPhase =
  | "eligible"
  | "open_tx_pending"
  | "opened_confirmed"
  | "decrypt_pending"
  | "partially_decrypted"
  | "ready_to_publish"
  | "publish_tx_pending"
  | "quarantined"
  | "terminal_daemon"
  | "terminal_external";

export type FhenixRevealJobAlertLevel = "warn" | "escalate" | null;

// Phases the worker never acts on again — the call reached a terminal on-chain
// reveal (by us or by anyone else). Non-terminal jobs are the due-work set.
export const TERMINAL_REVEAL_JOB_PHASES: readonly FhenixRevealJobPhase[] = [
  "terminal_daemon",
  "terminal_external",
];

export interface FhenixRevealJobRow {
  call_id: string;
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  reveal_open_at: string;
  phase: FhenixRevealJobPhase;
  open_tx_hash: string | null;
  open_block_number: number | null;
  publish_tx_hash: string | null;
  publish_block_number: number | null;
  // Wall-clock (ISO) the currently-pending open/publish tx was broadcast. The
  // worker re-broadcasts once this goes stale so a dropped / nonce-gapped tx
  // (which never yields a receipt) self-heals instead of stranding the call.
  tx_broadcast_at: string | null;
  binary_index_value: number | null;
  binary_index_signature: string | null;
  confidence_value: number | null;
  confidence_signature: string | null;
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  alert_level: FhenixRevealJobAlertLevel;
  first_eligible_at: string;
  created_at: string;
  updated_at: string;
}

const JOB_COLUMNS = `call_id, chain_id, contract_address, onchain_call_id,
       reveal_open_at, phase, open_tx_hash, open_block_number,
       publish_tx_hash, publish_block_number, tx_broadcast_at,
       binary_index_value, binary_index_signature,
       confidence_value, confidence_signature,
       attempt_count, next_attempt_at, last_error, alert_level,
       first_eligible_at, created_at, updated_at`;

export interface FhenixRevealJobSeed {
  call_id: string;
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  reveal_open_at: string;
  now: string;
}

// Mutable fields a phase transition may touch. `phase` is required so every
// write records the state; everything else is optional and only overwrites
// when provided (SQLite COALESCE keeps the prior value for undefined fields).
export interface FhenixRevealJobPatch {
  phase: FhenixRevealJobPhase;
  open_tx_hash?: string | null;
  open_block_number?: number | null;
  publish_tx_hash?: string | null;
  publish_block_number?: number | null;
  tx_broadcast_at?: string | null;
  binary_index_value?: number | null;
  binary_index_signature?: string | null;
  confidence_value?: number | null;
  confidence_signature?: string | null;
  next_attempt_at?: string;
  last_error?: string | null;
  alert_level?: FhenixRevealJobAlertLevel;
  attempt_count?: number;
  now: string;
}

export const fhenixRevealJobsRepo = {
  // Idempotent claim of a candidate. INSERT OR IGNORE so a candidate already
  // being processed (row exists) is never reset to `eligible`.
  ensure(db: Database.Database, seed: FhenixRevealJobSeed): void {
    prep(
      db,
      `INSERT OR IGNORE INTO fhenix_reveal_jobs
         (call_id, chain_id, contract_address, onchain_call_id, reveal_open_at,
          phase, attempt_count, next_attempt_at, first_eligible_at,
          created_at, updated_at)
       VALUES
         (@call_id, @chain_id, @contract_address, @onchain_call_id, @reveal_open_at,
          'eligible', 0, @now, @now, @now, @now)`,
    ).run(seed);
  },

  byCallId(db: Database.Database, callId: string): FhenixRevealJobRow | null {
    return (
      (prep(
        db,
        `SELECT ${JOB_COLUMNS} FROM fhenix_reveal_jobs WHERE call_id = ?`,
      ).get(callId) as FhenixRevealJobRow | undefined) ?? null
    );
  },

  // Due, non-terminal jobs ordered by next_attempt_at. Single write-enabled
  // process per reveal EOA (documented) means no lease is required for
  // correctness; the on-chain WrongState guard is the real safety boundary.
  listDue(
    db: Database.Database,
    input: { now: string; limit: number },
  ): FhenixRevealJobRow[] {
    return prep(
      db,
      `SELECT ${JOB_COLUMNS}
       FROM fhenix_reveal_jobs
       WHERE phase NOT IN ('terminal_daemon','terminal_external')
         AND next_attempt_at <= @now
       ORDER BY next_attempt_at
       LIMIT @limit`,
    ).all(input) as FhenixRevealJobRow[];
  },

  // Non-terminal jobs whose reveal_open_at is older than the cutoff — the
  // worker-health scanner reads this to raise graduated operator alerts
  // without ever terminalizing the (still-revealable) call.
  listNonTerminalOlderThan(
    db: Database.Database,
    input: { reveal_open_before: string; limit: number },
  ): FhenixRevealJobRow[] {
    return prep(
      db,
      `SELECT ${JOB_COLUMNS}
       FROM fhenix_reveal_jobs
       WHERE phase NOT IN ('terminal_daemon','terminal_external')
         AND reveal_open_at <= @reveal_open_before
       ORDER BY reveal_open_at
       LIMIT @limit`,
    ).all(input) as FhenixRevealJobRow[];
  },

  update(db: Database.Database, callId: string, patch: FhenixRevealJobPatch): void {
    prep(
      db,
      `UPDATE fhenix_reveal_jobs SET
         phase = @phase,
         open_tx_hash = COALESCE(@open_tx_hash, open_tx_hash),
         open_block_number = COALESCE(@open_block_number, open_block_number),
         publish_tx_hash = COALESCE(@publish_tx_hash, publish_tx_hash),
         publish_block_number = COALESCE(@publish_block_number, publish_block_number),
         tx_broadcast_at = COALESCE(@tx_broadcast_at, tx_broadcast_at),
         binary_index_value = COALESCE(@binary_index_value, binary_index_value),
         binary_index_signature = COALESCE(@binary_index_signature, binary_index_signature),
         confidence_value = COALESCE(@confidence_value, confidence_value),
         confidence_signature = COALESCE(@confidence_signature, confidence_signature),
         attempt_count = COALESCE(@attempt_count, attempt_count),
         next_attempt_at = COALESCE(@next_attempt_at, next_attempt_at),
         last_error = @last_error,
         alert_level = @alert_level,
         updated_at = @now
       WHERE call_id = @call_id`,
    ).run({
      call_id: callId,
      phase: patch.phase,
      open_tx_hash: patch.open_tx_hash ?? null,
      open_block_number: patch.open_block_number ?? null,
      publish_tx_hash: patch.publish_tx_hash ?? null,
      publish_block_number: patch.publish_block_number ?? null,
      tx_broadcast_at: patch.tx_broadcast_at ?? null,
      binary_index_value: patch.binary_index_value ?? null,
      binary_index_signature: patch.binary_index_signature ?? null,
      confidence_value: patch.confidence_value ?? null,
      confidence_signature: patch.confidence_signature ?? null,
      attempt_count: patch.attempt_count ?? null,
      next_attempt_at: patch.next_attempt_at ?? null,
      last_error: patch.last_error ?? null,
      alert_level: patch.alert_level ?? null,
      now: patch.now,
    });
  },

  counts(db: Database.Database): Record<FhenixRevealJobPhase, number> {
    const rows = prep(
      db,
      `SELECT phase, COUNT(*) AS n FROM fhenix_reveal_jobs GROUP BY phase`,
    ).all() as Array<{ phase: FhenixRevealJobPhase; n: number }>;
    const out = {
      eligible: 0,
      open_tx_pending: 0,
      opened_confirmed: 0,
      decrypt_pending: 0,
      partially_decrypted: 0,
      ready_to_publish: 0,
      publish_tx_pending: 0,
      quarantined: 0,
      terminal_daemon: 0,
      terminal_external: 0,
    } as Record<FhenixRevealJobPhase, number>;
    for (const row of rows) out[row.phase] = row.n;
    return out;
  },
};
