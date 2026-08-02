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

import { assertGatewayFingerprintMatch } from "./gateway-request-fingerprint.js";

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

/**
 * The ONE way a sealed-call client_order_id duplicate may exit (used by the
 * broadcaster's early checks, the pre-transaction checks here, the
 * in-transaction recheck, and unique-race recovery — per codex review
 * 2026-08-02, every exit must compare fingerprints or the changed-parameter
 * guarantee is false under concurrency). Returns null when no duplicate
 * exists. Throws 409 when the same client_order_id carries DIFFERENT content,
 * and re-applies pure policy (no rate-limit burn) before handing back a
 * pinned attempt so a since-narrowed key can't retrieve orders outside its
 * policy. An accepted submission with no surviving attempt row has no stored
 * fingerprint — that replay keeps the legacy 200.
 */
export function sealedCallDuplicateExit(params: {
  db: Database.Database;
  runtimeIdentity: RuntimeKeyIdentity;
  clientOrderId: string;
  requestFingerprint: string;
  now: () => Date;
}): ReserveSealedCallAttemptResult | null {
  const agentId = params.runtimeIdentity.agent_id;
  const attempt = fhenixGatewayTxRepo.byClientOrder(
    params.db,
    agentId,
    params.clientOrderId,
  );
  if (attempt) {
    assertGatewayFingerprintMatch(
      attempt.request_fingerprint,
      params.requestFingerprint,
      { client_order_id: params.clientOrderId, attempt_id: attempt.attempt_id },
    );
    authorizeRuntimeKeyGatewayIntent(
      params.db,
      params.runtimeIdentity,
      {
        kind: "sealed_call",
        chain_id: attempt.chain_id,
        market_id: attempt.market_id,
      },
      { now: params.now, skipRateLimits: true },
    );
    return { kind: "existing_attempt", attempt };
  }
  const submission = submissionsRepo.findByClientOrderId(
    params.db,
    agentId,
    params.clientOrderId,
  );
  if (submission) {
    return { kind: "accepted_submission", call_id: submission.call_id };
  }
  return null;
}

export function reserveSealedCallAttempt(params: {
  db: Database.Database;
  runtimeIdentity: RuntimeKeyIdentity;
  body: GatewaySealedCallBody;
  market: GatewayMarket;
  chainId: number;
  contractAddress: string;
  relayerAddress: string;
  requestFingerprint: string;
  authProof: string | null;
  newAttemptId?: () => string;
  now: () => Date;
}): ReserveSealedCallAttemptResult {
  const {
    agent_id: agentId,
    account_id: accountId,
    runtime_key: runtimeKey,
  } = params.runtimeIdentity;

  const preTxDuplicate = sealedCallDuplicateExit({
    db: params.db,
    runtimeIdentity: params.runtimeIdentity,
    clientOrderId: params.body.client_order_id,
    requestFingerprint: params.requestFingerprint,
    now: params.now,
  });
  if (preTxDuplicate) {
    return preTxDuplicate;
  }

  const ts = nowIso(params.now());
  let inTxDuplicate: ReserveSealedCallAttemptResult | null = null;
  let createdAttemptId: string | null = null;
  const reserveAndInsert = params.db.transaction(() => {
    // Re-check inside the lock: a competing process may have inserted the same
    // Gateway Attempt or already promoted it to an accepted Sealed Call. The
    // shared exit compares fingerprints, so a concurrent DIFFERENT body 409s
    // instead of silently receiving the winner's attempt.
    inTxDuplicate = sealedCallDuplicateExit({
      db: params.db,
      runtimeIdentity: params.runtimeIdentity,
      clientOrderId: params.body.client_order_id,
      requestFingerprint: params.requestFingerprint,
      now: params.now,
    });
    if (inTxDuplicate) {
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
      request_fingerprint: params.requestFingerprint,
      auth_proof: params.authProof,
      next_attempt_at: ts,
      created_at: ts,
      updated_at: ts,
    };
    try {
      fhenixGatewayTxRepo.insert(params.db, attempt);
      createdAttemptId = attempt.attempt_id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Unique-race recovery goes through the same fingerprint-checked
        // exit: the loser of a different-body race gets 409, not the
        // winner's attempt.
        inTxDuplicate = sealedCallDuplicateExit({
          db: params.db,
          runtimeIdentity: params.runtimeIdentity,
          clientOrderId: params.body.client_order_id,
          requestFingerprint: params.requestFingerprint,
          now: params.now,
        });
        if (inTxDuplicate) {
          return;
        }
      }
      throw err;
    }
  });
  reserveAndInsert.immediate();

  if (inTxDuplicate) {
    return inTxDuplicate;
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

/**
 * Feed-lane sibling of sealedCallDuplicateExit. Policy is NOT re-applied
 * here because reserveFeedPacketAttempt authorizes unconditionally before
 * any duplicate check (unlike the sealed lane, where duplicates exit first).
 */
export function feedPacketDuplicateExit(params: {
  db: Database.Database;
  agentId: string;
  feedId: string;
  clientOrderId: string;
  requestFingerprint: string;
}): ReserveFeedPacketAttemptResult | null {
  const attempt = fhenixGatewayFeedPacketTxRepo.byClientOrder(
    params.db,
    params.agentId,
    params.feedId,
    params.clientOrderId,
  );
  if (attempt) {
    assertGatewayFingerprintMatch(
      attempt.request_fingerprint,
      params.requestFingerprint,
      {
        client_order_id: params.clientOrderId,
        feed_id: params.feedId,
        attempt_id: attempt.attempt_id,
      },
    );
    return { kind: "existing_attempt", attempt };
  }
  return null;
}

export function reserveFeedPacketAttempt(params: {
  db: Database.Database;
  runtimeIdentity: RuntimeKeyIdentity;
  body: GatewayFeedPacketBody;
  feed: FeedContractRow;
  chainId: number;
  contractAddress: string;
  relayerAddress: string;
  requestFingerprint: string;
  authProof: string | null;
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

  const preTxFeedDuplicate = feedPacketDuplicateExit({
    db: params.db,
    agentId,
    feedId: params.feed.feed_id,
    clientOrderId: params.body.client_order_id,
    requestFingerprint: params.requestFingerprint,
  });
  if (preTxFeedDuplicate) {
    return preTxFeedDuplicate;
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
      const competing = feedPacketDuplicateExit({
        db: params.db,
        agentId,
        feedId: params.feed.feed_id,
        clientOrderId: params.body.client_order_id,
        requestFingerprint: params.requestFingerprint,
      });
      if (competing?.kind === "existing_attempt") {
        idempotentFeedReturn = competing.attempt;
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
        request_fingerprint: params.requestFingerprint,
        auth_proof: params.authProof,
        next_attempt_at: ts,
        created_at: ts,
        updated_at: ts,
      });
      createdAttemptId = attemptId;
    });
    reserveFeedAttempt.immediate();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const recovered = feedPacketDuplicateExit({
        db: params.db,
        agentId,
        feedId: params.feed.feed_id,
        clientOrderId: params.body.client_order_id,
        requestFingerprint: params.requestFingerprint,
      });
      if (recovered) {
        return recovered;
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
