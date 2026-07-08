import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import {
  gatewayAttemptLifecycleRepo,
  type FhenixGatewayTxStatus,
} from "./fhenix-gateway-attempt-lifecycle.js";

/**
 * Sealed-call Gateway Attempt Records. Owns the sealed-call entity columns
 * (market identity, CoFHE inputs, call linkage) plus the sealed-only
 * in-flight quota reads; every status-machine transition comes from the
 * shared Gateway Attempt Lifecycle Records.
 */

export interface FhenixGatewayTxAttemptInsert {
  attempt_id: string;
  status: FhenixGatewayTxStatus;
  runtime_key_id: string | null;
  runtime_key_policy_hash: string;
  runtime_key_policy_json: string;
  account_id: string;
  agent_id: string;
  chain_id: number;
  contract_address: string;
  relayer_address: string;
  agent_wallet_address: string;
  market_id: string;
  market_id_hash: string;
  market_ref_protocol: string;
  market_config_version: number;
  client_order_id: string;
  client_nonce: string;
  submitted_at: string;
  rationale: string | null;
  strategy_tag: string | null;
  binary_index_input_json: string;
  confidence_input_json: string;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
}

export interface FhenixGatewayTxAttemptRow extends FhenixGatewayTxAttemptInsert {
  tx_hash: string | null;
  submit_log_index: number | null;
  submit_block_number: number | null;
  onchain_call_id: string | null;
  binary_index_ct_hash: string | null;
  confidence_ct_hash: string | null;
  accepted_at: string | null;
  reveal_open_at: string | null;
  call_id: string | null;
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

const lifecycle = gatewayAttemptLifecycleRepo<FhenixGatewayTxAttemptRow>(
  "fhenix_gateway_tx_attempts",
);

export const fhenixGatewayTxRepo = {
  ...lifecycle,

  insert(db: Database.Database, input: FhenixGatewayTxAttemptInsert): void {
    prep(
      db,
      `INSERT INTO fhenix_gateway_tx_attempts
       (attempt_id, status, runtime_key_id, account_id, agent_id,
        runtime_key_policy_hash, runtime_key_policy_json,
        chain_id, contract_address, relayer_address, agent_wallet_address,
        market_id, market_id_hash, market_ref_protocol, market_config_version,
        client_order_id, client_nonce, submitted_at, rationale, strategy_tag,
        binary_index_input_json, confidence_input_json,
        next_attempt_at, created_at, updated_at)
       VALUES
       (@attempt_id, @status, @runtime_key_id, @account_id, @agent_id,
        @runtime_key_policy_hash, @runtime_key_policy_json,
        @chain_id, @contract_address, @relayer_address, @agent_wallet_address,
        @market_id, @market_id_hash, @market_ref_protocol, @market_config_version,
        @client_order_id, @client_nonce, @submitted_at, @rationale, @strategy_tag,
        @binary_index_input_json, @confidence_input_json,
        @next_attempt_at, @created_at, @updated_at)`,
    ).run(input);
  },

  byClientOrder(
    db: Database.Database,
    agent_id: string,
    client_order_id: string,
  ): FhenixGatewayTxAttemptRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM fhenix_gateway_tx_attempts
         WHERE agent_id = ? AND client_order_id = ?
         LIMIT 1`,
      ).get(agent_id, client_order_id) as FhenixGatewayTxAttemptRow | undefined) ?? null
    );
  },

  // In-flight attempts (queued/submitted/confirmed/failed_retryable) still
  // hold quota: each one either burned relayer gas or will, and each can
  // still produce an `accepted` submission. Counting them alongside the
  // submissions table prevents wasted gas when acceptance later fails.
  countInflightByAgent(db: Database.Database, agent_id: string): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM fhenix_gateway_tx_attempts
       WHERE agent_id = ?
         AND status IN ('queued','submitted','confirmed','failed_retryable')`,
    ).get(agent_id) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  countInflightByAgentMarketWindow(
    db: Database.Database,
    agent_id: string,
    market_id: string,
    sinceIso: string,
  ): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM fhenix_gateway_tx_attempts
       WHERE agent_id = ? AND market_id = ? AND created_at >= ?
         AND status IN ('queued','submitted','confirmed','failed_retryable')`,
    ).get(agent_id, market_id, sinceIso) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  countInflightByRuntimeKeyWindow(
    db: Database.Database,
    runtime_key_id: string,
    sinceIso: string,
  ): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM fhenix_gateway_tx_attempts
       WHERE runtime_key_id = ? AND created_at >= ?
         AND status IN ('queued','submitted','confirmed','failed_retryable')`,
    ).get(runtime_key_id, sinceIso) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  markConfirmed(
    db: Database.Database,
    input: {
      attempt_id: string;
      submit_log_index: number;
      submit_block_number: number | null;
      onchain_call_id: string;
      binary_index_ct_hash: string;
      confidence_ct_hash: string;
      accepted_at: string;
      reveal_open_at: string;
      updated_at: string;
    },
  ): void {
    prep(
      db,
      `UPDATE fhenix_gateway_tx_attempts
       SET status = 'confirmed',
           submit_log_index = @submit_log_index,
           submit_block_number = @submit_block_number,
           onchain_call_id = @onchain_call_id,
           binary_index_ct_hash = @binary_index_ct_hash,
           confidence_ct_hash = @confidence_ct_hash,
           accepted_at = @accepted_at,
           reveal_open_at = @reveal_open_at,
           last_error = NULL,
           updated_at = @updated_at
       WHERE attempt_id = @attempt_id`,
    ).run(input);
  },

  markAccepted(
    db: Database.Database,
    input: { attempt_id: string; call_id: string; updated_at: string },
  ): void {
    prep(
      db,
      `UPDATE fhenix_gateway_tx_attempts
       SET status = 'accepted',
           call_id = @call_id,
           last_error = NULL,
           updated_at = @updated_at
       WHERE attempt_id = @attempt_id`,
    ).run(input);
  },
};
