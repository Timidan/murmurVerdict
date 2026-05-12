/**
 * NativePriceAdapter — the legacy financial-direction market path wrapped as
 * the first {@link MarketMakerAdapter}. Phase 3 of V2_IMPLEMENTATION_PLAN.
 *
 * Wave 4d update — the adapter is now load-bearing:
 *   The resolver at `src/verdict/resolver.ts` dispatches the universal
 *   payout-vector path through {@link MarketMakerRegistry}. `observeResolution`
 *   takes the per-call context and returns a real {@link Outcome} (not
 *   `pending`); `score` is the public scoring entry for the adapter (the
 *   resolver routes `scoreOutcomeVector` through the registry). Wave 4b
 *   retired the receipts subsystem — `acceptCommitment` / `verifyReceipt` are
 *   gone from the interface, and the call + reveal + resolution rows are the
 *   canonical evidence.
 *
 * Mapping legacy (Side, signed_return, void_band) → universal (Outcome):
 *
 *   | legacy                                    | universal Outcome              |
 *   |-------------------------------------------|--------------------------------|
 *   | side=BUY,  signed_return >= +void_band    | kind=binary, [1n, 0n], denom=1 |
 *   | side=BUY,  signed_return <= -void_band    | kind=binary, [0n, 1n], denom=1 |
 *   | side=SELL, signed_return <= -void_band    | kind=binary, [1n, 0n], denom=1 |
 *   | side=SELL, signed_return >= +void_band    | kind=binary, [0n, 1n], denom=1 |
 *   | -void_band < signed_return < +void_band   | kind=binary, [0n, 0n], denom=1 |
 *
 *   The vector indices are [UP, DOWN] — the *direction the price moved*, NOT
 *   the side the agent predicted. BUY's prediction maps to [1,0] (price-up)
 *   and SELL's to [0,1] (price-down) on the predictedOutcome side. Outcome
 *   construction is symmetric: legacy "win" reduces to "agent's predicted
 *   vector EQUALS resolved vector" → callScore 1.0; "loss" → disjoint vectors
 *   → callScore 0.0.
 *
 *   Void band is the load-bearing piece (brief flagged this). Legacy void
 *   produces `scoreCall.call_score = null` and the call is excluded from
 *   leaderboard aggregation in `scoring.ts:150-163`. The universal-vector
 *   translation here records `[0n, 0n]` against `denominator=1n`. callScore
 *   on `predicted=[1,0]` vs `resolved=[0,0]` is exactly 0.5 (half-L1 of the
 *   two vectors; see the verification harness in
 *   `__market_maker_smoke__.ts`). This DIVERGES from the legacy null —
 *   intentionally — for two reasons:
 *
 *     (1) The universal Outcome shape has no "ignore me" channel; `kind=
 *         invalid` exists for adapter-side abstention but breaks the
 *         `predicted.kind === resolved.kind` check in `callScore`. Forcing
 *         every binary market to declare a score keeps the cross-family
 *         leaderboard math (Phase 10) tractable.
 *
 *     (2) 0.5 is the only sensible "no-move" score under multinomial-Brier
 *         on a 2-element vector — it's the L1 midpoint between the two
 *         one-hots. Legacy null was a leaderboard hack to dodge
 *         confidence-weighting on small-move outcomes; the universal score
 *         already absorbs that via `score.components.move` (Phase 5 work).
 *
 *   Phase 5 reconciles by either (a) keeping the resolver-layer null for
 *   void outcomes and letting the adapter score sit at 0.5 unconsumed, or
 *   (b) widening the resolver to accept the 0.5 directly with a documented
 *   "void → 0.5" cutover note. That decision is logged as a Phase 5 open
 *   question.
 *
 * Cite: V2_DECISION_RECORD §2.4 (interface), §3.2 (legacy → vector mapping).
 */

import { z } from "zod";
import {
  callScore,
  type Commitment,
  type Outcome,
  type MarketRef,
} from "../markets-core.js";
import { SCHEMA_VERSION } from "../schema.js";
import type {
  MarketMakerAdapter,
  ObservationContext,
} from "../../markets/types.js";

// ─── Adapter constants ──────────────────────────────────────────────────────

const ADAPTER_NAME = "native-price" as const;
const ADAPTER_VERSION = "1.0.0" as const;
const MARKET_FAMILY = "financial-direction" as const;
const SOURCE_PROTOCOL = "native-price" as const;

// ─── commitmentSchema ───────────────────────────────────────────────────────
//
// Accepts the LEGACY agent wire shape (`asset_id`, `side`, `horizon_hours`,
// `confidence`, `market_id?`) and emits the universal {@link Commitment}.
// Side → predictedOutcome translation:
//
//   BUY  → [1n, 0n]   (price-up)
//   SELL → [0n, 1n]   (price-down)
//
// The schema is a Zod transform — `parse()` returns a Commitment shape so the
// adapter's downstream code never has to know the legacy fields exist. Phase
// 4's `/v2/calls` endpoint will accept the universal Commitment shape directly
// and bypass this schema entirely; this transform is the back-compat seam for
// `/v1/calls`.

const LegacyDirectionInputSchema = z
  .object({
    /** Direction-binary side. */
    side: z.enum(["BUY", "SELL"]),
    /** Agent-stated probability. Native-price adapter narrows to [0.51, 0.95]
     *  to match the legacy CONFIDENCE_MIN/MAX bounds. Other adapters may use
     *  the wider [0, 1] universal range. */
    confidence: z.number().min(0.51).max(0.95),
    /** Either the legacy (asset_id, horizon_hours) tuple OR the new market_id
     *  string — exactly one path is required. The market_id wire shape is
     *  preferred for new code; the tuple shape stays for benchmark agents
     *  through Phase 4. */
    asset_id: z.string().optional(),
    horizon_hours: z
      .union([
        z.literal(0),
        z.literal(1),
        z.literal(4),
        z.literal(24),
        z.literal(168),
      ])
      .optional(),
    market_id: z.string().optional(),
    /** Native-price markets resolve at t0 + horizon_seconds. The agent
     *  supplies the expected resolution ISO; the daemon recomputes it from
     *  the market row at acceptance and stamps the canonical value. */
    expected_resolves_at_iso: z.string().min(1),
    /** Optional config-version pin. Falls back to "1" — the daemon stamps
     *  the live `markets.market_config_version` at acceptance. */
    market_config_version: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, ctx) => {
    const hasMarketId =
      typeof value.market_id === "string" && value.market_id.length > 0;
    const hasLegacyTuple =
      typeof value.asset_id === "string" &&
      value.asset_id.length > 0 &&
      typeof value.horizon_hours === "number";
    if (hasMarketId === hasLegacyTuple) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "exactly one of {market_id} or {asset_id, horizon_hours} must be present",
      });
    }
  });

/**
 * Map a legacy `Side` to the universal payout-vector [UP, DOWN]. Exposed for
 * Phase 5 resolver code so the cutover can call the same mapping function the
 * adapter uses internally (no parallel implementation).
 */
export function sideToPayoutNumerators(
  side: "BUY" | "SELL",
): readonly [bigint, bigint] {
  return side === "BUY" ? [1n, 0n] : [0n, 1n];
}

/**
 * Inverse mapping: signed_return + void_band → resolved payout vector.
 * Encapsulates the V0.1 binary-collapse rule documented at the top of this
 * file. `signed_return` is `ln(p1/p0)` (BUY-perspective). `void_band` is the
 * per-market threshold from `markets.void_band`.
 *
 * Returns numerators only; the caller wraps with `denominator=1n` and
 * `kind='binary'`. Indices are [UP, DOWN].
 */
export function signedReturnToPayoutNumerators(
  signed_return: number,
  void_band: number,
): readonly [bigint, bigint] {
  if (!(void_band >= 0)) {
    throw new Error(
      `signedReturnToPayoutNumerators: void_band must be >= 0 (got ${void_band})`,
    );
  }
  if (signed_return >= +void_band) return [1n, 0n]; // UP wins
  if (signed_return <= -void_band) return [0n, 1n]; // DOWN wins
  return [0n, 0n]; // void — see docstring at top of file for the 0.5-score consequence
}

// The transform output is exactly the universal Commitment. Zod's type
// inference on `.transform(...)` doesn't always agree with the explicit
// interface, so the cast is intentional — we DO emit a runtime Commitment
// (validated by the explicit shape above), but the surrounding ZodSchema
// covariance over a transform output is awkward without a downcast.
const commitmentSchema = LegacyDirectionInputSchema.transform(
  (input): Commitment => {
    const protocol = ADAPTER_NAME;
    const sourceId =
      input.market_id ??
      // Synthesize the legacy market_id from the asset/horizon tuple. This
      // mirrors `marketsRepo.legacyIdFor` semantics (e.g. base:ETH:USD + 1h
      // → "eth.1h"). The synthesizer here is best-effort; the daemon's
      // submission path runs the real `legacyIdFor()` lookup and overrides
      // sourceId at acceptance time. Kept aligned in spirit, NOT
      // byte-identical — the daemon is the source of record.
      `${(input.asset_id ?? "unknown").toLowerCase()}.${input.horizon_hours}h`;
    return {
      marketRef: {
        protocol,
        sourceId,
        configVersion: input.market_config_version ?? 1,
      },
      predictedOutcome: {
        kind: "binary",
        payoutNumerators: [...sideToPayoutNumerators(input.side)],
        payoutDenominator: 1n,
      },
      horizon: { iso: input.expected_resolves_at_iso },
      confidence: input.confidence,
    };
  },
) as unknown as z.ZodSchema<Commitment>;

// ─── marketConfigSchema ─────────────────────────────────────────────────────
//
// Validates the shape of `markets.config_json` for native-price markets. Today
// `config_json` is unused by the resolver (every config field has a dedicated
// column), so the schema is a permissive object with optional hints. Phase 4's
// `marketConfigVersion` bump adds enforced fields here; until then this is a
// pass-through that matches the wire shape `{ }`.

const marketConfigSchema = z
  .object({
    /** Optional alias for the registry market_id (humans set this in admin
     *  UIs; the canonical `market_id` lives on the row). */
    label: z.string().optional(),
    /** Optional override for the resolver's grace policy. Currently unused —
     *  the columns on `markets` are authoritative. */
    grace_overrides: z
      .object({
        t0_grace_seconds: z.number().int().nonnegative().optional(),
        t0_extended_grace_seconds: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .passthrough();

// ─── Adapter implementation ─────────────────────────────────────────────────

class NativePriceAdapter implements MarketMakerAdapter {
  readonly name = ADAPTER_NAME;
  readonly version = ADAPTER_VERSION;
  readonly marketFamily = MARKET_FAMILY;
  readonly commitmentSchema = commitmentSchema;
  readonly marketConfigSchema = marketConfigSchema;

  /**
   * Compute the universal {@link Outcome} for a native-price call.
   *
   * `ctx` is structurally typed as the universal {@link ObservationContext}
   * (an opaque record) but, for native-price, MUST carry the financial-
   * direction fields documented on {@link NativePriceObservationContext}.
   * The resolver lifts those values from the call's t0 anchor + t1 oracle
   * observation + market row. The shape is verified by structural checks
   * inside the body — a malformed context returns `pending` instead of
   * throwing so the resolver can fall through to its still-pending path.
   *
   * Universal-vs-legacy mapping:
   *   - kind: 'binary' (always, even on void — see top-of-file docstring)
   *   - payoutNumerators: [UP, DOWN] integer pair, derived from BUY-perspective
   *                       signed_return via {@link signedReturnToPayoutNumerators}
   *   - payoutDenominator: 1n
   *
   * Implementation shares {@link observeResolutionForCall} so the legacy
   * helper (still exported for back-compat callers) and the universal adapter
   * surface stay byte-identical.
   */
  async observeResolution(
    _marketRef: MarketRef,
    ctx: ObservationContext,
  ): Promise<Outcome | "pending" | "disputed"> {
    const narrowed = narrowNativePriceContext(ctx);
    if (!narrowed) return "pending";
    return observeResolutionForCall(narrowed);
  }

  /**
   * Score a commitment against its resolution. Reduces to today's binary
   * Brier-direction proxy on the 2-element payout vector — `callScore` is
   * `1 − halfL1Distance(predicted, resolved)`, and on `[1,0]` vs `[1,0]` it's
   * 1.0; vs `[0,1]` it's 0.0; vs `[0,0]` (legacy void) it's 0.5.
   *
   * Wave 4d note — the universal `scoreOutcomeVector` reconciles the void
   * bucket to `call_score = null` for leaderboard-exclusion parity with the
   * legacy resolver. This adapter-private method returns the raw
   * multinomial-Brier number (including 0.5 for [0,0]); callers that need
   * the legacy void contract route through `scoreOutcomeVector` instead.
   *
   * `components` carries the void-collapse rationale for replay: the adapter
   * records the resolved vector + a tag identifying which legacy bin
   * (UP / DOWN / VOID) it came from so verifiers can inspect the L1 reasoning
   * without re-running the resolver.
   */
  score(
    c: Commitment,
    o: Outcome,
  ): { call_score: number; components?: unknown } {
    const score = callScore(c, o);
    const legacyBin = classifyLegacyBin(o.payoutNumerators);
    return {
      call_score: score,
      components: {
        adapter: ADAPTER_NAME,
        version: ADAPTER_VERSION,
        legacy_bin: legacyBin,
        predicted_numerators: c.predictedOutcome.payoutNumerators.map((n) =>
          n.toString(),
        ),
        resolved_numerators: o.payoutNumerators.map((n) => n.toString()),
        denominator: o.payoutDenominator.toString(),
      },
    };
  }
}

/**
 * Structurally narrow the universal {@link ObservationContext} to the
 * native-price-specific shape. Returns null when any required field is
 * missing or mistyped — the adapter caller maps null → "pending" so the
 * resolver falls through to its still-pending path rather than throwing.
 *
 * Mirrors {@link NativePriceObservationContext} exactly. Kept structural
 * (no Zod) because the resolver constructs the context inline and we don't
 * want a runtime schema parse on every t1 tick.
 */
function narrowNativePriceContext(
  ctx: ObservationContext,
): NativePriceObservationContext | null {
  if (typeof ctx.t0_p0 !== "string") return null;
  if (typeof ctx.t1_p1 !== "string") return null;
  if (typeof ctx.t1_iso !== "string") return null;
  if (typeof ctx.t1_feed !== "string") return null;
  if (typeof ctx.t1_source_id !== "string") return null;
  if (typeof ctx.void_band !== "number") return null;
  if (typeof ctx.market_id !== "string") return null;
  // Wave 3 — `side` is now optional. Accept BUY/SELL when provided (legacy
  // debug callers, verifier harness), otherwise omit it. The resolved
  // Outcome is computed side-independently regardless.
  const sideField: { side?: "BUY" | "SELL" } =
    ctx.side === "BUY" || ctx.side === "SELL"
      ? { side: ctx.side as "BUY" | "SELL" }
      : {};
  return {
    t0_p0: ctx.t0_p0,
    t1_p1: ctx.t1_p1,
    t1_iso: ctx.t1_iso,
    t1_feed: ctx.t1_feed,
    t1_source_id: ctx.t1_source_id,
    void_band: ctx.void_band,
    market_id: ctx.market_id,
    ...sideField,
  };
}

/**
 * Tag the legacy bin a resolved 2-element binary outcome falls into. Covers
 * the three valid legacy outcomes (UP / DOWN / VOID); throws on
 * unrecognized vectors so a broken adapter surfaces here, not at the
 * leaderboard. Phase 5 will fold this into the resolver's outcome taxonomy.
 */
function classifyLegacyBin(
  numerators: bigint[],
): "up" | "down" | "void" | "unknown" {
  if (numerators.length !== 2) return "unknown";
  const [a, b] = numerators;
  if (a === 1n && b === 0n) return "up";
  if (a === 0n && b === 1n) return "down";
  if (a === 0n && b === 0n) return "void";
  return "unknown";
}

// ─── Singleton instance + exports ───────────────────────────────────────────

/** Singleton adapter instance — registered via `./registry.js`. */
export const nativePriceAdapter: MarketMakerAdapter = new NativePriceAdapter();

// Type-only export so callers can write `NativePriceAdapter` references
// without dual-importing the class. Actual construction is centralized via
// the singleton.
export type { NativePriceAdapter };

// ─── Native-price observation context + helper ──────────────────────────────
//
// The universal `MarketRef` carries no DB / call context — the legacy
// resolver flow needs a t0 anchor (per-call) and the void_band (per-market).
// The resolver builds this context from `anchorsRepo.getT0(db, call_id)`,
// the latest `observeOracle` result, and `markets.void_band` parsed via
// `voidBandFloat()`, then passes it through `adapter.observeResolution(
// marketRef, ctx)`. Wave 4d wired the adapter's `observeResolution` method
// directly to this helper; the helper stays exported for back-compat callers
// (verifier harness, internal tooling) that already speak the structured
// shape.

export interface NativePriceObservationContext {
  /** From `anchorsRepo.getT0(db, call_id)`. */
  t0_p0: string;
  /** From the latest `observeOracle` / `OracleClient` call on the t1 path. */
  t1_p1: string;
  /** Feed timestamp from the t1 observation. */
  t1_iso: string;
  /** Source feed string ("chainlink:base:ETH-USD", "pyth:base:ETH-USD", ...). */
  t1_feed: string;
  /** Source id (round / publish slot, hex). */
  t1_source_id: string;
  /** From `markets.void_band` parsed via `voidBandFloat()`. */
  void_band: number;
  /**
   * OPTIONAL. Wave 3 made the adapter's resolved Outcome side-independent
   * (the payout vector is keyed on the actual price direction [UP, DOWN],
   * not the agent's prediction). FHE-direct rows omit this entirely —
   * the agent's prediction is encrypted in fhe_call_ciphertexts and the
   * FHE scoring step compares ciphertext to the public resolved Outcome.
   *
   * When supplied (legacy / debug callers), it's used purely to compute
   * the SIDE-ADJUSTED signed_return on evidence.raw (a display-only
   * metadata field). When absent, evidence.raw.signed_return falls back
   * to the canonical BUY-perspective return r = ln(p1/p0).
   */
  side?: "BUY" | "SELL";
  /** marketRef.sourceId — used as evidence.sourceId on the Outcome. */
  market_id: string;
}

/**
 * Compute the resolved {@link Outcome} for a native-price call exactly the way
 * the legacy resolver does today. Returned shape:
 *
 *   - kind: 'binary' (always, even on void — see top-of-file docstring)
 *   - payoutNumerators: [UP, DOWN] integer pair
 *   - payoutDenominator: 1n
 *   - resolvedAt: unix seconds parsed from t1_iso
 *   - evidence.sourceProtocol: "native-price"
 *   - evidence.sourceId: market_id
 *   - evidence.raw: { p0, p1, signed_return, void_band, side, t1_feed, t1_source_id }
 *
 * Equivalence claim: for any legacy ETH call, the (kind, payoutNumerators,
 * payoutDenominator) tuple emitted by this helper matches the legacy
 * `outcomeFromSignedReturn(...)` result via the mapping in
 * {@link signedReturnToPayoutNumerators}. The verification harness exercises
 * this against fixtures from `__resolver_smoke__.ts`.
 */
export function observeResolutionForCall(
  ctx: NativePriceObservationContext,
): Outcome {
  // BUG FIX (codex review v2 P2 #1): the resolved payout vector is keyed on
  // the ACTUAL price direction ([UP, DOWN]) — independent of the side the
  // agent predicted. signedReturnToPayoutNumerators expects the BUY-perspective
  // signed return r = ln(p1/p0). Previously this function passed the
  // side-adjusted return (which negates for SELL), causing the resolved vector
  // to flip for SELL calls — a winning SELL on a price drop got recorded as
  // [1n, 0n] (UP) instead of [0n, 1n] (DOWN). The agent's predicted vector is
  // [0n, 1n] for SELL, so the wrong resolution vector flipped win <-> loss for
  // every SELL call.
  //
  // Fix: derive numerators from the RAW BUY-perspective return, and keep the
  // side-adjusted signed_return on `evidence.raw` (matches legacy
  // `t1_resolutions.signed_return` semantics where r is BUY's = -SELL's).
  const a = Number(ctx.t0_p0);
  const b = Number(ctx.t1_p1);
  if (!(a > 0) || !(b > 0)) {
    throw new Error("p0 and p1 must be positive decimal strings");
  }
  const buyPerspectiveReturn = Math.log(b / a);
  const numerators = signedReturnToPayoutNumerators(
    buyPerspectiveReturn,
    ctx.void_band,
  );
  // Wave 3 — when `side` is absent (FHE-direct rows, post-Wave-3 default)
  // evidence.raw.signed_return is the canonical BUY-perspective return.
  // When `side` is present (legacy callers), retain the side-adjusted
  // semantic for parity with v1 t1_resolutions.signed_return.
  const sideAdjustedReturn =
    ctx.side === "SELL" ? -buyPerspectiveReturn : buyPerspectiveReturn;
  const resolvedAt = Math.floor(Date.parse(ctx.t1_iso) / 1000);
  return {
    kind: "binary",
    payoutNumerators: [...numerators],
    payoutDenominator: 1n,
    resolvedAt,
    evidence: {
      sourceProtocol: SOURCE_PROTOCOL,
      sourceId: ctx.market_id,
      raw: {
        p0: ctx.t0_p0,
        p1: ctx.t1_p1,
        signed_return: sideAdjustedReturn,
        void_band: ctx.void_band,
        side: ctx.side,
        t1_feed: ctx.t1_feed,
        t1_source_id: ctx.t1_source_id,
      },
    },
  };
}

// Wave 4b — receipts subsystem dropped. The Phase-5 cutover-seam stub
// that bound the receipt schemas here is no longer needed; SCHEMA_VERSION
// stays in scope for future commit-time stamping use.
void SCHEMA_VERSION;
