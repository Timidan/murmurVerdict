import type Database from "better-sqlite3";

import { deriveSeriesClock, type SeriesClockConfig } from "./series-clock.js";
import {
  marketClocksRepo,
  marketSeriesRepo,
} from "./repos/market-clocks-repo.js";
import { z } from "zod";
import {
  PolymarketGammaConfigError,
  polymarketGammaMarketConfig,
} from "../markets/polymarket-gamma/config.js";
import type { GammaMarketSnapshot } from "../markets/polymarket-gamma/transform.js";
import { marketsRepo } from "./repos/market-registry-repo.js";
import { venueMarketSeriesRepo } from "./repos/venue-market-series-repo.js";
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
  /**
   * Series schedule. Embargo stamp, series row and clock snapshot are written in the market's own
   * transaction; an unstamped market rejects every submission. Only `draft` markets may omit it.
   */
  schedule?: {
    seriesId: string;
    displayName: string;
    windowSeconds: number;
    clockConfig: SeriesClockConfig;
    maxArmedPerCall: number;
  };
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

// Mirrors the `schedule` field of PolymarketMarketRegistrationOperationInput; without it only `draft` is possible.
const PolymarketMarketRegistrationScheduleSchema = z
  .object({
    seriesId: z.string().min(1),
    displayName: z.string().min(1),
    windowSeconds: z.number().int().positive(),
    clockConfig: z
      .object({
        submissionOpenLeadSec: z.number().int().positive(),
        commitMarginSec: z.number().int().positive(),
        deliveryBudgetSec: z.number().int().positive(),
        embargoSec: z.number().int().positive(),
      })
      .strict(),
    maxArmedPerCall: z.number().int().positive(),
  })
  .strict();

const PolymarketMarketRegistrationBodySchema = z
  .object({
    conditionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    // Not defaulted: omitted keeps an existing market's status, or `draft` for a new one.
    // A default would demote a live market on a bare {conditionId} retry.
    status: z.enum(["draft", "listed", "frozen", "retired"]).optional(),
    schedule: PolymarketMarketRegistrationScheduleSchema.optional(),
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
  /** Omitted keeps an existing market's status; a new market becomes `draft`. */
  status?: "draft" | "listed" | "frozen" | "retired";
  horizon_seconds?: number;
  resolution_class?: ResolutionClass;
  /** Audit trail actor stamped on the security event (e.g. "admin_token",
   *  "polymarket_discovery"). */
  actor: string;
  gammaLookup?: PolymarketMarketRegistrationGammaAdapter;
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  /**
   * Series schedule. Embargo stamp, series row and clock snapshot are written in the market's own
   * transaction; an unstamped market rejects every submission. Only `draft` markets may omit it.
   */
  schedule?: {
    seriesId: string;
    displayName: string;
    windowSeconds: number;
    clockConfig: SeriesClockConfig;
    maxArmedPerCall: number;
  };
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
    // Body wins: a market discovery missed may not belong to the daemon's series.
    schedule: parsed.data.schedule ?? input.schedule,
    actor: "admin_token",
    gammaLookup: input.gammaLookup,
    newAgentSecurityEventId: input.newAgentSecurityEventId,
    now: input.now,
  });
}

/**
 * The actor string discovery registers under. Registration behaves differently
 * for it: it must never lift an operator halt, and must never touch a halted
 * market at all.
 */
export const DISCOVERY_ACTOR = "polymarket_discovery";

/**
 * Shared by the admin route and the discovery ticker. market_id is the lowercase
 * conditionId; the registry only admits lowercase hex.
 */
export async function runPolymarketMarketRegistration(
  input: PolymarketMarketRegistrationOperationInput,
): Promise<PolymarketMarketRegistrationResult> {
  const conditionId = input.conditionId.toLowerCase();
  const { horizon_seconds, resolution_class } = input;
  const existing = marketsRepo.get(input.db, conditionId);

  // Discovery must not touch a halted market at all; registration is a full upsert.
  if (input.actor === DISCOVERY_ACTOR && marketsRepo.isOperatorHalted(input.db, conditionId)) {
    return {
      status: 409,
      body: {
        code: "operator_halted",
        message:
          `market ${conditionId} was halted by an operator; discovery must not ` +
          `re-register it. Re-register it as an operator to resume.`,
      },
    };
  }
  // An omitted status keeps the existing one; `upsertExternalMarket` overwrites status on conflict.
  const status = input.status ?? existing?.status ?? "draft";

  const operationNow = input.now();

  // Status-only change on a bound market (emergency freeze/retire). Runs before the Gamma
  // fetch, since bad Gamma data is the usual reason to pull a market.
  const boundClockForStatus = marketClocksRepo.get(input.db, conditionId);
  if (boundClockForStatus && input.status && !input.schedule) {
    return statusOnlyUpdate({
      db: input.db,
      conditionId,
      status: input.status,
      existing,
      seriesId: boundClockForStatus.series_id,
      actor: input.actor,
      newAgentSecurityEventId: input.newAgentSecurityEventId,
      now: operationNow,
    });
  }

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

  // The acceptance guard pins reveal_open_at to endDate in ms; the on-chain reveal is whole
  // seconds, so floor to the second.
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

  // No usable endDate and no explicit horizon_seconds: refuse rather than invent one.
  if (!Number.isFinite(remainingSec) && horizon_seconds === undefined) {
    return {
      status: 422,
      body: {
        code: "market_end_date_unusable",
        message:
          `Polymarket returned no usable endDate for ${conditionId}, and no explicit ` +
          `horizon_seconds was supplied. Refusing to invent one — the market's whole ` +
          `schedule derives from it.`,
        endDate: snapshot.endDate ?? null,
      },
    };
  }

  const horizonSec =
    horizon_seconds ?? Math.max(60, remainingSec);

  // A bound market's schedule must never move: restate the same schedule or be refused.
  // `market_clocks` is insert-only, but the upsert below rewrites the embargo stamp and status.
  const boundClock = marketClocksRepo.get(input.db, conditionId);
  if (boundClock) {
    if (!input.schedule) {
      return {
        status: 409,
        body: {
          code: "schedule_immutable",
          message:
            `market ${conditionId} is already bound to series ${boundClock.series_id}; ` +
            `re-registering without a schedule would strip its embargo stamp. ` +
            `Restate the same schedule, state a status to change only that, or ` +
            `leave the market alone.`,
          series_id: boundClock.series_id,
        },
      };
    }
    const restated = deriveSeriesClock({
      endDateMs,
      windowSec: input.schedule.windowSeconds,
      config: input.schedule.clockConfig,
    });
    // Compare the cohort cap too: eligibility reads the current series value, so a new cap
    // would resize existing cohorts.
    const boundSeries = marketSeriesRepo.get(input.db, boundClock.series_id);
    const drift =
      input.schedule.seriesId !== boundClock.series_id ||
      (boundSeries !== null &&
        (boundSeries.max_armed_per_call !== input.schedule.maxArmedPerCall ||
          boundSeries.window_seconds !== input.schedule.windowSeconds)) ||
      endDateMs !== boundClock.derived_from_end_date_ms ||
      restated.armCloseAtMs !== boundClock.arm_close_at_ms ||
      restated.submissionOpenAtMs !== boundClock.submission_open_at_ms ||
      restated.earlyAccessCutoffAtMs !== boundClock.early_access_cutoff_at_ms ||
      restated.submissionCloseAtMs !== boundClock.submission_close_at_ms ||
      restated.marketResolutionAtMs !== boundClock.resolution_at_ms ||
      restated.publicRevealAtMs !== boundClock.public_reveal_at_ms;
    if (drift) {
      return {
        status: 409,
        body: {
          code: "schedule_immutable",
          message:
            `market ${conditionId} is already bound to series ${boundClock.series_id}; ` +
            `the supplied schedule differs from the bound one (clock, window or ` +
            `cohort cap). Terms consumers may already have armed against cannot ` +
            `be changed by re-registering.`,
          series_id: boundClock.series_id,
          bound_public_reveal_at_ms: boundClock.public_reveal_at_ms,
          supplied_public_reveal_at_ms: restated.publicRevealAtMs,
        },
      };
    }
  }

  // Past draft, a market needs a schedule or the acceptance guard rejects every submission.
  // Checked after snapshot validation so more specific rejections win.
  if (!input.schedule && status !== "draft") {
    return {
      status: 400,
      body: {
        code: "schedule_required",
        message:
          `cannot register market ${conditionId} as '${status}' without a series schedule; ` +
          `an unscheduled market has no embargo stamp and would reject every submission. ` +
          `Register it as 'draft', or supply a schedule.`,
      },
    };
  }




  const slugCandidate = typeof snapshot.slug === "string" ? snapshot.slug : null;
  // The projection refuses to invent a missing slug or outcome labels; surface that as a 422, not a 500.
  let config: ReturnType<typeof polymarketGammaMarketConfig>;
  try {
    config = polymarketGammaMarketConfig({
      conditionId,
      snapshot,
      resolutionClass: resolution_class,
    });
  } catch (err) {
    if (!(err instanceof PolymarketGammaConfigError)) throw err;
    return {
      status: 422,
      body: {
        code: "market_snapshot_unusable",
        message: err.message,
      },
    };
  }
  const configJson = JSON.stringify(config);
  const createdAt = operationNow;
  const created_at = nowIso(createdAt);

  // Venue series from the validated config; needs a non-empty slug and title.
  // Null reads downstream as "no series" (unsellable) and is never fabricated.
  const seriesInput =
    typeof config.series_slug === "string" &&
    config.series_slug.length > 0 &&
    typeof config.series_title === "string" &&
    config.series_title.length > 0
      ? {
          venue: "polymarket",
          series_slug: config.series_slug,
          series_title: config.series_title,
          venue_category:
            typeof config.venue_category === "string" &&
            config.venue_category.length > 0
              ? config.venue_category
              : null,
          source_adapter_id: "polymarket-gamma",
          now: created_at,
        }
      : null;

  // Upsert + audit event stay in one transaction so a crash cannot land a
  // market mutation without the corresponding operator evidence.
  const row = input.db.transaction(() => {
    // Only an operator re-registration lifts an operator halt; discovery never does.
    if (input.actor !== DISCOVERY_ACTOR) {
      marketsRepo.clearOperatorHalt(input.db, conditionId);
    }
    // The series row must exist before the market FKs to it; same transaction keeps both atomic.
    const venueSeriesId = seriesInput
      ? venueMarketSeriesRepo.upsert(input.db, seriesInput).venue_series_id
      : null;
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
      venue_series_id: venueSeriesId,
    });
    // Schedule writes share the upsert's transaction so a market never exists without its embargo stamp.
    if (input.schedule) {
      const sched = input.schedule;
      marketSeriesRepo.upsert(input.db, {
        series_id: sched.seriesId,
        venue: "polymarket",
        display_name: sched.displayName,
        window_seconds: sched.windowSeconds,
        clock: sched.clockConfig,
        max_armed_per_call: sched.maxArmedPerCall,
        now: created_at,
      });
      const stamped = marketsRepo.get(input.db, conditionId);
      if (stamped) {
        const cfg = JSON.parse(stamped.config_json) as Record<string, unknown>;
        cfg.embargoSec = sched.clockConfig.embargoSec;
        marketsRepo.setConfigJson(input.db, conditionId, JSON.stringify(cfg));
      }
      // Insert-only: never retime a schedule someone already armed against.
      if (!marketClocksRepo.get(input.db, conditionId)) {
        marketClocksRepo.insert(input.db, {
          market_id: conditionId,
          series_id: sched.seriesId,
          clock: deriveSeriesClock({
            endDateMs,
            windowSec: sched.windowSeconds,
            config: sched.clockConfig,
          }),
          derived_from_end_date_ms: endDateMs,
          now: created_at,
        });
      }
    }
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

/**
 * Change only a bound market's status: no Gamma call, no config, clock or series write.
 * Full registration can't do this once Gamma's endDate has drifted.
 */
function statusOnlyUpdate(input: {
  db: Database.Database;
  conditionId: string;
  status: "draft" | "listed" | "frozen" | "retired";
  existing: { status: string } | null;
  seriesId: string;
  actor: string;
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  now: Date;
}): PolymarketMarketRegistrationResult {
  // `listed` is refused: listing is what registration is for, and it needs the
  // schedule validation this path deliberately skips.
  if (input.status === "listed") {
    return {
      status: 409,
      body: {
        code: "schedule_required",
        message:
          `cannot list ${input.conditionId} without restating its schedule; ` +
          `only draft/frozen/retired can be set without one.`,
      },
    };
  }
  const row = input.db.transaction(() => {
    // Status and halt in one write, so an in-flight discovery receipt can't relist.
    // Lifted only by a full re-registration.
    marketsRepo.haltByOperator(
      input.db,
      input.conditionId,
      input.status,
      nowIso(input.now),
    );
    const persisted = marketsRepo.get(input.db, input.conditionId);
    agentSecurityEventsRepo.emit(
      input.db,
      makeAgentSecurityEvent({
        kind: "admin_market_status_change",
        actor: input.actor,
        newEventId: input.newAgentSecurityEventId,
        payload: {
          conditionId: input.conditionId,
          status: input.status,
          previous_status: input.existing?.status ?? null,
          series_id: input.seriesId,
        },
        createdAt: input.now,
      }),
    );
    return persisted;
  })();

  return {
    status: 200,
    body: { schema_version: SCHEMA_VERSION, market: row },
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
  // Only registration reads parent-event tags (the venue category source); hotter loops opt out.
  return new PolymarketGammaClient({
    nowMs: () => operationNowMs,
    enrichEventTags: true,
  });
}
