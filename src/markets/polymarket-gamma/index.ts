/**
 * Polymarket Gamma adapter: binary markets only (NegRisk legs list as
 * separate binary markets).
 *
 * `observeResolution` must never throw: a throw aborts the resolver tick for
 * every market. Failures become 'pending' plus an error code.
 */

import { z } from "zod";
import {
  callScore,
  type Commitment,
  type MarketRef,
  type Outcome,
} from "../../verdict/markets-core.js";
import type {
  MarketMakerAdapter,
  ObservationContext,
} from "../types.js";
import { CommitmentSchema } from "../../verdict/markets-core.js";
import { PolymarketGammaClient } from "./client.js";
import { PolymarketClobClient } from "./clob-client.js";
import { clobMarketToOutcome } from "./clob-transform.js";
import {
  marketConfigSchema,
  POLYMARKET_CONDITION_ID_REGEX,
} from "./config.js";
import { gammaMarketToOutcome } from "./transform.js";
export {
  marketConfigSchema,
  POLYMARKET_CONDITION_ID_REGEX,
} from "./config.js";

export const ADAPTER_NAME = "polymarket-gamma" as const;
export const ADAPTER_VERSION = "1.1.0" as const;
export const MARKET_FAMILY = "prediction-market-binary" as const;

// ─── Schemas ────────────────────────────────────────────────────────────────

/** Universal commitment narrowed to a binary Polymarket conditionId. Fractional vectors like [7,3]/10 are fine. */
export const commitmentSchema = CommitmentSchema.superRefine((c, ctx) => {
  if (c.predictedOutcome.kind !== "binary") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "polymarket-gamma only accepts predictedOutcome.kind='binary'",
      path: ["predictedOutcome", "kind"],
    });
  }
  if (c.predictedOutcome.payoutNumerators.length !== 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "polymarket-gamma expects payoutNumerators.length === 2 (binary YES/NO; NegRisk legs list as independent binary markets)",
      path: ["predictedOutcome", "payoutNumerators"],
    });
  }
  if (c.marketRef.protocol !== ADAPTER_NAME) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `polymarket-gamma rejects marketRef.protocol='${c.marketRef.protocol}'`,
      path: ["marketRef", "protocol"],
    });
  }
  if (!POLYMARKET_CONDITION_ID_REGEX.test(c.marketRef.sourceId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "marketRef.sourceId must be a 32-byte hex conditionId (e.g. '0x19525413...')",
      path: ["marketRef", "sourceId"],
    });
  }
}) as unknown as z.ZodSchema<Commitment>;

// ─── Observation context ────────────────────────────────────────────────────

/** Resolver context, narrowed structurally from {@link ObservationContext}. */
export interface PolymarketGammaContext {
  /** From `config_json.conditionId`, else `markets.id`. */
  conditionId: string;
  market_id: string;
  /** Stored endDate; gates and timestamps the CLOB fallback. */
  endDate?: string;
  /** Stored outcomes: the payout-vector label order. */
  outcomes?: string[];
  /** Stored `normalized label → clob token_id`. */
  clobTokenIds?: Record<string, string>;
  /** Defaults to the module singleton. */
  client?: PolymarketGammaClient;
  /** Defaults to the module singleton. */
  clobClient?: PolymarketClobClient;
  /** Defaults to the boot clock, then Date.now. */
  nowMs?: () => number;
  /** Error codes ('http_404', 'network:*', 'schema_drift:*'). */
  onError?: (code: string) => void;
}

function narrowContext(ctx: ObservationContext): PolymarketGammaContext | null {
  if (typeof ctx.conditionId !== "string") return null;
  if (!POLYMARKET_CONDITION_ID_REGEX.test(ctx.conditionId)) return null;
  if (typeof ctx.market_id !== "string") return null;
  const narrowed: PolymarketGammaContext = {
    conditionId: ctx.conditionId,
    market_id: ctx.market_id,
  };
  if (typeof ctx.endDate === "string") {
    narrowed.endDate = ctx.endDate;
  }
  if (
    Array.isArray(ctx.outcomes) &&
    ctx.outcomes.length === 2 &&
    ctx.outcomes.every((label) => typeof label === "string" && label.length > 0)
  ) {
    narrowed.outcomes = ctx.outcomes as string[];
  }
  if (
    ctx.clobTokenIds !== null &&
    typeof ctx.clobTokenIds === "object" &&
    !Array.isArray(ctx.clobTokenIds) &&
    Object.values(ctx.clobTokenIds).every((id) => typeof id === "string")
  ) {
    narrowed.clobTokenIds = ctx.clobTokenIds as Record<string, string>;
  }
  if (ctx.client instanceof PolymarketGammaClient) {
    narrowed.client = ctx.client;
  }
  if (ctx.clobClient instanceof PolymarketClobClient) {
    narrowed.clobClient = ctx.clobClient;
  }
  if (typeof ctx.nowMs === "function") {
    narrowed.nowMs = ctx.nowMs as () => number;
  }
  if (typeof ctx.onError === "function") {
    narrowed.onError = ctx.onError as (code: string) => void;
  }
  return narrowed;
}

// ─── Default Gamma client (module-level singleton) ─────────────────────────

let defaultClient: PolymarketGammaClient | null = null;
function getDefaultClient(): PolymarketGammaClient | null {
  return defaultClient;
}

let defaultClobClient: PolymarketClobClient | null = null;
let defaultNowMs: (() => number) | null = null;

/** One process-wide CLOB client so the resolver and sync ticker share its cache and breaker. */
export function getDefaultPolymarketClobClient(): PolymarketClobClient | null {
  return defaultClobClient;
}

/** Test/boot injection. */
export function setDefaultPolymarketClient(
  client: PolymarketGammaClient | null,
): void {
  defaultClient = client;
}

/** Test/boot injection. */
export function setDefaultPolymarketClobClient(
  client: PolymarketClobClient | null,
): void {
  defaultClobClient = client;
}

export function setDefaultPolymarketClock(nowMs: () => number): void {
  defaultClient = new PolymarketGammaClient({ nowMs });
  defaultClobClient = new PolymarketClobClient({ nowMs });
  defaultNowMs = nowMs;
}

// ─── CLOB fallback (post-disappearance resolution recovery) ────────────────

/** Ask CLOB once Gamma has no row, and only after the stored endDate has passed. */
async function observeClobFallback(
  narrowed: PolymarketGammaContext,
): Promise<Outcome | "pending"> {
  const endDateMs =
    typeof narrowed.endDate === "string" ? Date.parse(narrowed.endDate) : Number.NaN;
  if (!Number.isFinite(endDateMs)) return "pending";
  // Resolver contexts carry no clock; prefer the boot clock over wall time.
  const nowMs = narrowed.nowMs
    ? narrowed.nowMs()
    : defaultNowMs
      ? defaultNowMs()
      : Date.now();
  if (endDateMs > nowMs) return "pending";
  if (!narrowed.outcomes) {
    narrowed.onError?.("clob:missing_stored_outcomes");
    return "pending";
  }
  const clobClient = narrowed.clobClient ?? getDefaultPolymarketClobClient();
  if (!clobClient) {
    narrowed.onError?.("clob:client_unconfigured");
    return "pending";
  }
  const result = await clobClient.fetchMarketByConditionId(narrowed.conditionId);
  if (result.error) narrowed.onError?.(`clob:${result.error}`);
  if (result.snapshot === null) return "pending";
  const mapped = clobMarketToOutcome({
    conditionId: narrowed.conditionId,
    storedOutcomes: narrowed.outcomes,
    storedClobTokenIds: narrowed.clobTokenIds,
    endDate: narrowed.endDate,
    snapshot: result.snapshot,
  });
  if (mapped.kind === "pending") {
    if (mapped.error) narrowed.onError?.(`clob:${mapped.error}`);
    return "pending";
  }
  return mapped.outcome;
}

// ─── Adapter implementation ────────────────────────────────────────────────

class PolymarketGammaAdapter implements MarketMakerAdapter {
  readonly name = ADAPTER_NAME;
  readonly version = ADAPTER_VERSION;
  readonly marketFamily = MARKET_FAMILY;
  readonly commitmentSchema = commitmentSchema;
  readonly marketConfigSchema = marketConfigSchema;

  /** Never throws; errors go to `ctx.onError`. */
  async observeResolution(
    marketRef: MarketRef,
    ctx: ObservationContext,
  ): Promise<Outcome | "pending" | "disputed"> {
    const narrowed = narrowContext(ctx);
    if (!narrowed) {
      // No usable conditionId on the row: stay pending until it's fixed.
      return "pending";
    }
    // Never score a call against a different condition.
    if (marketRef.sourceId.toLowerCase() !== narrowed.conditionId.toLowerCase()) {
      narrowed.onError?.("conditionId_mismatch");
      return "pending";
    }
    const client = narrowed.client ?? getDefaultClient();
    if (!client) {
      narrowed.onError?.("polymarket_client_unconfigured");
      return "pending";
    }
    try {
      const result = await client.fetchMarketByConditionId(narrowed.conditionId);
      if (result.error) narrowed.onError?.(result.error);
      const snapshot = result.snapshot;
      if (snapshot === null) {
        // Gamma drops 5-min markets after close; fall back to CLOB.
        return await observeClobFallback(narrowed);
      }
      if (snapshot.conditionId.toLowerCase() !== marketRef.sourceId.toLowerCase()) {
        narrowed.onError?.("conditionId_response_mismatch");
        return "pending";
      }
      try {
        return gammaMarketToOutcome(snapshot);
      } catch (err) {
        // transform.ts shouldn't throw; keep the contract if it does.
        narrowed.onError?.(
          `transform_threw:${err instanceof Error ? err.message : String(err)}`,
        );
        return "pending";
      }
    } catch (err) {
      // Same for the client.
      narrowed.onError?.(
        `observe_threw:${err instanceof Error ? err.message : String(err)}`,
      );
      return "pending";
    }
  }

  /**
   * Market end + series embargo; must equal on-chain `publicRevealAt`.
   * Markets without `embargoSec` use 0.
   */
  expectedRevealOpenAt(input: { config: Record<string, unknown> }): number | null {
    const endMs = this.#endDateMs(input.config);
    if (endMs === null) return null;
    return endMs + this.#embargoSec(input.config) * 1_000;
  }

  /** The venue's end date, no embargo. */
  marketResolutionAt(input: { config: Record<string, unknown> }): number | null {
    return this.#endDateMs(input.config);
  }

  #endDateMs(config: Record<string, unknown>): number | null {
    const endDate = config.endDate;
    if (typeof endDate !== "string") return null;
    const ms = Date.parse(endDate);
    return Number.isFinite(ms) ? ms : null;
  }

  #embargoSec(config: Record<string, unknown>): number {
    const raw = config.embargoSec;
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
  }

  outcomeLabels(input: { config: Record<string, unknown> }): string[] | null {
    const labels = input.config.outcomes;
    if (
      Array.isArray(labels) &&
      labels.length === 2 &&
      labels.every((label) => typeof label === "string" && label.length > 0)
    ) {
      return labels as string[];
    }
    return null;
  }

  buildObservationContext(input: {
    marketRef: MarketRef;
    config: Record<string, unknown>;
    market_id: string;
  }): ObservationContext {
    const conditionId =
      typeof input.config.conditionId === "string"
        ? input.config.conditionId
        : input.marketRef.sourceId;
    return {
      ...input.config,
      conditionId,
      market_id: input.market_id,
    };
  }

  /**
   * Multinomial Brier via {@link callScore}; `components` allows replay without Gamma.
   *
   *   predicted=[1,0]/1  resolved=[1,0]/1 → 1.0
   *   predicted=[1,0]/1  resolved=[0,1]/1 → 0.0
   *   predicted=[1,0]/1  resolved=[1,1]/2 → 0.5
   */
  score(
    c: Commitment,
    o: Outcome,
  ): { call_score: number | null; components?: unknown } {
    // Cancelled: the resolver voids the call.
    if (o.kind === "invalid") {
      return {
        call_score: null,
        components: {
          adapter: ADAPTER_NAME,
          version: ADAPTER_VERSION,
          scoring_kind: "multinomial_brier",
          reason: "polymarket_cancelled",
          predicted_numerators: c.predictedOutcome.payoutNumerators.map((n) =>
            n.toString(),
          ),
          resolved_numerators: o.payoutNumerators.map((n) => n.toString()),
          denominator: o.payoutDenominator.toString(),
        },
      };
    }
    const score = callScore(c, o);
    return {
      call_score: score,
      components: {
        adapter: ADAPTER_NAME,
        version: ADAPTER_VERSION,
        scoring_kind: "multinomial_brier",
        sourceProtocol: o.evidence.sourceProtocol,
        sourceId: o.evidence.sourceId,
        predicted_numerators: c.predictedOutcome.payoutNumerators.map((n) =>
          n.toString(),
        ),
        resolved_numerators: o.payoutNumerators.map((n) => n.toString()),
        predicted_denominator: c.predictedOutcome.payoutDenominator.toString(),
        resolved_denominator: o.payoutDenominator.toString(),
      },
    };
  }
  // No subscribeResolutions: Gamma doesn't push, the resolver polls.
}

// ─── Singleton ──────────────────────────────────────────────────────────────

/** Registered by `./register.ts`. */
export const polymarketGammaAdapter: MarketMakerAdapter =
  new PolymarketGammaAdapter();

export type { PolymarketGammaAdapter };

export { PolymarketGammaClient } from "./client.js";
export {
  PolymarketClobClient,
  type ClobMarketSnapshot,
} from "./clob-client.js";
export {
  clobMarketToOutcome,
  normalizeOutcomeLabel,
  CLOB_SOURCE_PROTOCOL,
} from "./clob-transform.js";
export {
  gammaMarketToOutcome,
  parseOutcomePrices,
  isDisputed,
  parseOutcomeLabels,
  resolvedAtSeconds,
  type GammaMarketSnapshot,
} from "./transform.js";
