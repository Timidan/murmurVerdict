import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import {
  fhenixEventPayloadJson,
  type FhenixEventPayload,
} from "../fhenix-event-index.js";

export interface FhenixIndexedEventInput {
  chain_id: number;
  contract_address: string;
  event_name: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_hash: string | null;
  payload: FhenixEventPayload;
  observed_at: string;
}

export interface FhenixIndexedEventRow {
  event_name: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_hash: string | null;
  payload: FhenixEventPayload;
}

export const fhenixEventsRepo = {
  upsertEvent(db: Database.Database, input: FhenixIndexedEventInput): void {
    prep(
      db,
      `INSERT INTO fhenix_events
       (chain_id, contract_address, event_name, tx_hash, log_index,
        block_number, block_hash, payload_json, observed_at)
       VALUES
       (@chain_id, @contract_address, @event_name, @tx_hash, @log_index,
        @block_number, @block_hash, @payload_json, @observed_at)
       ON CONFLICT(chain_id, tx_hash, log_index) DO UPDATE SET
        contract_address = excluded.contract_address,
        event_name = excluded.event_name,
        block_number = excluded.block_number,
        block_hash = excluded.block_hash,
        payload_json = excluded.payload_json,
        observed_at = excluded.observed_at`,
    ).run({
      chain_id: input.chain_id,
      contract_address: input.contract_address,
      event_name: input.event_name,
      tx_hash: input.tx_hash,
      log_index: input.log_index,
      block_number: input.block_number,
      block_hash: input.block_hash,
      payload_json: fhenixEventPayloadJson(input.payload),
      observed_at: input.observed_at,
    });
  },

  listAttachableEvents(
    db: Database.Database,
    input: {
      chain_id: number;
      contract_address: string;
      event_name: string;
      limit?: number;
    },
  ): FhenixIndexedEventRow[] {
    const rows = prep(
      db,
      `SELECT e.event_name, e.tx_hash, e.log_index, e.block_number,
              e.block_hash, e.payload_json
       FROM fhenix_events e
       JOIN fhenix_sealed_calls f
         ON f.chain_id = e.chain_id
        AND lower(f.contract_address) = lower(e.contract_address)
        AND lower(f.onchain_call_id) = lower(json_extract(e.payload_json, '$.callId'))
       WHERE e.chain_id = @chain_id
         AND lower(e.contract_address) = lower(@contract_address)
         AND e.event_name = @event_name
         AND json_type(e.payload_json, '$.callId') = 'text'
         AND f.reveal_status = 'pending'
         AND f.revealed_at IS NULL
       ORDER BY e.block_number, e.log_index
       LIMIT @limit`,
    ).all({
      chain_id: input.chain_id,
      contract_address: input.contract_address,
      event_name: input.event_name,
      limit: input.limit ?? 500,
    }) as Array<Omit<FhenixIndexedEventRow, "payload"> & { payload_json: string }>;

    return rows.map(({ payload_json, ...row }) => ({
      ...row,
      payload: JSON.parse(payload_json) as FhenixEventPayload,
    }));
  },

  getCursor(
    db: Database.Database,
    input: { chain_id: number; contract_address: string; event_name: string },
  ): number | null {
    const row = prep(
      db,
      `SELECT last_block_number
       FROM fhenix_event_cursors
       WHERE chain_id = @chain_id
         AND contract_address = @contract_address
         AND event_name = @event_name`,
    ).get(input) as { last_block_number: number } | undefined;
    return row?.last_block_number ?? null;
  },

  setCursor(
    db: Database.Database,
    input: {
      chain_id: number;
      contract_address: string;
      event_name: string;
      last_block_number: number;
      updated_at: string;
      /** Set ONLY when this write leaves the scan at the safe head. Mid-catch-up
       *  batches pass null, which CLEARS any previous watermark: a partial scan
       *  means coverage is no longer proven, and a preserved-but-fresh old
       *  watermark let a reveal in the unscanned range be refunded (fix-review
       *  issue 2 on audit F-3). */
      head_synced_at: string | null;
    },
  ): void {
    prep(
      db,
      `INSERT INTO fhenix_event_cursors
       (chain_id, contract_address, event_name, last_block_number, updated_at, head_synced_at)
       VALUES
       (@chain_id, @contract_address, @event_name, @last_block_number, @updated_at, @head_synced_at)
       ON CONFLICT(chain_id, contract_address, event_name) DO UPDATE SET
        last_block_number = excluded.last_block_number,
        updated_at = excluded.updated_at,
        head_synced_at = excluded.head_synced_at`,
    ).run(input);
  },

  /** Refresh head_synced_at on a tick where the cursor is already at the safe
   *  head and no batch is written (`from > safeHead`). Without this, a quiet
   *  chain would let head_synced_at go stale and pending reveals would read as
   *  unknown instead of "watcher looked, nothing published". */
  touchHeadSynced(
    db: Database.Database,
    input: {
      chain_id: number;
      contract_address: string;
      event_name: string;
      head_synced_at: string;
    },
  ): void {
    prep(
      db,
      `UPDATE fhenix_event_cursors
       SET head_synced_at = @head_synced_at, updated_at = @head_synced_at
       WHERE chain_id = @chain_id
         AND contract_address = @contract_address
         AND event_name = @event_name`,
    ).run(input);
  },
};
