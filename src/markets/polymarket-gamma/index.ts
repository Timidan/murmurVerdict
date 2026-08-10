/**
 * PolymarketGammaAdapter — the first non-financial {@link MarketMakerAdapter}.
 *
 * Maps Polymarket's `/markets` row (the only public per-conditionId entry
 * point Gamma offers; the cursor-paginated `/markets/keyset` doesn't
 * accept a conditionId filter) onto the universal payout-vector
 * {@link Outcome}. Binary YES/NO only at Tier 1 — NegRisk events are
 * exposed as N independent binary markets; categorical fusion is Tier 2.
 * On-chain CTF fallback is Tier 3.
 *
 * Cardinal rule (V2_REVIEW BLOCKER #1):
 *   `observeResolution` MUST NEVER throw. Every Gamma / parser / schema
 *   failure collapses to `'pending'` plus an error-coded log line — a
 *   thrown exception aborts the resolver tick, freezing every market on
 *   the daemon. See RESEARCH §8.
 *
 * The resolver picks this adapter by reading `markets.adapter_id ===
 * 'polymarket-gamma'` from the row, then calls `observeResolution` with
 * an {@link ObservationContext} that the sync ticker has populated with
 * the conditionId. Submission privacy is handled before scoring: calls
 * remain sealed until the Fhenix reveal is published and attached as the
 * public commitment.
 *
 * Cite: RESEARCH_polymarket_gamma_adapter.md §1-§10, V2_DECISION_RECORD §2.4.
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

// ─── Constants ──────────────────────────────────────────────────────────────

export const ADAPTER_NAME = "polymarket-gamma" as const;
export const ADAPTER_VERSION = "1.1.0" as const;
export const MARKET_FAMILY = "prediction-market-binary" as const;

// ─── Schemas (V2_REVIEW BLOCKER #1: `.passthrough()` everywhere) ───────────

/**
 * Narrows the universal {@link CommitmentSchema}:
 *   - `predictedOutcome.kind === 'binary'`
 *   - `payoutNumerators.length === 2`
 *   - `marketRef.protocol === 'polymarket-gamma'`
 *   - `marketRef.sourceId` is a 32-byte hex conditionId
 *
 * Probabilistic agents may still post `[7,3]/10`-style vectors; the
 * scoring path (multinomial-Brier via {@link callScore}) handles
 * asymmetric denominators correctly.
 */
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

/**
 * Per-call context the resolver passes to {@link observeResolution}. The
 * adapter only reads `conditionId` directly — `market_id` is carried so the
 * sync ticker can log against the canonical `markets.id`, and `client` is
 * an optional override for the resolver harness / smoke driver to inject a
 * pre-wired Gamma client.
 *
 * Universal {@link ObservationContext} is `Record<string, unknown>`; we
 * narrow structurally inside the body without zod parsing on every tick.
 */
export interface PolymarketGammaContext {
  /** 32-byte hex conditionId — the resolver lifts this from
   *  `markets.config_json.conditionId` or `markets.id`. */
  conditionId: string;
  /** `markets.id` — used for logging / sync_state bookkeeping. */
  market_id: string;
  /** Stored `config_json.endDate` — gates + timestamps the CLOB fallback. */
  endDate?: string;
  /** Stored `config_json.outcomes` — canonical payout-vector label order. */
  outcomes?: string[];
  /** Stored `normalized label → clob token_id` map (config.ts hardening). */
  clobTokenIds?: Record<string, string>;
  /** Optional adapter-private Gamma client injection. Defaults to the
   *  module-level singleton ({@link getDefaultClient}). */
  client?: PolymarketGammaClient;
  /** Optional CLOB fallback client injection. Defaults to the module-level
   *  singleton ({@link getDefaultPolymarketClobClient}). */
  clobClient?: PolymarketClobClient;
  /** Fallback-gate clock (endDate-in-the-past check). Defaults to the boot
   *  clock ({@link setDefaultPolymarketClock}), then Date.now. */
  nowMs?: () => number;
  /** Optional sink for error codes ('http_404', 'network:*', 'schema_drift:*').
   *  The sync ticker forwards these to `external_market_sync_state`. */
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

/**
 * Shared CLOB fallback client — one instance across the resolver and the
 * sync ticker so the LRU / single-flight / circuit breaker are effective
 * process-wide.
 */
export function getDefaultPolymarketClobClient(): PolymarketClobClient | null {
  return defaultClobClient;
}

/**
 * Test / boot-time injection. Set this to a fixture-driven client to make
 * `observeResolution` deterministic without monkey-patching globalThis.fetch.
 */
export function setDefaultPolymarketClient(
  client: PolymarketGammaClient | null,
): void {
  defaultClient = client;
}

/** Test / boot-time injection for the CLOB fallback client. */
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

/**
 * Consult the CLOB surface after Gamma returned no snapshot. Triggers ONLY
 * when the stored endDate is a valid timestamp in the past — Gamma remains
 * the primary surface (richer UMA status incl. disputes). Every failure
 * collapses to 'pending' + an error-coded log line; the never-throw
 * invariant of `observeResolution` is preserved by the caller's try/catch.
 */
async function observeClobFallback(
  narrowed: PolymarketGammaContext,
): Promise<Outcome | "pending"> {
  const endDateMs =
    typeof narrowed.endDate === "string" ? Date.parse(narrowed.endDate) : Number.NaN;
  if (!Number.isFinite(endDateMs)) return "pending";
  // Resolver-path contexts carry no clock (buildAdapterObservationContext
  // spreads JSON config only), so fall back to the boot clock configured by
  // setDefaultPolymarketClock before reaching for wall time.
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

  /**
   * Pull the universal {@link Outcome} for a Polymarket conditionId.
   *
   * Always returns one of:
   *   - `'pending'`  — open / unresolved / schema drift / transient error
   *   - `'disputed'` — UMA dispute in flight (informational; resolver waits)
   *   - {@link Outcome} with `kind='binary'` (or `'invalid'` for cancelled)
   *
   * MUST NEVER THROW. Errors flow through `ctx.onError(code)` so the
   * sync ticker can increment `consecutive_failures` and surface
   * `MARKET_DISAPPEARED` / `MARKET_NEVER_RESOLVED` alerts at the
   * configured thresholds.
   */
  async observeResolution(
    marketRef: MarketRef,
    ctx: ObservationContext,
  ): Promise<Outcome | "pending" | "disputed"> {
    const narrowed = narrowContext(ctx);
    if (!narrowed) {
      // Defensive: the resolver constructs the context inline; a missing
      // conditionId means the markets row wasn't backfilled. Stay
      // 'pending' so the operator can fix the row without a crash.
      return "pending";
    }
    // The local commitment and lookup context must identify the same market.
    // Continuing on a mismatch risks resolving and scoring the call against
    // an unrelated condition.
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
        // Gamma has no row. For 5-min micro-markets that is EXPECTED after
        // close (Gamma drops them), so consult the CLOB fallback — but only
        // once the stored endDate has passed; pre-end, a Gamma miss is a
        // transient failure and CLOB must not be spammed.
        return await observeClobFallback(narrowed);
      }
      if (snapshot.conditionId.toLowerCase() !== marketRef.sourceId.toLowerCase()) {
        narrowed.onError?.("conditionId_response_mismatch");
        return "pending";
      }
      try {
        return gammaMarketToOutcome(snapshot);
      } catch (err) {
        // Defensive: transform.ts is designed not to throw, but a future
        // bug or an unexpected runtime crash collapses here rather than
        // propagating to the resolver tick.
        narrowed.onError?.(
          `transform_threw:${err instanceof Error ? err.message : String(err)}`,
        );
        return "pending";
      }
    } catch (err) {
      // Defensive: client.fetchMarketByConditionId() is designed to swallow
      // every error, but if a future version regresses we still honor the
      // cardinal-rule contract.
      narrowed.onError?.(
        `observe_threw:${err instanceof Error ? err.message : String(err)}`,
      );
      return "pending";
    }
  }

  /**
   * PUBLIC REVEAL time = market end + series embargo.
   *
   * `embargoSec` is written into config_json at registration from the series
   * clock. It defaults to 0 so markets registered before embargoes existed keep
   * revealing at their end time — this value must match the on-chain
   * `publicRevealAt` exactly or the acceptance guard rejects every submission.
   */
  expectedRevealOpenAt(input: { config: Record<string, unknown> }): number | null {
    const endMs = this.#endDateMs(input.config);
    if (endMs === null) return null;
    return endMs + this.#embargoSec(input.config) * 1_000;
  }

  /**
   * MARKET RESOLUTION time = the venue's own end date, with no embargo. This is
   * when the outcome is determined, which is what a prediction's horizon means.
   */
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
   * Score a Polymarket commitment via the universal multinomial-Brier
   * {@link callScore}. No bespoke math — the universal scoring helper
   * handles asymmetric denominators correctly:
   *
   *   predicted=[1,0]/1  resolved=[1,0]/1 → 1.0 (YES wins)
   *   predicted=[1,0]/1  resolved=[0,1]/1 → 0.0 (YES loses)
   *   predicted=[1,0]/1  resolved=[1,1]/2 → 0.5 (resolved 50-50)
   *
   * `components` carries the resolved-vector + adapter tag so verifiers
   * can replay the score against the stamped snapshot without re-fetching
   * Gamma.
   */
  score(
    c: Commitment,
    o: Outcome,
  ): { call_score: number | null; components?: unknown } {
    // Cancellation maps to kind='invalid'; resolver voids the call upstream.
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
  // No subscribeResolutions — Polymarket Gamma doesn't push. The
  // resolver-tick poll loop is the resolution driver (RESEARCH §1, §4).
}

// ─── Singleton + registration helper ────────────────────────────────────────

/** Singleton adapter instance — registered via `./register.ts`. */
export const polymarketGammaAdapter: MarketMakerAdapter =
  new PolymarketGammaAdapter();

// Type-only export so callers can reference the class without re-instantiating.
export type { PolymarketGammaAdapter };

// Re-exports for the smoke driver / sync ticker / register module.
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
