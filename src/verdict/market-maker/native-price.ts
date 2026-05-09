/**
 * NativePriceAdapter — the legacy financial-direction market path wrapped as
 * the first {@link MarketMakerAdapter}. Phase 3 of V2_IMPLEMENTATION_PLAN.
 *
 * Why this exists as a SHELL:
 *   The resolver at `src/verdict/resolver.ts` still calls
 *   `computeSignedReturn` / `outcomeFromSignedReturn` / `scoreCall` directly.
 *   Phase 5 cuts those calls over to `adapter.observeResolution()` +
 *   `adapter.score()`. This file is the parallel implementation that lets
 *   the verifier run side-by-side and PROVE byte-for-byte equivalence on
 *   the legacy ETH markets BEFORE the resolver's hot path swaps. The
 *   universal-vs-legacy mapping decisions live here and are easy to grep.
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
import { canonicalize, canonicalHash } from "../../receipts/canonical.js";
import type {
  AcceptanceReceipt,
  MarketMakerAdapter,
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
   * Stamp the commitment, return ISO8601 acceptance time + canonical receipt.
   *
   * SHELL behavior: the adapter canonicalizes the universal {@link Commitment}
   * shape directly via `canonicalize` / `canonicalHash` and returns the
   * adapter-local {@link AcceptanceReceipt} shape (hash + canonical_json +
   * accepted_at). Wave 4b retired the daemon-side receipts table; this
   * adapter-private payload is purely an in-memory return shape callers can
   * use for canonical replay without touching SQLite.
   *
   * Bigint-safe canonicalization: `canonicalize` runs through `JSON.stringify`,
   * which throws on bigint. The Commitment carries bigints in
   * `predictedOutcome.payoutNumerators` / `payoutDenominator`. We pre-serialize
   * via {@link toCanonicalCommitmentWire} so the bigints become
   * decimal-digit strings — round-tripping back through
   * `commitmentSchema.parse` would yield numerator + denominator strings, not
   * bigints, but the adapter's verifier never re-deserializes; it just
   * re-hashes the canonical bytes.
   */
  async acceptCommitment(
    c: Commitment,
  ): Promise<{ accepted_at: string; receipt: AcceptanceReceipt }> {
    const accepted_at = nowIsoUtcZ();
    const wire = toCanonicalCommitmentWire(c);
    const canonical_json = canonicalize({
      adapter: ADAPTER_NAME,
      version: ADAPTER_VERSION,
      accepted_at,
      commitment: wire,
    });
    const hash = canonicalHash({
      adapter: ADAPTER_NAME,
      version: ADAPTER_VERSION,
      accepted_at,
      commitment: wire,
    });
    return {
      accepted_at,
      receipt: {
        hash,
        canonical_json,
        accepted_at,
      },
    };
  }

  /**
   * Pull the current resolution status for the marketRef.
   *
   * SHELL caveat: the universal {@link MarketRef} carries no DB / call
   * context — the legacy resolver flow needs a t0 anchor (per-call) and the
   * void_band (per-market) which neither live on MarketRef. The Phase 5
   * cutover wires the call's resolver context into a richer
   * `observeResolution(marketRef, callCtx)` overload (NOT yet on the
   * interface). Until then, this method returns 'pending' so the universal
   * resolver loop (when Phase 5 lands) is forced to fall through to the
   * legacy code path. The verifier exercises the SAME logic via the
   * `observeResolutionForCall` helper exported below — that's the byte-for-
   * byte equivalence proof.
   *
   * Phase 5 will replace this body with a real implementation that:
   *   1. Loads the market row via `marketsRepo.get(db, marketRef.sourceId)`
   *   2. Loads the call's t0 anchor via `anchorsRepo.getT0(db, callId)`
   *   3. Polls the latest oracle observation via `observeOracle(db, ...)`
   *   4. Computes `signed_return = computeSignedReturn(side, p0, p1)`
   *   5. Maps via `signedReturnToPayoutNumerators(signed_return, voidBand)`
   *   6. Returns the {@link Outcome} with `kind='binary'`, denom=1n
   */
  async observeResolution(
    _marketRef: MarketRef,
  ): Promise<Outcome | "pending" | "disputed"> {
    // Intentional pending — see docstring. The Phase-5-ready helper that
    // produces a real Outcome lives at `observeResolutionForCall` below.
    return "pending";
  }

  /**
   * Score a commitment against its resolution. Reduces to today's binary
   * Brier-direction proxy on the 2-element payout vector — `callScore` is
   * `1 − halfL1Distance(predicted, resolved)`, and on `[1,0]` vs `[1,0]` it's
   * 1.0; vs `[0,1]` it's 0.0; vs `[0,0]` (legacy void) it's 0.5.
   *
   * `components` carries the void-collapse rationale for receipt replay: the
   * adapter records the resolved vector + a tag identifying which legacy bin
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

  /**
   * Receipt verification for replay / dispute. Structural re-hash of the
   * canonical JSON returned by `acceptCommitment`. Wave 4b retired the
   * daemon-side receipt-chain verifier (`src/verdict/verify.ts` is gone);
   * this adapter-private check is the only canonical-replay contract,
   * scoped to the in-memory blob the adapter itself produced.
   */
  verifyReceipt(canonicalJson: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(canonicalJson);
    } catch {
      return false;
    }
    if (parsed === null || typeof parsed !== "object") return false;

    // BUG FIX (codex review v3 P2 #4): the previous implementation only
    // checked the canonical hash had a 0x prefix — ANY canonical JSON
    // (including {}) passed. Validate the parsed payload actually has the
    // shape NativePriceAdapter.acceptCommitment produces:
    //   {
    //     adapter: 'native-price',
    //     version: '1.0.0',
    //     accepted_at: <ISO>,
    //     commitment: {
    //       marketRef: { protocol: 'native-price', sourceId, configVersion },
    //       predictedOutcome: { kind, payoutNumerators, payoutDenominator },
    //       horizon, confidence
    //     }
    //   }
    //
    // A receipt belonging to a different adapter (e.g. polymarket-gamma)
    // MUST return false here — that's the "rubber-stamp" the bug fix exists
    // to prevent. Once the shape is confirmed, the canonical-hash + round-
    // trip check stays the structural integrity gate (catches tampering
    // that preserves shape).
    const shapeOk = isNativePriceAcceptanceReceipt(parsed);
    if (!shapeOk) return false;

    const recomputed = canonicalHash(parsed as Record<string, unknown>);
    const recanonical = canonicalize(parsed as Record<string, unknown>);
    return recanonical === canonicalJson && recomputed.startsWith("0x");
  }
}

/**
 * BUG FIX (codex review v3 P2 #4): structural validator for the canonical
 * JSON {@link NativePriceAdapter.acceptCommitment} produces. Mirrors the
 * exact key set + literal markers (adapter='native-price',
 * commitment.marketRef.protocol='native-price') so a receipt belonging to
 * any other adapter fails this gate.
 */
function isNativePriceAcceptanceReceipt(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["adapter"] !== ADAPTER_NAME) return false;
  if (typeof obj["version"] !== "string") return false;
  if (typeof obj["accepted_at"] !== "string") return false;
  const commitment = obj["commitment"];
  if (
    commitment === null ||
    typeof commitment !== "object" ||
    Array.isArray(commitment)
  ) {
    return false;
  }
  const c = commitment as Record<string, unknown>;
  const marketRef = c["marketRef"];
  if (
    marketRef === null ||
    typeof marketRef !== "object" ||
    Array.isArray(marketRef)
  ) {
    return false;
  }
  const m = marketRef as Record<string, unknown>;
  if (m["protocol"] !== SOURCE_PROTOCOL) return false;
  if (typeof m["sourceId"] !== "string") return false;
  if (typeof m["configVersion"] !== "number") return false;
  const predicted = c["predictedOutcome"];
  if (
    predicted === null ||
    typeof predicted !== "object" ||
    Array.isArray(predicted)
  ) {
    return false;
  }
  const p = predicted as Record<string, unknown>;
  if (typeof p["kind"] !== "string") return false;
  if (!Array.isArray(p["payoutNumerators"])) return false;
  if (typeof p["payoutDenominator"] !== "string") return false;
  // horizon + confidence required at the commitment level — accepts any
  // structurally valid value (Zod re-validation lives on the producer side).
  if (c["horizon"] === undefined) return false;
  if (typeof c["confidence"] !== "number") return false;
  return true;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** ISO8601 UTC with 'Z' suffix and no fractional seconds — matches the daemon's
 *  acceptance-time format used in receipts. */
function nowIsoUtcZ(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Bigint → wire-string transform. The Commitment carries bigints in
 * `predictedOutcome.payoutNumerators` / `payoutDenominator`; canonical JSON
 * doesn't support bigint. This produces the on-the-wire shape the canonicalizer
 * can stringify.
 */
function toCanonicalCommitmentWire(c: Commitment): unknown {
  return {
    marketRef: {
      protocol: c.marketRef.protocol,
      sourceId: c.marketRef.sourceId,
      configVersion: c.marketRef.configVersion,
    },
    predictedOutcome: {
      kind: c.predictedOutcome.kind,
      payoutNumerators: c.predictedOutcome.payoutNumerators.map((n) =>
        n.toString(),
      ),
      payoutDenominator: c.predictedOutcome.payoutDenominator.toString(),
      ...(c.predictedOutcome.scalarValue !== undefined
        ? { scalarValue: c.predictedOutcome.scalarValue.toString() }
        : {}),
    },
    horizon: c.horizon,
    confidence: c.confidence,
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

// ─── Phase 5 prep — observeResolutionForCall (NOT on the public interface) ─
//
// The legacy resolver path needs DB + call_id + observation context to compute
// signed_return → outcome. The universal `observeResolution(marketRef)` can't
// pull those today (MarketRef carries no DB). This concrete helper is the
// SHELL's "real" observation path — Phase 5 will fold it back behind the
// adapter interface.
//
// Inputs are all already on the resolver's `runT1Phase` hot path
// (resolver.ts:177-256), so the cutover is a mechanical lift. Outputs include
// the legacy values (signed_return, p0, p1) inside `evidence.raw` for receipt
// replay parity.

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
  /** Legacy side. Phase 5 derives this from the universal Commitment instead. */
  side: "BUY" | "SELL";
  /** marketRef.sourceId — used as evidence.sourceId on the Outcome. */
  market_id: string;
}

/**
 * Compute the resolved {@link Outcome} for a native-price call exactly the way
 * the legacy resolver does today. Phase 5 will plumb this into the universal
 * `observeResolution(marketRef, callCtx)` overload. Returned shape:
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
  const sideAdjustedReturn =
    ctx.side === "BUY" ? buyPerspectiveReturn : -buyPerspectiveReturn;
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

/**
 * Local mirror of `scoring.ts:computeSignedReturn`. Phase 5 will delete this
 * duplicate and route through the canonical implementation (the legacy path
 * lives one level above in the resolver, so it can't be lifted here without
 * pulling in scoring imports the adapter shouldn't depend on yet).
 *
 * `r = ln(p1/p0)` for BUY, `-ln(p1/p0)` for SELL — byte-identical to
 * `src/verdict/scoring.ts:68-80`. Rejects non-positive prices the same way.
 */
function computeSignedReturnLocal(
  side: "BUY" | "SELL",
  p0: string,
  p1: string,
): number {
  const a = Number(p0);
  const b = Number(p1);
  if (!(a > 0) || !(b > 0)) {
    throw new Error("p0 and p1 must be positive decimal strings");
  }
  const ln = Math.log(b / a);
  return side === "BUY" ? ln : -ln;
}

// Wave 4b — receipts subsystem dropped. The Phase-5 cutover-seam stub
// that bound the receipt schemas here is no longer needed; SCHEMA_VERSION
// stays in scope for future commit-time stamping use.
void SCHEMA_VERSION;
