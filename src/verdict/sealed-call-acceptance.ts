import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { MarketRow } from "./repos/market-registry-repo.js";
import { fhenixSealedCallsRepo } from "./repos/fhenix-sealed-calls-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import { usageRepo } from "./repos/usage-events-repo.js";
import { isUniqueViolation } from "./sqlite-errors.js";
import {
  ERROR_CODES,
  SCHEMA_VERSION,
  SCORING_VERSION,
  VerdictError,
} from "./schema.js";
import {
  prepareSealedCallAcceptance,
  requireSealedCallAcceptanceAgent,
} from "./sealed-call-acceptance-guards.js";
import {
  makeSealedCallUsage,
  runtimeKeyUsageAttributes,
} from "./sealed-call-usage.js";
import type { AuthIdentity as DispatchedAuthIdentity } from "./auth/dispatcher.js";
import type { CallAcceptedEvent } from "./events.js";
import { publicAcceptedCallEvent } from "./public-event-fanout.js";
import type { VerifiedSealedCallSubmitted } from "../integrations/fhenix-events.js";
import { nowIso } from "./time.js";

export { makeSealedCallUsage } from "./sealed-call-usage.js";

export type SealedCallIdAdapter = () => string;

export interface SealedCallAcceptanceInput {
  db: Database.Database;
  authResult: DispatchedAuthIdentity;
  market: MarketRow;
  client_order_id: string;
  submitted_at?: string;
  rationale?: string;
  strategy_tag?: string;
  verifiedSubmit: VerifiedSealedCallSubmitted;
  newCallId?: SealedCallIdAdapter;
  now: () => Date;
}

export interface AcceptSealedCallResult {
  status: 200 | 201;
  body: {
    call_id: string;
    privacy_mode: "sealed_fhenix";
    market_id: string | null;
    status: string;
    reveal_open_at: string | null;
    onchain_call_id: string | null;
    idempotent_hit: boolean;
    tier: DispatchedAuthIdentity["tier"];
    commit_hash?: string;
  };
  event?: CallAcceptedEvent;
}

export async function acceptSealedCall(
  input: SealedCallAcceptanceInput,
): Promise<AcceptSealedCallResult> {
  const {
    db,
    authResult,
    market,
    client_order_id,
    submitted_at,
    rationale,
    strategy_tag,
    verifiedSubmit,
    now,
  } = input;

  const agentId = requireSealedCallAcceptanceAgent(authResult);

  // Shared by the pre-insert duplicate branch AND unique-race recovery: both
  // must prove the existing call is the SAME sealed Fhenix event before
  // returning an idempotent 200 (a blind recovery return let two concurrent
  // DIFFERENT bodies both report success — codex review 2026-08-02).
  const replayFromExisting = (existingCallId: string): AcceptSealedCallResult => {
    const existingCtx = submissionsRepo.loadResolverContext(db, existingCallId);
    if (existingCtx?.privacy_mode !== "sealed_fhenix") {
      throw new VerdictError(
        "client_order_id is already bound to a non-sealed_fhenix call",
        ERROR_CODES.duplicate,
        409,
        { existing_call_id: existingCallId },
      );
    }
    const sealed = fhenixSealedCallsRepo.byCallId(db, existingCallId);
    const sameEvent =
      sealed &&
      sealed.chain_id === verifiedSubmit.chain_id &&
      sealed.contract_address.toLowerCase() === verifiedSubmit.contract_address.toLowerCase() &&
      sealed.onchain_call_id.toLowerCase() === verifiedSubmit.onchain_call_id.toLowerCase() &&
      sealed.submit_tx_hash.toLowerCase() === verifiedSubmit.submit_tx_hash.toLowerCase() &&
      sealed.submit_log_index === verifiedSubmit.submit_log_index &&
      sealed.binary_index_ct_hash.toLowerCase() === verifiedSubmit.binary_index_ct_hash.toLowerCase() &&
      sealed.confidence_ct_hash.toLowerCase() === verifiedSubmit.confidence_ct_hash.toLowerCase() &&
      existingCtx.accepted_at === verifiedSubmit.accepted_at &&
      sealed.reveal_open_at === verifiedSubmit.reveal_open_at;
    if (!sameEvent) {
      throw new VerdictError(
        "client_order_id is already bound to a different sealed Fhenix event",
        ERROR_CODES.duplicate,
        409,
        { existing_call_id: existingCallId },
      );
    }
    return {
      status: 200,
      body: {
        call_id: existingCallId,
        privacy_mode: "sealed_fhenix",
        market_id: existingCtx.market_id,
        status: existingCtx.status,
        reveal_open_at: sealed?.reveal_open_at ?? null,
        onchain_call_id: sealed?.onchain_call_id ?? null,
        idempotent_hit: true,
        tier: authResult.tier,
      },
    };
  };

  const existing = submissionsRepo.findByClientOrderId(
    db,
    agentId,
    client_order_id,
  );
  if (existing) {
    return replayFromExisting(existing.call_id);
  }

  const prepared = prepareSealedCallAcceptance({
    db,
    agentId,
    market,
    client_order_id,
    submitted_at,
    verifiedSubmit,
    now,
  });
  const acceptedAt = prepared.acceptedAt;
  const submittedAt = prepared.submittedAt;
  const dedupKey = prepared.dedupKey;

  const callId = (input.newCallId ?? randomUUID)();
  const commitHash = sealedFhenixCommitHash({
    agent_id: agentId,
    market_id: market.market_id,
    market_config_version: market.market_config_version,
    chain_id: verifiedSubmit.chain_id,
    contract_address: verifiedSubmit.contract_address,
    onchain_call_id: verifiedSubmit.onchain_call_id,
    submit_tx_hash: verifiedSubmit.submit_tx_hash,
    submit_log_index: verifiedSubmit.submit_log_index,
    binary_index_ct_hash: verifiedSubmit.binary_index_ct_hash,
    confidence_ct_hash: verifiedSubmit.confidence_ct_hash,
    accepted_at: verifiedSubmit.accepted_at,
    reveal_open_at: verifiedSubmit.reveal_open_at,
  });
  const tx = db.transaction(() => {
    submissionsRepo.acceptSealedFhenixCall(db, {
      call_id: callId,
      agent_id: agentId,
      runtime_key_id: authResult.runtime_key?.runtime_key_id ?? null,
      client_order_id,
      horizon_seconds: market.horizon_seconds,
      submitted_at: submittedAt,
      accepted_at: acceptedAt,
      rationale: rationale ?? null,
      strategy_tag: strategy_tag ?? null,
      schema_version: SCHEMA_VERSION,
      scoring_version: SCORING_VERSION,
      dedup_key: dedupKey,
      commit_hash: commitHash,
      commit_scheme: "fhenix-sealed-v1",
      market_id: market.market_id,
      market_config_version: market.market_config_version,
      // Explicit, never defaulted: prepareSealedCallAcceptance has already
      // run requireMintableExternalMarket, which refuses a row without a
      // registered adapter_id and a matching market_family.
      adapter_id: market.adapter_id!,
      market_family: market.market_family!,
    });
    fhenixSealedCallsRepo.insert(db, {
      call_id: callId,
      chain_id: verifiedSubmit.chain_id,
      contract_address: verifiedSubmit.contract_address,
      onchain_call_id: verifiedSubmit.onchain_call_id,
      submit_tx_hash: verifiedSubmit.submit_tx_hash,
      submit_log_index: verifiedSubmit.submit_log_index,
      binary_index_ct_hash: verifiedSubmit.binary_index_ct_hash,
      confidence_ct_hash: verifiedSubmit.confidence_ct_hash,
      reveal_open_at: verifiedSubmit.reveal_open_at,
      created_at: nowIso(now()),
    });
    // Externally-resolved markets never anchor a t0 price, so a new sealed
    // call enters pending_t1 directly — the resolver's single adapter loop is
    // the only settlement surface. `pending_t0` survives in the persisted
    // status union purely so pre-existing rows can still drain (see
    // resolver.ts DRAINING_STATUSES); nothing writes it any more.
    submissionsRepo.setStatus(db, callId, "pending_t1");
    usageRepo.emit(
      db,
      makeSealedCallUsage(
        agentId,
        "submission_accepted",
        {
          call_id: callId,
          privacy_mode: "sealed_fhenix",
          market_id: market.market_id,
          chain_id: verifiedSubmit.chain_id,
          onchain_call_id: verifiedSubmit.onchain_call_id,
          ...runtimeKeyUsageAttributes(authResult),
        },
        now,
      ),
    );
  });
  try {
    tx();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existingAfter = submissionsRepo.findByClientOrderId(
        db,
        agentId,
        client_order_id,
      );
      if (existingAfter) {
        return replayFromExisting(existingAfter.call_id);
      }
      throw new VerdictError(
        "duplicate sealed Fhenix submission event",
        ERROR_CODES.duplicate,
        409,
      );
    }
    throw err;
  }

  return {
    status: 201,
    body: {
      call_id: callId,
      privacy_mode: "sealed_fhenix",
      market_id: market.market_id,
      status: "pending_t1",
      reveal_open_at: verifiedSubmit.reveal_open_at,
      onchain_call_id: verifiedSubmit.onchain_call_id,
      commit_hash: commitHash,
      idempotent_hit: false,
      tier: authResult.tier,
    },
    event: publicAcceptedCallEvent({
      db,
      call_id: callId,
      agent_id: agentId,
      accepted_at: acceptedAt,
      commit_hash: commitHash,
      market,
    }),
  };
}

export function sealedFhenixCommitHash(input: {
  agent_id: string;
  market_id: string;
  market_config_version: number;
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  submit_tx_hash: string;
  submit_log_index: number;
  binary_index_ct_hash: string;
  confidence_ct_hash: string;
  accepted_at: string;
  reveal_open_at: string;
}): string {
  const preimage = {
    schema: "murmur-verdict-fhenix-sealed@2",
    agent_id: input.agent_id,
    market_id: input.market_id,
    market_config_version: input.market_config_version,
    chain_id: input.chain_id,
    contract_address: input.contract_address,
    onchain_call_id: input.onchain_call_id,
    submit_tx_hash: input.submit_tx_hash,
    submit_log_index: input.submit_log_index,
    binary_index_ct_hash: input.binary_index_ct_hash,
    confidence_ct_hash: input.confidence_ct_hash,
    accepted_at: input.accepted_at,
    reveal_open_at: input.reveal_open_at,
  };
  return createHash("sha256").update(JSON.stringify(preimage)).digest("hex");
}
