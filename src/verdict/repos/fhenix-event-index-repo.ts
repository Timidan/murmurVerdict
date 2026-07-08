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
    },
  ): void {
    prep(
      db,
      `INSERT INTO fhenix_event_cursors
       (chain_id, contract_address, event_name, last_block_number, updated_at)
       VALUES
       (@chain_id, @contract_address, @event_name, @last_block_number, @updated_at)
       ON CONFLICT(chain_id, contract_address, event_name) DO UPDATE SET
        last_block_number = excluded.last_block_number,
        updated_at = excluded.updated_at`,
    ).run(input);
  },
};
