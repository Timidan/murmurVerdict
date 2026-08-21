/**
 * Universal commitment + outcome primitives for the v2 multi-market architecture.
 *
 * Cite: `.claude/architecture/V2_DECISION_RECORD.md` §2.1 (Outcome), §2.2
 * (Commitment), §2.3 (Score). The audit and the market-pattern research
 * converged on the same primitive: a **CTF payout-vector** with a
 * `sourceProtocol` tag. Every decision-market protocol either emits one
 * natively (Polymarket / CTF / Gnosis) or trivially packs into one
 * (binary direction, scalar bracket, Reality.eth bytes32 answer).
 *
 * Why this file exists:
 *   - The legacy `outcome ∈ {win, loss, void, oracle_unavailable}` is a
 *     binary collapse that survives only as a derived view; storage moves
 *     to `payoutNumerators[]`.
 *   - The legacy `side: 'BUY'|'SELL'` collapses to `[1,0]` / `[0,1]`.
 *   - `confidence` widens from `[0.51, 0.95]` (financial-direction specific)
 *     to `[0, 1]` so non-financial adapters can use the full range, or
 *     ignore it entirely.
 *
 * Score range: this module returns `call_score ∈ [0, 1]`, NOT the alternative
 * `[-1, +1]` mentioned in V2 §2.3. Picked `[0, 1]` for cleanness — `1.0` is a
 * perfect call, `0.0` is a full miss, `0.5` is 50/50 confidence on a 50/50
 * outcome. Confidence-weighted shifts to `[-1, +1]` are layered on top per
 * `market_family` by adapters that want directional sign.
 *
 * JSON serializability: bigint is not natively JSON-serializable. Numerator /
 * denominator fields use string-of-digits in the wire format (validated by
 * regex schema) and the {@link serializeOutcome} / {@link deserializeOutcome}
 * helpers round-trip the runtime `bigint` shape against the wire shape.
 */

import { z } from "zod";

// ─── Wire-shape primitives ───────────────────────────────────────────────────

/**
 * Non-negative integer encoded as a decimal digit-string. Used on the wire
 * for `payoutNumerators[]`, `payoutDenominator`, and `scalarValue`. Runtime
 * shape is `bigint` — see {@link serializeOutcome} / {@link deserializeOutcome}.
 */
export const BigIntStringSchema = z.string().regex(/^[0-9]+$/, {
  message: "must be a non-negative integer encoded as decimal digits",
});

// ─── Outcome (universal resolution shape — V2 §2.1) ──────────────────────────

export type OutcomeKind = "binary" | "categorical" | "scalar" | "invalid";

/**
 * Universal resolution shape. Every market-maker adapter emits this on
 * resolve. Storage layer; the legacy `{win|loss|void|oracle_unavailable}`
 * remains as a derived view (see V2 §2.1).
 *
 * Encoding by kind:
 *   - `binary`     → `payoutNumerators.length === 2`, e.g. `[1n, 0n]` (YES win)
 *   - `categorical`→ one-hot or fractional; `payoutDenominator = sum(numerators)`
 *   - `scalar`     → packed as `[N, MAX-N]` against `payoutDenominator`,
 *                    with `scalarValue` carrying the pre-collapse integer
 *   - `invalid`    → adapter declined to resolve (UMA "p4", missing data);
 *                    numerators unconstrained but `payoutDenominator > 0n`
 */
export interface Outcome {
  kind: OutcomeKind;
  /**
   * Canonical CTF payout vector. `sum(payoutNumerators) === payoutDenominator`
   * for valid (non-`invalid`) outcomes. Represented as bigint at runtime;
   * stringified on the wire — see {@link serializeOutcome}.
   */
  payoutNumerators: bigint[];
  /** Denominator for the payout vector. Must be `> 0n`. */
  payoutDenominator: bigint;
  /** Pre-collapse scalar (integer) when `kind === 'scalar'`. */
  scalarValue?: bigint;
  /** Unix seconds. The repo's wire-shape ISO conversion lives in adapters. */
  resolvedAt: number;
  /**
   * Verifiability bag. `raw` is the protocol-native response — kept for
   * receipts / replay / dispute, but NEVER trusted as direct scoring input.
   * Scoring runs against `payoutNumerators` / `payoutDenominator` only.
   */
  evidence: {
    sourceProtocol: string;
    sourceId: string;
    raw: unknown;
  };
}

export const OutcomeSchema = z.object({
  kind: z.enum(["binary", "categorical", "scalar", "invalid"]),
  payoutNumerators: z.array(BigIntStringSchema).min(1),
  payoutDenominator: BigIntStringSchema,
  scalarValue: BigIntStringSchema.optional(),
  resolvedAt: z.number().int().nonnegative(),
  evidence: z.object({
    sourceProtocol: z.string().min(1),
    sourceId: z.string().min(1),
    raw: z.unknown(),
  }),
});

// ─── MarketRef ───────────────────────────────────────────────────────────────

export interface MarketRef {
  protocol: string;
  sourceId: string;
  configVersion: number;
}

export const MarketRefSchema = z.object({
  protocol: z.string().min(1),
  sourceId: z.string().min(1),
  configVersion: z.number().int().nonnegative(),
});

// ─── Commitment (universal prediction shape — V2 §2.2) ───────────────────────

/**
 * Universal prediction shape. The agent claims `predictedOutcome` will be
 * the resolved payout vector at `marketRef`'s resolution. `confidence`
 * declares the agent's stated probability; `[0, 1]` is wider than the legacy
 * `[0.51, 0.95]` financial-direction band so non-financial adapters can use
 * the full range or ignore it (some markets carry no confidence at all).
 *
 * Note `predictedOutcome` is a structural subset of {@link Outcome} — the
 * adapter supplies `resolvedAt` / `evidence` at observation time.
 */
export interface Commitment {
  marketRef: MarketRef;
  /** Payout vector the agent claims. No `resolvedAt` / `evidence` (those
   *  belong on the resolved Outcome, not the predicted one). */
  predictedOutcome: Pick<
    Outcome,
    "kind" | "payoutNumerators" | "payoutDenominator" | "scalarValue"
  >;
  /** When the agent expects this market to resolve. */
  horizon: { iso: string; resolvesAfterMin?: number };
  /** [0, 1]. Adapters MAY further narrow this range per market_family. */
  confidence: number;
}

export const CommitmentSchema = z.object({
  marketRef: MarketRefSchema,
  predictedOutcome: z.object({
    kind: z.enum(["binary", "categorical", "scalar", "invalid"]),
    payoutNumerators: z.array(BigIntStringSchema).min(1),
    payoutDenominator: BigIntStringSchema,
    scalarValue: BigIntStringSchema.optional(),
  }),
  horizon: z.object({
    iso: z.string().min(1),
    resolvesAfterMin: z.number().int().nonnegative().optional(),
  }),
  confidence: z.number().min(0).max(1),
});

// ─── Scoring helpers (V2 §2.3) ───────────────────────────────────────────────

/**
 * Half-L1 distance over a CTF payout vector pair, normalized by denominator.
 *
 * Predicted and resolved vectors MAY come from different denominators —
 * e.g. a `[50,50]/100` softmax-style commitment scored against an oracle
 * one-hot `[1,0]/1`. Subtracting the raw numerators across mismatched
 * denominators produces nonsense (a half-L1 of 24.5 against a [0,1]
 * scale, callScore wildly outside [0,1]).
 *
 * Fix: rescale both vectors to a common base before subtracting. We
 * cross-multiply by the OTHER side's denominator, which is always safe
 * (no precision loss; bigint handles the size) and makes the two
 * vectors directly comparable on the shared base
 * `predictedDenominator * resolvedDenominator`:
 *
 *   predicted_n[i] = predicted[i] * resolvedDenominator
 *   resolved_n[i]  = resolved[i]  * predictedDenominator
 *   result = sum(|predicted_n[i] - resolved_n[i]|) / (2 * predictedDenominator * resolvedDenominator)
 *
 * Returns a number in `[0, 1]` for any well-formed payout vectors:
 *   - `0` when the (rescaled) vectors are equal
 *   - `1` when they are disjoint one-hots
 *
 * The four-arg form (predicted, resolved, predictedDenominator,
 * resolvedDenominator) is the canonical entry. Single-denominator callers
 * may omit `resolvedDenominator`, in which case we assume both vectors
 * share that base — preserves the legacy contract for callers who already
 * pass commensurate vectors.
 *
 * Throws when arrays differ in length or any denominator is zero — both
 * conditions are programmer errors at this layer.
 */
export function halfL1Distance(
  predicted: bigint[],
  resolved: bigint[],
  predictedDenominator: bigint,
  resolvedDenominator?: bigint,
): number {
  if (predicted.length !== resolved.length) {
    throw new Error(
      `halfL1Distance: length mismatch (predicted=${predicted.length}, resolved=${resolved.length})`,
    );
  }
  const dPred = predictedDenominator;
  const dRes = resolvedDenominator ?? predictedDenominator;
  if (dPred === 0n || dRes === 0n) {
    throw new Error("halfL1Distance: denominator must be non-zero");
  }
  // Cross-rescale to a shared base. bigint ops are exact and never
  // overflow at JS number precision risk here — the final ratio is
  // computed in Number space, which is fine because the numerator and
  // denominator share the same magnitude (the shared base) and cancel
  // back into [0, 1]. For pathologically large denominators we'd lose
  // precision converting to Number, but the ratio is bounded so the
  // result still lands in range; only the last few digits drift.
  let absSum = 0n;
  for (let i = 0; i < predicted.length; i++) {
    const p = (predicted[i] ?? 0n) * dRes;
    const r = (resolved[i] ?? 0n) * dPred;
    const d = p - r;
    absSum += d < 0n ? -d : d;
  }
  const commonDenom = dPred * dRes;
  // Reduce by GCD before converting to Number to keep precision well
  // away from MAX_SAFE_INTEGER even for large denominators (e.g.
  // gnosis-style 1e18 bases). gcd(absSum, commonDenom) is always > 0.
  const g = gcdBig(absSum, commonDenom);
  const num = absSum / g;
  const den = commonDenom / g;
  // half-L1: numerator / 2 / denominator. Numerator may still be huge
  // post-GCD (worst case = 2 * denominator on a full miss); the ratio
  // is bounded by 1 so Number conversion is well-conditioned.
  return Number(num) / 2 / Number(den);
}

function gcdBig(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0n ? 1n : x;
}

/**
 * Multinomial Brier-shell score. Returns `1 − halfL1Distance` ∈ `[0, 1]`.
 *
 *   - `1.0` perfect call  (predicted === resolved)
 *   - `0.5` 50/50 confidence on a 50/50 outcome
 *   - `0.0` full miss     (disjoint one-hots)
 *
 * Validates `predicted.kind === o.kind` and length agreement before
 * dispatching to {@link halfL1Distance}.
 */
export function callScore(c: Commitment, o: Outcome): number {
  if (c.predictedOutcome.kind !== o.kind) {
    throw new Error(
      `callScore: kind mismatch (predicted=${c.predictedOutcome.kind}, resolved=${o.kind})`,
    );
  }
  if (
    c.predictedOutcome.payoutNumerators.length !== o.payoutNumerators.length
  ) {
    throw new Error(
      `callScore: length mismatch (predicted=${c.predictedOutcome.payoutNumerators.length}, resolved=${o.payoutNumerators.length})`,
    );
  }
  return (
    1 -
    halfL1Distance(
      c.predictedOutcome.payoutNumerators,
      o.payoutNumerators,
      c.predictedOutcome.payoutDenominator,
      o.payoutDenominator,
    )
  );
}

// ─── Kind discriminators ─────────────────────────────────────────────────────

/** True iff `kind === 'binary'` AND `payoutNumerators.length === 2`. The
 *  length guard catches malformed binary outcomes (adapter bug). */
export function isBinary(o: Outcome): boolean {
  return o.kind === "binary" && o.payoutNumerators.length === 2;
}

export function isCategorical(o: Outcome): boolean {
  return o.kind === "categorical";
}

export function isScalar(o: Outcome): boolean {
  return o.kind === "scalar";
}

// ─── JSON serialize / deserialize (bigint round-trip) ────────────────────────

/**
 * Convert an {@link Outcome} to a JSON-safe object. `bigint` fields are
 * stringified; everything else passes through. The output round-trips through
 * `JSON.stringify` → `JSON.parse` → {@link deserializeOutcome}.
 */
export function serializeOutcome(o: Outcome): unknown {
  const wire: Record<string, unknown> = {
    kind: o.kind,
    payoutNumerators: o.payoutNumerators.map((n) => n.toString()),
    payoutDenominator: o.payoutDenominator.toString(),
    resolvedAt: o.resolvedAt,
    evidence: {
      sourceProtocol: o.evidence.sourceProtocol,
      sourceId: o.evidence.sourceId,
      raw: o.evidence.raw,
    },
  };
  if (o.scalarValue !== undefined) {
    wire.scalarValue = o.scalarValue.toString();
  }
  return wire;
}

/**
 * Parse a JSON-decoded value back into an {@link Outcome}. Validates the wire
 * shape via {@link OutcomeSchema}, then converts string bigints to native
 * `bigint`. Throws on schema violation or non-finite digits.
 */
export function deserializeOutcome(json: unknown): Outcome {
  const parsed = OutcomeSchema.parse(json);
  const out: Outcome = {
    kind: parsed.kind,
    payoutNumerators: parsed.payoutNumerators.map((s) => BigInt(s)),
    payoutDenominator: BigInt(parsed.payoutDenominator),
    resolvedAt: parsed.resolvedAt,
    evidence: {
      sourceProtocol: parsed.evidence.sourceProtocol,
      sourceId: parsed.evidence.sourceId,
      raw: parsed.evidence.raw,
    },
  };
  if (parsed.scalarValue !== undefined) {
    out.scalarValue = BigInt(parsed.scalarValue);
  }
  return out;
}
