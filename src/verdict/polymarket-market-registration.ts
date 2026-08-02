import type Database from "better-sqlite3";
import { z } from "zod";
import { polymarketGammaMarketConfigJson } from "../markets/polymarket-gamma/config.js";
import type { GammaMarketSnapshot } from "../markets/polymarket-gamma/transform.js";
import { marketsRepo } from "./repos/market-registry-repo.js";
import { agentSecurityEventsRepo } from "./repos/agent-security-events-repo.js";
import {
  ResolutionClassSchema,
  SCHEMA_VERSION,
  type ResolutionClass,
} from "./schema.js";
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

export interface PolymarketMarketRegistrationOperationInput {
  db: Database.Database;
  conditionId: string;
  status: "draft" | "listed" | "frozen" | "retired";
  horizon_seconds?: number;
  resolution_class?: ResolutionClass;
  /** Audit trail actor stamped on the security event (e.g. "admin_token",
   *  "polymarket_discovery"). */
  actor: string;
  gammaLookup?: PolymarketMarketRegistrationGammaAdapter;
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  now: () => Date;
}

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
  return runPolymarketMarketRegistration({
    db: input.db,
    conditionId: parsed.data.conditionId,
    status: parsed.data.status,
    horizon_seconds: parsed.data.horizon_seconds,
    resolution_class: parsed.data.resolution_class,
    actor: "admin_token",
    gammaLookup: input.gammaLookup,
    newAgentSecurityEventId: input.newAgentSecurityEventId,
    now: input.now,
  });
}

/**
 * Shared registration operation behind both the admin route and the
 * discovery ticker. The canonical market_id is the LOWERCASE conditionId —
 * the market registry schema only admits lowercase hex, so an uppercase
 * admin input must not create a shadow row that dedupe then misses.
 */
export async function runPolymarketMarketRegistration(
  input: PolymarketMarketRegistrationOperationInput,
): Promise<PolymarketMarketRegistrationResult> {
  const conditionId = input.conditionId.toLowerCase();
  const { status, horizon_seconds, resolution_class } = input;
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
  // Never trust the adapter's filtering: a snapshot for a DIFFERENT
  // conditionId would persist another market's config under this market_id.
  if (fetched.snapshot.conditionId.toLowerCase() !== conditionId) {
    return {
      status: 502,
      body: {
        code: "gamma_condition_mismatch",
        message: `Polymarket Gamma returned conditionId ${fetched.snapshot.conditionId} for requested ${conditionId}`,
      },
    };
  }

  // The sealed-call acceptance guard pins reveal_open_at to the persisted
  // endDate at millisecond precision, while the on-chain fixed reveal is
  // whole seconds. Floor the persisted date to the second so both layers
  // always agree.
  const snapshot = normalizeSnapshotEndDate(fetched.snapshot);
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
        actor: input.actor,
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

function normalizeSnapshotEndDate(
  snapshot: GammaMarketSnapshot,
): GammaMarketSnapshot {
  if (typeof snapshot.endDate !== "string") return snapshot;
  const endDateMs = Date.parse(snapshot.endDate);
  if (!Number.isFinite(endDateMs) || endDateMs % 1000 === 0) return snapshot;
  return {
    ...snapshot,
    endDate: new Date(Math.floor(endDateMs / 1000) * 1000).toISOString(),
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
