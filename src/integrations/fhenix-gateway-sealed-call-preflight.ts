import type Database from "better-sqlite3";

import { agentsRepo } from "../verdict/repos/agents-repo.js";
import { fhenixGatewayTxRepo } from "../verdict/repos/fhenix-gateway-tx-repo.js";
import { marketsRepo } from "../verdict/repos/market-registry-repo.js";
import { submissionsRepo } from "../verdict/repos/sealed-call-submissions-repo.js";
import {
  acceptsSubmissions,
  perMarketDailyCap,
} from "../verdict/markets.js";
import {
  derivePolicyFromMarket,
  PolicyDerivationError,
} from "../verdict/oracle-routing.js";
import {
  ERROR_CODES,
  SUBMISSION_LIMITS,
  VerdictError,
} from "../verdict/schema.js";
import { isoFromMs } from "../verdict/time.js";

type GatewayMarket = NonNullable<ReturnType<typeof marketsRepo.get>>;

export function preflightMarketAndRateLimits(
  db: Database.Database,
  agentId: string,
  market: GatewayMarket,
  now: () => Date,
): void {
  if (!acceptsSubmissions(market)) {
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
  const activeCount =
    agentsRepo.countActiveCallsForAgent(db, agentId) +
    fhenixGatewayTxRepo.countInflightByAgent(db, agentId);
  if (activeCount >= SUBMISSION_LIMITS.max_active_calls_per_agent) {
    throw new VerdictError(
      `max ${SUBMISSION_LIMITS.max_active_calls_per_agent} active calls per agent`,
      ERROR_CODES.rate_limited,
      429,
    );
  }
  const since = isoFromMs(now().getTime() - 24 * 60 * 60 * 1000);
  const cap = perMarketDailyCap(market.market_id);
  const count =
    submissionsRepo.countCallsForAgentMarketWindow(db, agentId, market.market_id, since) +
    fhenixGatewayTxRepo.countInflightByAgentMarketWindow(db, agentId, market.market_id, since);
  if (count >= cap) {
    throw new VerdictError(
      `max ${cap} calls/market/24h on ${market.market_id}`,
      ERROR_CODES.rate_limited,
      429,
      { market_id: market.market_id, cap },
    );
  }
}
