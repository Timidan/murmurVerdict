import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { fhenixMarketIdForMurmurMarket } from "./fhenix-events.js";
import { fhenixFeedIdForMurmurFeed } from "./fhenix-gateway-feed-packets.js";
import { preflightMarketAndRateLimits } from "./fhenix-gateway-sealed-call-preflight.js";
import { ZERO_BYTES32, type GatewayFeedPacketBody, type GatewaySealedCallBody } from "./fhenix-gateway-schemas.js";
import { normalizeAddress } from "./fhenix-gateway-runtime.js";
import { gatewayCofheInputJson } from "./fhenix-gateway-cofhe-input.js";
import { deriveFeedRevealAfter } from "../verdict/feed-policy.js";
import {
  fhenixGatewayTxRepo,
  type FhenixGatewayTxAttemptRow,
} from "../verdict/repos/fhenix-gateway-tx-repo.js";
import {
  fhenixGatewayFeedPacketTxRepo,
  type FhenixGatewayFeedPacketTxAttemptRow,
} from "../verdict/repos/fhenix-gateway-feed-packet-tx-repo.js";
import { marketsRepo } from "../verdict/repos/market-registry-repo.js";
import { isUniqueViolation } from "../verdict/sqlite-errors.js";
import { submissionsRepo } from "../verdict/repos/sealed-call-submissions-repo.js";
import {
  feedPacketsRepo,
  type FeedContractRow,
} from "../verdict/repos/feed-availability-repo.js";
import { ERROR_CODES, VerdictError } from "../verdict/schema.js";
import { nowIso } from "../verdict/time.js";
import {
  authorizeRuntimeKeyGatewayIntent,
  type RuntimeKeyIdentity,
} from "../verdict/auth/runtime-authorization.js";
import {
  inferFeedDeliveryDeadline,
  validateFeedPacketMarket,
} from "../verdict/feed-availability.js";

type GatewayMarket = NonNullable<ReturnType<typeof marketsRepo.get>>;

export type ReserveSealedCallAttemptResult =
  | {
      kind: "attempt";
      attempt_id: string;
    }
  | {
      kind: "existing_attempt";
      attempt: FhenixGatewayTxAttemptRow;
    }
  | {
      kind: "accepted_submission";
      call_id: string;
    };

export function reserveSealedCallAttempt(params: {
  db: Database.Database;
  runtimeIdentity: RuntimeKeyIdentity;
  body: GatewaySealedCallBody;
  market: GatewayMarket;
  chainId: number;
  contractAddress: string;
  relayerAddress: string;
  newAttemptId?: () => string;
  now: () => Date;
}): ReserveSealedCallAttemptResult {
  const {
    agent_id: agentId,
    account_id: accountId,
    runtime_key: runtimeKey,
  } = params.runtimeIdentity;

  const existingAttempt = fhenixGatewayTxRepo.byClientOrder(
    params.db,
    agentId,
    params.body.client_order_id,
  );
  if (existingAttempt) {
    return { kind: "existing_attempt", attempt: existingAttempt };
  }
  const existingSubmission = submissionsRepo.findByClientOrderId(
    params.db,
    agentId,
    params.body.client_order_id,
  );
  if (existingSubmission) {
    return { kind: "accepted_submission", call_id: existingSubmission.call_id };
  }

  const ts = nowIso(params.now());
  let idempotentReturn: FhenixGatewayTxAttemptRow | null = null;
  let idempotentSubmissionCallId: string | null = null;
  let createdAttemptId: string | null = null;
  const reserveAndInsert = params.db.transaction(() => {
    // Re-check inside the lock: a competing process may have inserted the same
    // Gateway Attempt or already promoted it to an accepted Sealed Call.
    const competing = fhenixGatewayTxRepo.byClientOrder(
      params.db,
      agentId,
      params.body.client_order_id,
    );
    if (competing) {
      idempotentReturn = competing;
      return;
    }
    const competingSubmission = submissionsRepo.findByClientOrderId(
      params.db,
      agentId,
      params.body.client_order_id,
    );
    if (competingSubmission) {
      idempotentSubmissionCallId = competingSubmission.call_id;
      return;
    }
    authorizeRuntimeKeyGatewayIntent(
      params.db,
      params.runtimeIdentity,
      {
        kind: "sealed_call",
        chain_id: params.chainId,
        market_id: params.market.market_id,
      },
      { now: params.now },
    );
    preflightMarketAndRateLimits(params.db, agentId, params.market, params.now);
    const attempt = {
      attempt_id: (params.newAttemptId ?? randomUUID)(),
      status: "queued" as const,
      runtime_key_id: runtimeKey.runtime_key_id,
      runtime_key_policy_hash: runtimeKey.policy_hash,
      runtime_key_policy_json: runtimeKey.policy_json,
      account_id: accountId,
      agent_id: agentId,
      chain_id: params.chainId,
      contract_address: params.contractAddress,
      relayer_address: params.relayerAddress,
      agent_wallet_address: normalizeAddress(runtimeKey.controller_wallet_address),
      market_id: params.market.market_id,
      market_id_hash: fhenixMarketIdForMurmurMarket(params.market.market_id),
      market_ref_protocol: params.body.marketRef.protocol,
      market_config_version: params.body.marketRef.configVersion,
      client_order_id: params.body.client_order_id,
      client_nonce: params.body.client_nonce.toLowerCase(),
      submitted_at: params.body.submitted_at ?? ts,
      rationale: params.body.rationale ?? null,
      strategy_tag: params.body.strategy_tag ?? null,
      binary_index_input_json: gatewayCofheInputJson(params.body.binary_index_input),
      confidence_input_json: gatewayCofheInputJson(params.body.confidence_input),
      next_attempt_at: ts,
      created_at: ts,
      updated_at: ts,
    };
    try {
      fhenixGatewayTxRepo.insert(params.db, attempt);
      createdAttemptId = attempt.attempt_id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const row = fhenixGatewayTxRepo.byClientOrder(
          params.db,
          agentId,
          params.body.client_order_id,
        );
        if (row) {
          idempotentReturn = row;
          return;
        }
      }
      throw err;
    }
  });
  reserveAndInsert.immediate();

  if (idempotentReturn) {
    return { kind: "existing_attempt", attempt: idempotentReturn };
  }
  if (idempotentSubmissionCallId !== null) {
    return { kind: "accepted_submission", call_id: idempotentSubmissionCallId };
  }
  if (!createdAttemptId) {
    throw new Error("Gateway sealed-call reservation did not create an attempt");
  }
  return { kind: "attempt", attempt_id: createdAttemptId };
}

export type ReserveFeedPacketAttemptResult =
  | {
      kind: "attempt";
      attempt_id: string;
    }
  | {
      kind: "existing_attempt";
      attempt: FhenixGatewayFeedPacketTxAttemptRow;
    };

export function reserveFeedPacketAttempt(params: {
  db: Database.Database;
  runtimeIdentity: RuntimeKeyIdentity;
  body: GatewayFeedPacketBody;
  feed: FeedContractRow;
  chainId: number;
  contractAddress: string;
  relayerAddress: string;
  newAttemptId?: () => string;
  now: () => Date;
}): ReserveFeedPacketAttemptResult {
  const {
    agent_id: agentId,
    account_id: accountId,
    runtime_key: runtimeKey,
  } = params.runtimeIdentity;

  authorizeRuntimeKeyGatewayIntent(
    params.db,
    params.runtimeIdentity,
    {
      kind: "feed_packet",
      chain_id: params.chainId,
      market_id: params.body.market_id ?? null,
    },
    { now: params.now },
  );
  validateFeedPacketMarket(params.db, params.feed, params.body.market_id ?? null);

  const existingAttempt = fhenixGatewayFeedPacketTxRepo.byClientOrder(
    params.db,
    agentId,
    params.feed.feed_id,
    params.body.client_order_id,
  );
  if (existingAttempt) {
    return { kind: "existing_attempt", attempt: existingAttempt };
  }

  const now = params.now();
  const ts = nowIso(now);
  const revealAfter = deriveFeedRevealAfter(params.feed, params.body.reveal_after, now);
  const revealAfterMs = Date.parse(revealAfter);
  if (!Number.isFinite(revealAfterMs) || revealAfterMs <= now.getTime()) {
    throw new VerdictError(
      "feed packet reveal_after must be in the future",
      ERROR_CODES.schema_invalid,
      400,
      { reveal_after: revealAfter },
    );
  }

  let idempotentFeedReturn: FhenixGatewayFeedPacketTxAttemptRow | null = null;
  let createdAttemptId: string | null = null;
  try {
    const reserveFeedAttempt = params.db.transaction(() => {
      const competing = fhenixGatewayFeedPacketTxRepo.byClientOrder(
        params.db,
        agentId,
        params.feed.feed_id,
        params.body.client_order_id,
      );
      if (competing) {
        idempotentFeedReturn = competing;
        return;
      }
      const sequence = params.body.sequence ?? Math.max(
        feedPacketsRepo.nextSequence(params.db, params.feed.feed_id),
        fhenixGatewayFeedPacketTxRepo.nextSequence(params.db, params.feed.feed_id),
      );
      if (
        params.body.sequence !== undefined &&
        fhenixGatewayFeedPacketTxRepo.hasNonTerminalSequence(params.db, params.feed.feed_id, sequence)
      ) {
        throw new VerdictError(
          `feed packet sequence ${sequence} for feed ${params.feed.feed_id} is already held by a non-terminal gateway attempt`,
          ERROR_CODES.duplicate,
          409,
          { feed_id: params.feed.feed_id, sequence },
        );
      }
      const latest = feedPacketsRepo.latestForFeed(params.db, params.feed.feed_id);
      const deadline = params.body.delivery_deadline_at ??
        inferFeedDeliveryDeadline(params.feed, latest, sequence);
      const attemptId = (params.newAttemptId ?? randomUUID)();
      fhenixGatewayFeedPacketTxRepo.insert(params.db, {
        attempt_id: attemptId,
        status: "queued",
        runtime_key_id: runtimeKey.runtime_key_id,
        runtime_key_policy_hash: runtimeKey.policy_hash,
        runtime_key_policy_json: runtimeKey.policy_json,
        account_id: accountId,
        agent_id: agentId,
        chain_id: params.chainId,
        contract_address: params.contractAddress,
        relayer_address: params.relayerAddress,
        agent_wallet_address: normalizeAddress(runtimeKey.controller_wallet_address),
        feed_id: params.feed.feed_id,
        feed_id_hash: fhenixFeedIdForMurmurFeed(params.feed.feed_id),
        market_id: params.body.market_id ?? null,
        market_id_hash: params.body.market_id
          ? fhenixMarketIdForMurmurMarket(params.body.market_id)
          : ZERO_BYTES32,
        packet_kind: params.body.packet_kind,
        sequence,
        payload_schema: params.body.payload_schema,
        client_order_id: params.body.client_order_id,
        client_nonce: params.body.client_nonce.toLowerCase(),
        submitted_at: params.body.submitted_at ?? ts,
        delivery_deadline_at: deadline,
        reveal_after: revealAfter,
        action_input_json: gatewayCofheInputJson(params.body.action_input),
        signal_input_json: gatewayCofheInputJson(params.body.signal_input),
        next_attempt_at: ts,
        created_at: ts,
        updated_at: ts,
      });
      createdAttemptId = attemptId;
    });
    reserveFeedAttempt.immediate();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const row = fhenixGatewayFeedPacketTxRepo.byClientOrder(
        params.db,
        agentId,
        params.feed.feed_id,
        params.body.client_order_id,
      );
      if (row) {
        return { kind: "existing_attempt", attempt: row };
      }
    }
    throw err;
  }
  if (idempotentFeedReturn) {
    return { kind: "existing_attempt", attempt: idempotentFeedReturn };
  }
  if (!createdAttemptId) {
    throw new Error("Gateway feed-packet reservation did not create an attempt");
  }
  return { kind: "attempt", attempt_id: createdAttemptId };
}
