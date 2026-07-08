import type { Outcome } from "../markets-core.js";
import type { ObservationContext } from "../../markets/types.js";

const SOURCE_PROTOCOL = "native-price" as const;

/**
 * Inverse mapping: signed_return + void_band -> resolved payout vector.
 * `signed_return` is `ln(p1/p0)` from the BUY perspective. `void_band` is the
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
  if (signed_return >= +void_band) return [1n, 0n];
  if (signed_return <= -void_band) return [0n, 1n];
  return [0n, 0n];
}

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
   * Optional. The resolved Outcome is side-independent: the payout vector is
   * keyed on actual price direction [UP, DOWN], not the agent's prediction.
   *
   * When supplied by legacy/debug callers, it affects only
   * `evidence.raw.signed_return`.
   */
  side?: "BUY" | "SELL";
  /** marketRef.sourceId, used as evidence.sourceId on the Outcome. */
  market_id: string;
}

/**
 * Structurally narrow the universal ObservationContext to the native-price
 * shape. Returns null when any required field is missing or mistyped, allowing
 * the Adapter to report "pending" instead of throwing.
 */
export function narrowNativePriceContext(
  ctx: ObservationContext,
): NativePriceObservationContext | null {
  if (typeof ctx.t0_p0 !== "string") return null;
  if (typeof ctx.t1_p1 !== "string") return null;
  if (typeof ctx.t1_iso !== "string") return null;
  if (typeof ctx.t1_feed !== "string") return null;
  if (typeof ctx.t1_source_id !== "string") return null;
  if (typeof ctx.void_band !== "number") return null;
  if (typeof ctx.market_id !== "string") return null;
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
 * Compute the resolved Outcome for a Native Price Market:
 *
 * - kind: "binary", including void outcomes
 * - payoutNumerators: [UP, DOWN]
 * - payoutDenominator: 1n
 * - resolvedAt: unix seconds parsed from t1_iso
 */
export function observeResolutionForCall(
  ctx: NativePriceObservationContext,
): Outcome {
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
