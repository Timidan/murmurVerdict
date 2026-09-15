import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import type { FeedPacketKind } from "../schema.js";
import {
  gatewayAttemptLifecycleRepo,
  type FhenixGatewayTxStatus,
} from "./fhenix-gateway-attempt-lifecycle.js";

/** Feed-packet Gateway Attempt records: entity columns and sequence reads; transitions come from the shared lifecycle. */

export type FhenixGatewayFeedPacketTxStatus = FhenixGatewayTxStatus;

export interface FhenixGatewayFeedPacketTxAttemptInsert {
  attempt_id: string;
  status: FhenixGatewayFeedPacketTxStatus;
  runtime_key_id: string | null;
  runtime_key_policy_hash: string;
  runtime_key_policy_json: string;
  account_id: string;
  agent_id: string;
  chain_id: number;
  contract_address: string;
  relayer_address: string;
  agent_wallet_address: string;
  feed_id: string;
  feed_id_hash: string;
  market_id: string | null;
  market_id_hash: string;
  packet_kind: FeedPacketKind;
  sequence: number;
  payload_schema: string;
  client_order_id: string;
  client_nonce: string;
  submitted_at: string;
  delivery_deadline_at: string | null;
  reveal_after: string;
  action_input_json: string;
  signal_input_json: string;
  /** murmur-idem-v1 hash of the reserving request's body, checked on every client_order_id
   *  duplicate. NULL on legacy rows. */
  request_fingerprint: string | null;
  /** How the reserving request authenticated: 'pop-v1' or NULL (bearer). */
  auth_proof: string | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
}

export interface FhenixGatewayFeedPacketTxAttemptRow extends FhenixGatewayFeedPacketTxAttemptInsert {
  tx_hash: string | null;
  submit_log_index: number | null;
  submit_block_number: number | null;
  onchain_packet_id: string | null;
  action_ct_hash: string | null;
  signal_ct_hash: string | null;
  accepted_at: string | null;
  packet_id: string | null;
  attempt_count: number;
  last_error: string | null;
  broadcast_started_at: string | null;
  broadcast_latency_ms: number | null;
  receipt_observed_at: string | null;
  receipt_latency_ms: number | null;
  latest_block_latency_ms: number | null;
  receipt_status: "success" | "reverted" | null;
  receipt_block_number: number | null;
  latest_block_number: number | null;
  confirmations_observed: number | null;
  gas_used: string | null;
  effective_gas_price_wei: string | null;
  last_rpc_error: string | null;
  /** See GatewayAttemptLifecycleRow.broadcast_claim_token. */
  broadcast_claim_token: string | null;
}

const lifecycle = gatewayAttemptLifecycleRepo<FhenixGatewayFeedPacketTxAttemptRow>(
  "fhenix_gateway_feed_packet_tx_attempts",
);

export const fhenixGatewayFeedPacketTxRepo = {
  ...lifecycle,

  insert(db: Database.Database, input: FhenixGatewayFeedPacketTxAttemptInsert): void {
    prep(
      db,
      `INSERT INTO fhenix_gateway_feed_packet_tx_attempts
       (attempt_id, status, runtime_key_id, runtime_key_policy_hash,
        runtime_key_policy_json, account_id, agent_id, chain_id,
        contract_address, relayer_address, agent_wallet_address, feed_id,
        feed_id_hash, market_id, market_id_hash, packet_kind, sequence,
        payload_schema, client_order_id, client_nonce, submitted_at,
        delivery_deadline_at, reveal_after, action_input_json,
        signal_input_json, request_fingerprint, auth_proof,
        next_attempt_at, created_at, updated_at)
       VALUES
       (@attempt_id, @status, @runtime_key_id, @runtime_key_policy_hash,
        @runtime_key_policy_json, @account_id, @agent_id, @chain_id,
        @contract_address, @relayer_address, @agent_wallet_address, @feed_id,
        @feed_id_hash, @market_id, @market_id_hash, @packet_kind, @sequence,
        @payload_schema, @client_order_id, @client_nonce, @submitted_at,
        @delivery_deadline_at, @reveal_after, @action_input_json,
        @signal_input_json, @request_fingerprint, @auth_proof,
        @next_attempt_at, @created_at, @updated_at)`,
    ).run(input);
  },

  byClientOrder(
    db: Database.Database,
    agent_id: string,
    feed_id: string,
    client_order_id: string,
  ): FhenixGatewayFeedPacketTxAttemptRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM fhenix_gateway_feed_packet_tx_attempts
         WHERE agent_id = ? AND feed_id = ? AND client_order_id = ?
         LIMIT 1`,
      ).get(agent_id, feed_id, client_order_id) as FhenixGatewayFeedPacketTxAttemptRow | undefined) ?? null
    );
  },

  nextSequence(db: Database.Database, feed_id: string): number {
    const row = prep(
      db,
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM fhenix_gateway_feed_packet_tx_attempts
       WHERE feed_id = ?
         AND status != 'failed_terminal'`,
    ).get(feed_id) as { next_sequence: number } | undefined;
    return row?.next_sequence ?? 1;
  },

  /**
   * True iff a non-terminal attempt already holds (feed_id, sequence), so a colliding explicit
   * sequence is rejected before the relayer wastes a broadcast.
   */
  hasNonTerminalSequence(
    db: Database.Database,
    feed_id: string,
    sequence: number,
  ): boolean {
    const row = prep(
      db,
      `SELECT 1 AS hit
       FROM fhenix_gateway_feed_packet_tx_attempts
       WHERE feed_id = ?
         AND sequence = ?
         AND status != 'failed_terminal'
       LIMIT 1`,
    ).get(feed_id, sequence) as { hit: number } | undefined;
    return row !== undefined;
  },

  markConfirmed(
    db: Database.Database,
    input: {
      attempt_id: string;
      submit_log_index: number;
      submit_block_number: number | null;
      onchain_packet_id: string;
      action_ct_hash: string;
      signal_ct_hash: string;
      accepted_at: string;
      updated_at: string;
    },
  ): void {
    prep(
      db,
      `UPDATE fhenix_gateway_feed_packet_tx_attempts
       SET status = 'confirmed',
           submit_log_index = @submit_log_index,
           submit_block_number = @submit_block_number,
           onchain_packet_id = @onchain_packet_id,
           action_ct_hash = @action_ct_hash,
           signal_ct_hash = @signal_ct_hash,
           accepted_at = @accepted_at,
           last_error = NULL,
           updated_at = @updated_at
       WHERE attempt_id = @attempt_id`,
    ).run(input);
  },

  markAccepted(
    db: Database.Database,
    input: { attempt_id: string; packet_id: string; updated_at: string },
  ): void {
    prep(
      db,
      `UPDATE fhenix_gateway_feed_packet_tx_attempts
       SET status = 'accepted',
           packet_id = @packet_id,
           last_error = NULL,
           updated_at = @updated_at
       WHERE attempt_id = @attempt_id`,
    ).run(input);
  },
};
