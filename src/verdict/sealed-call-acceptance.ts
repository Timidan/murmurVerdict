import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  agentsRepo,
  fhenixSealedCallsRepo,
  isUniqueViolation,
  submissionsRepo,
  usageRepo,
  type MarketRow,
} from "./db.js";
import {
  acceptsSubmissions,
  buildMarketDedupKey,
  perMarketDailyCap,
} from "./markets.js";
import {
  ERROR_CODES,
  SCHEMA_VERSION,
  SCORING_VERSION,
  SUBMISSION_LIMITS,
  type UsageEvent,
  VerdictError,
} from "./schema.js";
import {
  derivePolicyFromMarket,
  PolicyDerivationError,
} from "./oracle-routing.js";
import type { AuthIdentity as DispatchedAuthIdentity } from "./auth/dispatcher.js";
import type { CallAcceptedEvent } from "./events.js";
import type { VerifiedSealedCallSubmitted } from "../integrations/fhenix-events.js";
import {
  expectedRevealOpenMsForMarket,
} from "./market-adapter-config.js";
import { isoFromMs, nowIso, parseIsoMs } from "./time.js";

export interface SealedCallAcceptanceInput {
  db: Database.Database;
  authResult: DispatchedAuthIdentity;
  market: MarketRow;
  client_order_id: string;
  submitted_at?: string;
  rationale?: string;
  strategy_tag?: string;
  verifiedSubmit: VerifiedSealedCallSubmitted;
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

  if (authResult.agent_kind === "attested") {
    throw new VerdictError(
      "attested-tier sealed Fhenix acceptance is not yet supported",
      ERROR_CODES.agent_not_authorized,
      503,
    );
  }
  if (!authResult.agent_id) {
    throw new VerdictError(
      "agent identity required before accepting sealed Fhenix calls",
      ERROR_CODES.agent_slug_required,
      400,
    );
  }
  const agentId = authResult.agent_id;

  const existing = submissionsRepo.findByClientOrderId(
    db,
    agentId,
    client_order_id,
  );
  if (existing) {
    const existingCtx = submissionsRepo.loadResolverContext(db, existing.call_id);
    if (existingCtx?.privacy_mode !== "sealed_fhenix") {
      throw new VerdictError(
        "client_order_id is already bound to a non-sealed_fhenix call",
        ERROR_CODES.duplicate,
        409,
        { existing_call_id: existing.call_id },
      );
    }
    const sealed = fhenixSealedCallsRepo.byCallId(db, existing.call_id);
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
        { existing_call_id: existing.call_id },
      );
    }
    return {
      status: 200,
      body: {
        call_id: existing.call_id,
        privacy_mode: "sealed_fhenix",
        market_id: existingCtx.market_id,
        status: existingCtx.status,
        reveal_open_at: sealed?.reveal_open_at ?? null,
        onchain_call_id: sealed?.onchain_call_id ?? null,
        idempotent_hit: true,
        tier: authResult.tier,
      },
    };
  }

  if (!acceptsSubmissions(market)) {
    usageRepo.emit(
      db,
      makeSealedCallUsage(
        agentId,
        "submission_rejected",
        {
          reason: "market_not_listed",
          market_id: market.market_id,
          status: market.status,
        },
        now,
      ),
    );
    throw new VerdictError(
      `market ${market.market_id} status=${market.status} (not accepting submissions)`,
      ERROR_CODES.asset_not_supported,
      400,
      {
        reason: "market_not_listed",
        market_id: market.market_id,
        market_status: market.status,
      },
    );
  }

  try {
    derivePolicyFromMarket(db, market);
  } catch (err) {
    if (err instanceof PolicyDerivationError) {
      usageRepo.emit(
        db,
        makeSealedCallUsage(
          agentId,
          "submission_rejected",
          {
            reason: "policy_derivation_failed",
            market_id: market.market_id,
            cause: err.cause,
          },
          now,
        ),
      );
      throw new VerdictError(
        `cannot mint call on ${market.market_id}: ${err.message}`,
        ERROR_CODES.asset_not_supported,
        400,
        {
          reason: "policy_derivation_failed",
          market_id: market.market_id,
          cause: err.cause,
        },
      );
    }
    throw err;
  }

  const acceptedAtMs = parseIsoMs(verifiedSubmit.accepted_at, "fhenix.accepted_at");
  const revealOpenMs = parseIsoMs(
    verifiedSubmit.reveal_open_at,
    "fhenix.reveal_open_at",
  );
  const expectedRevealOpenMs = expectedRevealOpenMsForMarket(market, acceptedAtMs);
  if (expectedRevealOpenMs <= acceptedAtMs) {
    throw new VerdictError(
      "market resolution window is already closed; refusing sealed call",
      ERROR_CODES.schema_invalid,
      400,
      {
        market_id: market.market_id,
        accepted_at: verifiedSubmit.accepted_at,
        expected_reveal_open_at: isoFromMs(expectedRevealOpenMs),
      },
    );
  }
  if (revealOpenMs !== expectedRevealOpenMs) {
    throw new VerdictError(
      "fhenix.reveal_open_at must equal the market reveal window",
      ERROR_CODES.schema_invalid,
      400,
      {
        accepted_at: verifiedSubmit.accepted_at,
        reveal_open_at: verifiedSubmit.reveal_open_at,
        expected_reveal_open_at: isoFromMs(expectedRevealOpenMs),
        horizon_seconds: market.horizon_seconds,
      },
    );
  }
  if (acceptedAtMs > now().getTime() + 5 * 60 * 1000) {
    throw new VerdictError(
      "fhenix.accepted_at is too far in the future",
      ERROR_CODES.schema_invalid,
      400,
    );
  }

  const activeCount = agentsRepo.countActiveCallsForAgent(db, agentId);
  if (activeCount >= SUBMISSION_LIMITS.max_active_calls_per_agent) {
    usageRepo.emit(
      db,
      makeSealedCallUsage(
        agentId,
        "submission_rejected",
        { reason: "max_active" },
        now,
      ),
    );
    throw new VerdictError(
      `max ${SUBMISSION_LIMITS.max_active_calls_per_agent} active calls per agent`,
      ERROR_CODES.rate_limited,
      429,
    );
  }
  const since = isoFromMs(now().getTime() - 24 * 60 * 60 * 1000);
  const perMarketCap = perMarketDailyCap(market.market_id);
  const todayMarketCount = submissionsRepo.countCallsForAgentMarketWindow(
    db,
    agentId,
    market.market_id,
    since,
  );
  if (todayMarketCount >= perMarketCap) {
    usageRepo.emit(
      db,
      makeSealedCallUsage(
        agentId,
        "submission_rejected",
        {
          reason: "daily_cap_market",
          market_id: market.market_id,
          cap: perMarketCap,
        },
        now,
      ),
    );
    throw new VerdictError(
      `max ${perMarketCap} calls/market/24h on ${market.market_id}`,
      ERROR_CODES.rate_limited,
      429,
      { market_id: market.market_id, cap: perMarketCap },
    );
  }

  const acceptedAt = verifiedSubmit.accepted_at;
  const submittedAt = submitted_at ?? acceptedAt;
  const dedupKey = buildMarketDedupKey({
    agent_id: agentId,
    market_id: market.market_id,
    horizon_seconds: market.horizon_seconds,
    accepted_at_iso: acceptedAt,
  });
  const duplicate = submissionsRepo.findByDedupKey(db, dedupKey);
  if (duplicate) {
    usageRepo.emit(
      db,
      makeSealedCallUsage(
        agentId,
        "submission_rejected",
        { reason: "dedup" },
        now,
      ),
    );
    throw new VerdictError(
      "duplicate submission inside dedup window",
      ERROR_CODES.duplicate,
      409,
      { existing_call_id: duplicate.call_id },
    );
  }

  const callId = randomUUID();
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
      adapter_id: market.adapter_id ?? "native-price",
      market_family: market.market_family ?? "financial-direction",
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
    submissionsRepo.setStatus(db, callId, "pending_t0");
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
        return {
          status: 200,
          body: {
            call_id: existingAfter.call_id,
            privacy_mode: "sealed_fhenix",
            market_id: market.market_id,
            status: "pending_t0",
            reveal_open_at: verifiedSubmit.reveal_open_at,
            onchain_call_id: verifiedSubmit.onchain_call_id,
            idempotent_hit: true,
            tier: authResult.tier,
          },
        };
      }
      throw new VerdictError(
        "duplicate sealed Fhenix submission event",
        ERROR_CODES.duplicate,
        409,
      );
    }
    throw err;
  }

  const agent = agentsRepo.byId(db, agentId);
  return {
    status: 201,
    body: {
      call_id: callId,
      privacy_mode: "sealed_fhenix",
      market_id: market.market_id,
      status: "pending_t0",
      reveal_open_at: verifiedSubmit.reveal_open_at,
      onchain_call_id: verifiedSubmit.onchain_call_id,
      commit_hash: commitHash,
      idempotent_hit: false,
      tier: authResult.tier,
    },
    event: {
      type: "call.accepted",
      call_id: callId,
      agent_id: agentId,
      agent_slug: agent?.display_slug ?? agentId,
      privacy_mode: "sealed_fhenix",
      accepted_at: acceptedAt,
      commit_hash: commitHash,
      adapter_id: market.adapter_id ?? "native-price",
      market_family: market.market_family ?? "financial-direction",
      market_id: market.market_id,
    },
  };
}

export function makeSealedCallUsage(
  agent_id: string | null,
  kind: UsageEvent["kind"],
  attributes: Record<string, unknown>,
  now: () => Date,
): UsageEvent {
  return {
    event_id: randomUUID(),
    agent_id,
    kind,
    ts: nowIso(now()),
    attributes,
  };
}

function runtimeKeyUsageAttributes(
  authResult: DispatchedAuthIdentity,
): Record<string, string> {
  if (!authResult.runtime_key) return {};
  return {
    runtime_key_id: authResult.runtime_key.runtime_key_id,
    runtime_key_policy_hash: authResult.runtime_key.policy_hash,
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
