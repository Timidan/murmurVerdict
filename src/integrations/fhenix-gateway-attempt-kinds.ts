import type { Address, Hex } from "viem";

import type { GatewayAttemptKind } from "./fhenix-gateway-attempt-machine.js";
import {
  MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
} from "./fhenix-gateway-contract.js";
import {
  feedPacketCofheContractInputs,
  sealedCallCofheContractInputs,
} from "./fhenix-gateway-cofhe-input.js";
import {
  extractFeedPacketSubmitEvent,
  extractSealedCallSubmitEvent,
  type GatewayFeedPacketSubmitEvent,
  type GatewaySealedCallSubmitEvent,
} from "./fhenix-gateway-events.js";
import {
  reconcileFeedPacketSubmit,
  reconcileSealedCallSubmit,
} from "./fhenix-gateway-reconciliation.js";
import {
  acceptConfirmedFeedPacketGatewayAttempt,
  acceptConfirmedSealedCallGatewayAttempt,
} from "./fhenix-gateway-acceptance.js";
import {
  gatewayFeedPacketResult,
  gatewaySubmissionResult,
} from "./fhenix-gateway-presenters.js";
import {
  fhenixGatewayTxRepo,
  type FhenixGatewayTxAttemptRow,
} from "../verdict/repos/fhenix-gateway-tx-repo.js";
import {
  fhenixGatewayFeedPacketTxRepo,
  type FhenixGatewayFeedPacketTxAttemptRow,
} from "../verdict/repos/fhenix-gateway-feed-packet-tx-repo.js";
import type { FeedPacketIdAdapter } from "../verdict/feed-packet-ingestion.js";
import type { SealedCallIdAdapter } from "../verdict/sealed-call-acceptance.js";

/**
 * The two Gateway Attempt lanes, expressed as Gateway Attempt Machine kind
 * adapters. Everything the machine needs to know about "sealed call vs
 * feed packet" lives here — contract function + args, reconciliation key,
 * submit-event decoding, confirmed-metadata persistence, acceptance,
 * terminal/audit/presenter wording. The machine itself never branches on
 * lane.
 */

export function sealedCallAttemptKind(
  opts: { newSealedCallId?: SealedCallIdAdapter } = {},
): GatewayAttemptKind<FhenixGatewayTxAttemptRow, GatewaySealedCallSubmitEvent> {
  return {
    label: "sealed_call",
    lifecycle: fhenixGatewayTxRepo,
    reconcile: (config, attempt) =>
      reconcileSealedCallSubmit(config, {
        agentWalletAddress: attempt.agent_wallet_address,
        marketIdHash: attempt.market_id_hash,
        clientNonce: attempt.client_nonce,
      }),
    contractWrite: (attempt, contractAddress) => {
      const inputs = sealedCallCofheContractInputs(attempt);
      return {
        address: contractAddress,
        abi: MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
        functionName: "submitSealedFor",
        args: [
          attempt.agent_wallet_address as Address,
          attempt.market_id_hash as Hex,
          inputs.binaryIndex,
          inputs.confidence,
          attempt.client_nonce as Hex,
        ],
      };
    },
    extractSubmitEvent: extractSealedCallSubmitEvent,
    persistConfirmed: (db, attempt, event, updated_at) => {
      fhenixGatewayTxRepo.markConfirmed(db, {
        attempt_id: attempt.attempt_id,
        submit_log_index: event.logIndex,
        submit_block_number: event.blockNumber,
        onchain_call_id: event.onchain_call_id,
        binary_index_ct_hash: event.binary_index_ct_hash,
        confidence_ct_hash: event.confidence_ct_hash,
        accepted_at: event.accepted_at,
        reveal_open_at: event.reveal_open_at,
        updated_at,
      });
    },
    accept: (db, attempt, now) =>
      acceptConfirmedSealedCallGatewayAttempt({
        db,
        attempt,
        newCallId: opts.newSealedCallId,
        now,
      }),
    terminal: {
      runtimeKeyRevoked: "Runtime Key revoked or expired before broadcast",
      maxAttemptsExceeded: (maxAttempts) =>
        `Gateway relay exceeded max attempts (${maxAttempts})`,
      reverted: "Fhenix Gateway relay transaction reverted",
    },
    retryConflictMessage: (status) =>
      `cannot retry gateway attempt in status=${status}`,
    retryAuditPayload: (attempt, ctx) => ({
      attempt_id: attempt.attempt_id,
      attempt_type: "sealed_call",
      previous_status: attempt.status,
      previous_attempt_count: attempt.attempt_count,
      previous_next_attempt_at: attempt.next_attempt_at,
      previous_last_error: attempt.last_error,
      chain_id: ctx.chain_id,
      contract_address: ctx.contract_address,
      agent_wallet_address: attempt.agent_wallet_address,
      client_nonce: attempt.client_nonce,
      market_id: attempt.market_id,
    }),
    presentResult: (_db, attempt, idempotent_hit) =>
      gatewaySubmissionResult(attempt, idempotent_hit),
  };
}

export function feedPacketAttemptKind(
  opts: { newFeedPacketId?: FeedPacketIdAdapter } = {},
): GatewayAttemptKind<
  FhenixGatewayFeedPacketTxAttemptRow,
  GatewayFeedPacketSubmitEvent
> {
  return {
    label: "feed_packet",
    lifecycle: fhenixGatewayFeedPacketTxRepo,
    reconcile: (config, attempt) =>
      reconcileFeedPacketSubmit(config, {
        agentWalletAddress: attempt.agent_wallet_address,
        feedIdHash: attempt.feed_id_hash,
        marketIdHash: attempt.market_id_hash,
        clientNonce: attempt.client_nonce,
      }),
    contractWrite: (attempt, contractAddress) => {
      const inputs = feedPacketCofheContractInputs(attempt);
      return {
        address: contractAddress,
        abi: MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
        functionName: "submitFeedPacketFor",
        args: [
          attempt.agent_wallet_address as Address,
          attempt.feed_id_hash as Hex,
          attempt.market_id_hash as Hex,
          BigInt(Math.floor(Date.parse(attempt.reveal_after) / 1000)),
          inputs.action,
          inputs.signal,
          attempt.client_nonce as Hex,
        ],
      };
    },
    extractSubmitEvent: extractFeedPacketSubmitEvent,
    persistConfirmed: (db, attempt, event, updated_at) => {
      fhenixGatewayFeedPacketTxRepo.markConfirmed(db, {
        attempt_id: attempt.attempt_id,
        submit_log_index: event.logIndex,
        submit_block_number: event.blockNumber,
        onchain_packet_id: event.onchain_packet_id,
        action_ct_hash: event.action_ct_hash,
        signal_ct_hash: event.signal_ct_hash,
        accepted_at: event.accepted_at,
        updated_at,
      });
    },
    accept: (db, attempt, now) =>
      acceptConfirmedFeedPacketGatewayAttempt({
        db,
        attempt,
        newPacketId: opts.newFeedPacketId,
        now,
      }),
    terminal: {
      runtimeKeyRevoked:
        "Runtime Key revoked or expired before feed packet broadcast",
      maxAttemptsExceeded: (maxAttempts) =>
        `Gateway feed relay exceeded max attempts (${maxAttempts})`,
      reverted: "Fhenix Gateway feed relay transaction reverted",
    },
    retryConflictMessage: (status) =>
      `cannot retry gateway feed attempt in status=${status}`,
    retryAuditPayload: (attempt, ctx) => ({
      attempt_id: attempt.attempt_id,
      attempt_type: "feed_packet",
      previous_status: attempt.status,
      previous_attempt_count: attempt.attempt_count,
      previous_next_attempt_at: attempt.next_attempt_at,
      previous_last_error: attempt.last_error,
      chain_id: ctx.chain_id,
      contract_address: ctx.contract_address,
      agent_wallet_address: attempt.agent_wallet_address,
      feed_id_hash: attempt.feed_id_hash,
      client_nonce: attempt.client_nonce,
    }),
    presentResult: (db, attempt, idempotent_hit) =>
      gatewayFeedPacketResult(attempt, idempotent_hit, db),
  };
}
