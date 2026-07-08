import type Database from "better-sqlite3";
import { z } from "zod";
import { polymarketGammaMarketConfigJson } from "../markets/polymarket-gamma/config.js";
import type { GammaMarketSnapshot } from "../markets/polymarket-gamma/transform.js";
import { marketsRepo } from "./repos/market-registry-repo.js";
import { agentSecurityEventsRepo } from "./repos/agent-security-events-repo.js";
import { ResolutionClassSchema, SCHEMA_VERSION } from "./schema.js";
import { nowIso } from "./time.js";
import {
  makeAgentSecurityEvent,
  type AgentSecurityEventIdAdapter,
} from "./agent-security-event.js";

export interface PolymarketMarketRegistrationInput {
  db: Database.Database;
  body: unknown;
  gammaLookup?: PolymarketMarketRegistrationGammaAdapter;
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  now: () => Date;
}

export interface PolymarketMarketRegistrationGammaResult {
  snapshot: GammaMarketSnapshot | null;
  error: string | null;
}

export interface PolymarketMarketRegistrationGammaAdapter {
  fetchMarketByConditionId(
    conditionId: string,
  ): Promise<PolymarketMarketRegistrationGammaResult>;
}

export interface PolymarketMarketRegistrationResult {
  status: number;
  body: unknown;
}

export interface PolymarketMarketRegistrationJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendPolymarketMarketRegistrationJsonResponse(
  res: PolymarketMarketRegistrationJsonResponseTarget,
  result: PolymarketMarketRegistrationResult,
): void {
  res.status(result.status).json(result.body);
}

const PolymarketMarketRegistrationBodySchema = z
  .object({
    conditionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    // Operators almost always want a freshly registered Polymarket market
    // to accept submissions immediately.
    status: z.enum(["draft", "listed", "frozen", "retired"]).default("listed"),
    // Optional override; otherwise derived from the Gamma row's endDate.
    horizon_seconds: z.number().int().positive().optional(),
    // Optional Murmur-native market taxonomy override. This lets a
    // Polymarket binary row identify as sports_match, event_binary, etc.
    resolution_class: ResolutionClassSchema.optional(),
  })
  .strict();

export async function registerPolymarketMarketFromAdminBody(
  input: PolymarketMarketRegistrationInput,
): Promise<PolymarketMarketRegistrationResult> {
  const parsed = PolymarketMarketRegistrationBodySchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        code: "schema_invalid",
        issues: parsed.error.format(),
      },
    };
  }
  const { conditionId, status, horizon_seconds, resolution_class } = parsed.data;
  const operationNow = input.now();
  const operationNowMs = operationNow.getTime();
  const gammaLookup = input.gammaLookup ??
    (await livePolymarketMarketRegistrationGammaAdapter(operationNowMs));
  const fetched = await gammaLookup.fetchMarketByConditionId(conditionId);
  if (!fetched.snapshot) {
    return {
      status: 502,
      body: {
        code: "gamma_fetch_failed",
        message: `Polymarket Gamma returned no snapshot for ${conditionId}`,
        gamma_error: fetched.error,
      },
    };
  }

  const snapshot = fetched.snapshot;
  const endDateMs = snapshot.endDate ? Date.parse(snapshot.endDate) : Number.NaN;
  // Refuse to mark a past-ended Polymarket market `listed`; otherwise it
  // would accept submissions and resolve effectively immediately.
  const remainingSec = Number.isFinite(endDateMs)
    ? Math.floor((endDateMs - operationNowMs) / 1000)
    : Number.NaN;
  const endDatePast = Number.isFinite(remainingSec) && remainingSec <= 0;
  if (endDatePast && status === "listed") {
    return {
      status: 422,
      body: {
        code: "market_already_resolved",
        message:
          "Polymarket endDate is in the past; refuse to upsert as 'listed' (use status='frozen' to register a backfill row).",
        endDate: snapshot.endDate ?? null,
      },
    };
  }

  const derivedHorizonSec = Number.isFinite(remainingSec)
    ? Math.max(60, remainingSec)
    : 7 * 24 * 60 * 60;
  const horizonSec = horizon_seconds ?? derivedHorizonSec;
  const slugCandidate = typeof snapshot.slug === "string" ? snapshot.slug : null;
  const configJson = polymarketGammaMarketConfigJson({
    conditionId,
    snapshot,
    resolutionClass: resolution_class,
  });
  const createdAt = operationNow;
  const created_at = nowIso(createdAt);

  // Upsert + audit event stay in one transaction so a crash cannot land a
  // market mutation without the corresponding operator evidence.
  const row = input.db.transaction(() => {
    marketsRepo.upsertExternalMarket(input.db, {
      market_id: conditionId,
      asset_id: "polymarket:event",
      market_kind: "event_binary",
      horizon_seconds: horizonSec,
      primary_oracle_id: "polymarket-gamma-oracle",
      adapter_id: "polymarket-gamma",
      market_family: "prediction-market-binary",
      scoring_kind: "multinomial_brier",
      config_json: configJson,
      void_band: "0",
      status,
      created_at,
    });
    const persisted = marketsRepo.get(input.db, conditionId);
    agentSecurityEventsRepo.emit(
      input.db,
      makeAgentSecurityEvent({
        kind: "admin_polymarket_upsert",
        actor: "admin_token",
        newEventId: input.newAgentSecurityEventId,
        payload: {
          conditionId,
          status,
          requested_horizon_seconds: horizonSec,
          persisted_horizon_seconds: persisted?.horizon_seconds ?? null,
          slug: slugCandidate ?? null,
        },
        createdAt,
      }),
    );
    return persisted;
  })();

  return {
    status: 201,
    body: {
      schema_version: SCHEMA_VERSION,
      market: row,
    },
  };
}

async function livePolymarketMarketRegistrationGammaAdapter(
  operationNowMs: number,
): Promise<PolymarketMarketRegistrationGammaAdapter> {
  const { registerPolymarketGammaAdapter } = await import(
    "../markets/polymarket-gamma/register.js"
  );
  registerPolymarketGammaAdapter({ nowMs: () => operationNowMs });
  const { PolymarketGammaClient } = await import(
    "../markets/polymarket-gamma/client.js"
  );
  return new PolymarketGammaClient({ nowMs: () => operationNowMs });
}
