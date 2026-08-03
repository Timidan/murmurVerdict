import type Database from "better-sqlite3";

import { agentsRepo } from "./repos/agents-repo.js";
import type { MarketRow } from "./repos/market-registry-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import { usageRepo } from "./repos/usage-events-repo.js";
import {
  acceptsSubmissions,
  buildMarketDedupKey,
  perMarketDailyCap,
} from "./markets.js";
import {
  ERROR_CODES,
  SUBMISSION_LIMITS,
  VerdictError,
} from "./schema.js";
import {
  ExternalMarketValidationError,
  requireMintableExternalMarket,
} from "./external-market-guard.js";
import type { AuthIdentity as DispatchedAuthIdentity } from "./auth/dispatcher.js";
import type { VerifiedSealedCallSubmitted } from "../integrations/fhenix-events.js";
import { expectedRevealOpenMsForMarket } from "./market-adapter-config.js";
import { isoFromMs, parseIsoMs } from "./time.js";
import { makeSealedCallUsage } from "./sealed-call-usage.js";

export interface PreparedSealedCallAcceptance {
  acceptedAt: string;
  submittedAt: string;
  dedupKey: string;
}

export function requireSealedCallAcceptanceAgent(
  authResult: DispatchedAuthIdentity,
): string {
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
  return authResult.agent_id;
}

export function prepareSealedCallAcceptance(params: {
  db: Database.Database;
  agentId: string;
  market: MarketRow;
  client_order_id: string;
  submitted_at?: string;
  verifiedSubmit: VerifiedSealedCallSubmitted;
  now: () => Date;
}): PreparedSealedCallAcceptance {
  const {
    db,
    agentId,
    market,
    submitted_at,
    verifiedSubmit,
    now,
  } = params;

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
    requireMintableExternalMarket(market);
  } catch (err) {
    if (err instanceof ExternalMarketValidationError) {
      usageRepo.emit(
        db,
        makeSealedCallUsage(
          agentId,
          "submission_rejected",
          {
            reason: "external_market_invalid",
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
          reason: "external_market_invalid",
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

  return {
    acceptedAt,
    submittedAt,
    dedupKey,
  };
}
