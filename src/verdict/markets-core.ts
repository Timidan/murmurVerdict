/**
 * Universal commitment + outcome primitives: a CTF payout vector tagged with `sourceProtocol`.
 * `call_score` is in [0, 1]: 1.0 perfect, 0.0 full miss.
 * bigint fields travel as decimal strings; see {@link serializeOutcome} / {@link deserializeOutcome}.
 */

import { z } from "zod";

// ─── Wire-shape primitives ───────────────────────────────────────────────────

/** Non-negative integer as a decimal digit string; the wire form of bigint fields. */
export const BigIntStringSchema = z.string().regex(/^[0-9]+$/, {
  message: "must be a non-negative integer encoded as decimal digits",
});

// ─── Outcome (universal resolution shape) ────────────────────────────────────

export type OutcomeKind = "binary" | "categorical" | "scalar" | "invalid";

/**
 * Universal resolution shape every adapter emits on resolve.
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
  /** CTF payout vector; sums to `payoutDenominator` unless `invalid`. */
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

// ─── Commitment (universal prediction shape) ─────────────────────────────────

/** The agent claims `predictedOutcome` will be the resolved payout vector at `marketRef`'s resolution. */
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

// ─── Scoring helpers ─────────────────────────────────────────────────────────

/**
 * Half-L1 distance between two payout vectors, in [0, 1]: 0 equal, 1 disjoint one-hots.
 * Denominators may differ (`[50,50]/100` vs `[1,0]/1`), so each side is cross-multiplied by the other's first.
 * `resolvedDenominator` defaults to `predictedDenominator`. Throws on length mismatch or a zero denominator.
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
  // Cross-rescale to a shared base; exact in bigint.
  let absSum = 0n;
  for (let i = 0; i < predicted.length; i++) {
    const p = (predicted[i] ?? 0n) * dRes;
    const r = (resolved[i] ?? 0n) * dPred;
    const d = p - r;
    absSum += d < 0n ? -d : d;
  }
  const commonDenom = dPred * dRes;
  // Reduce by GCD before Number conversion to keep precision on 1e18-style bases.
  const g = gcdBig(absSum, commonDenom);
  const num = absSum / g;
  const den = commonDenom / g;
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
 * `1 − halfL1Distance`, in [0, 1]: 1.0 perfect, 0.5 a 50/50 call, 0.0 full miss.
 * Throws on kind or length mismatch.
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

/** JSON-safe form of an {@link Outcome}; bigints become decimal strings. */
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

/** Inverse of {@link serializeOutcome}; throws on schema violation. */
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
