import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

// Fallback reveal worker state machine, feed lane: one row per sealed feed packet it owns; the
// phase is the crash-recovery boundary. Separate table from the call lane (whose key is an FK
// into fhenix_sealed_calls), but one shared worker, signer and nonce manager drive both.
export type FeedPacketRevealJobPhase =
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

export type FeedPacketRevealJobAlertLevel = "warn" | "escalate" | null;

export const TERMINAL_FEED_REVEAL_JOB_PHASES: readonly FeedPacketRevealJobPhase[] =
  ["terminal_daemon", "terminal_external"];

export interface FeedPacketRevealJobRow {
  packet_id: string;
  chain_id: number;
  contract_address: string;
  onchain_packet_id: string;
  reveal_after: string;
  phase: FeedPacketRevealJobPhase;
  open_tx_hash: string | null;
  open_block_number: number | null;
  publish_tx_hash: string | null;
  publish_block_number: number | null;
  tx_broadcast_at: string | null;
  action_value: number | null;
  action_signature: string | null;
  signal_bps_value: number | null;
  signal_bps_signature: string | null;
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  alert_level: FeedPacketRevealJobAlertLevel;
  first_eligible_at: string;
  created_at: string;
  updated_at: string;
}

export interface FeedPacketRevealJobSeed {
  packet_id: string;
  chain_id: number;
  contract_address: string;
  onchain_packet_id: string;
  reveal_after: string;
  now: string;
}

export interface FeedPacketRevealJobPatch {
  phase: FeedPacketRevealJobPhase;
  open_tx_hash?: string | null;
  open_block_number?: number | null;
  publish_tx_hash?: string | null;
  publish_block_number?: number | null;
  tx_broadcast_at?: string | null;
  action_value?: number | null;
  action_signature?: string | null;
  signal_bps_value?: number | null;
  signal_bps_signature?: string | null;
  attempt_count?: number | null;
  next_attempt_at?: string | null;
  last_error?: string | null;
  alert_level?: FeedPacketRevealJobAlertLevel;
  now: string;
}

const JOB_COLUMNS = `packet_id, chain_id, contract_address, onchain_packet_id,
       reveal_after, phase, open_tx_hash, open_block_number,
       publish_tx_hash, publish_block_number, tx_broadcast_at,
       action_value, action_signature,
       signal_bps_value, signal_bps_signature,
       attempt_count, next_attempt_at, last_error, alert_level,
       first_eligible_at, created_at, updated_at`;

export const feedPacketRevealJobsRepo = {
  // Idempotent seed: re-running a tick must not reset an in-flight phase.
  ensure(db: Database.Database, seed: FeedPacketRevealJobSeed): void {
    prep(
      db,
      `INSERT OR IGNORE INTO fhenix_feed_packet_reveal_jobs
         (packet_id, chain_id, contract_address, onchain_packet_id, reveal_after,
          phase, attempt_count, next_attempt_at, first_eligible_at,
          created_at, updated_at)
       VALUES
         (@packet_id, @chain_id, @contract_address, @onchain_packet_id, @reveal_after,
          'eligible', 0, @now, @now, @now, @now)`,
    ).run(seed);
  },

  byPacketId(db: Database.Database, packetId: string): FeedPacketRevealJobRow | null {
    return (
      (prep(
        db,
        `SELECT ${JOB_COLUMNS} FROM fhenix_feed_packet_reveal_jobs WHERE packet_id = ?`,
      ).get(packetId) as FeedPacketRevealJobRow | undefined) ?? null
    );
  },

  // Scoped to one contract so an old deployment's job is never returned.
  listDue(
    db: Database.Database,
    input: {
      chain_id: number;
      contract_address: string;
      now: string;
      limit: number;
    },
  ): FeedPacketRevealJobRow[] {
    return prep(
      db,
      `SELECT ${JOB_COLUMNS}
       FROM fhenix_feed_packet_reveal_jobs
       WHERE phase NOT IN ('terminal_daemon','terminal_external')
         AND chain_id = @chain_id
         AND lower(contract_address) = lower(@contract_address)
         AND next_attempt_at <= @now
       ORDER BY next_attempt_at
       LIMIT @limit`,
    ).all(input) as FeedPacketRevealJobRow[];
  },

  // Worker-health scan: still-unrevealed packets past the warn/escalate age.
  // Never terminalizes — a packet stays revealable indefinitely.
  listNonTerminalOlderThan(
    db: Database.Database,
    input: {
      chain_id: number;
      contract_address: string;
      reveal_after_before: string;
      limit: number;
    },
  ): FeedPacketRevealJobRow[] {
    return prep(
      db,
      `SELECT ${JOB_COLUMNS}
       FROM fhenix_feed_packet_reveal_jobs
       WHERE phase NOT IN ('terminal_daemon','terminal_external')
         AND chain_id = @chain_id
         AND lower(contract_address) = lower(@contract_address)
         AND reveal_after <= @reveal_after_before
       ORDER BY reveal_after
       LIMIT @limit`,
    ).all(input) as FeedPacketRevealJobRow[];
  },

  // COALESCE on every carried field: a patch names the phase it is moving to
  // and only the columns it learned, so a later transition cannot blank an
  // earlier tx hash or a partially-collected decrypt result.
  update(
    db: Database.Database,
    packetId: string,
    patch: FeedPacketRevealJobPatch,
  ): void {
    prep(
      db,
      `UPDATE fhenix_feed_packet_reveal_jobs SET
         phase = @phase,
         open_tx_hash = COALESCE(@open_tx_hash, open_tx_hash),
         open_block_number = COALESCE(@open_block_number, open_block_number),
         publish_tx_hash = COALESCE(@publish_tx_hash, publish_tx_hash),
         publish_block_number = COALESCE(@publish_block_number, publish_block_number),
         tx_broadcast_at = COALESCE(@tx_broadcast_at, tx_broadcast_at),
         action_value = COALESCE(@action_value, action_value),
         action_signature = COALESCE(@action_signature, action_signature),
         signal_bps_value = COALESCE(@signal_bps_value, signal_bps_value),
         signal_bps_signature = COALESCE(@signal_bps_signature, signal_bps_signature),
         attempt_count = COALESCE(@attempt_count, attempt_count),
         next_attempt_at = COALESCE(@next_attempt_at, next_attempt_at),
         last_error = @last_error,
         alert_level = @alert_level,
         updated_at = @now
       WHERE packet_id = @packet_id`,
    ).run({
      packet_id: packetId,
      phase: patch.phase,
      open_tx_hash: patch.open_tx_hash ?? null,
      open_block_number: patch.open_block_number ?? null,
      publish_tx_hash: patch.publish_tx_hash ?? null,
      publish_block_number: patch.publish_block_number ?? null,
      tx_broadcast_at: patch.tx_broadcast_at ?? null,
      action_value: patch.action_value ?? null,
      action_signature: patch.action_signature ?? null,
      signal_bps_value: patch.signal_bps_value ?? null,
      signal_bps_signature: patch.signal_bps_signature ?? null,
      attempt_count: patch.attempt_count ?? null,
      next_attempt_at: patch.next_attempt_at ?? null,
      last_error: patch.last_error ?? null,
      alert_level: patch.alert_level ?? null,
      now: patch.now,
    });
  },

  counts(db: Database.Database): Record<FeedPacketRevealJobPhase, number> {
    const rows = prep(
      db,
      `SELECT phase, COUNT(*) AS n
       FROM fhenix_feed_packet_reveal_jobs GROUP BY phase`,
    ).all() as Array<{ phase: FeedPacketRevealJobPhase; n: number }>;
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
    } as Record<FeedPacketRevealJobPhase, number>;
    for (const row of rows) out[row.phase] = row.n;
    return out;
  },
};
