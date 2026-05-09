/**
 * Phase 5 — legacy ↔ universal commitment translation.
 *
 * Phase 4 (the v2 submission surface) writes `submissions.commitment_json` for
 * every new call. The Phase 5 resolver cutover needs to pass a universal
 * {@link Commitment} into `scoreOutcomeVector` for EVERY call — including
 * legacy v1 rows that pre-date Phase 4 and have NULL `commitment_json`.
 *
 * This module owns that translation. The path from a legacy row's
 * `(side, asset_id, horizon_hours, confidence, market_id?,
 *  market_config_version?)` tuple into a universal Commitment is identical
 * to what NativePriceAdapter's `commitmentSchema` Zod transform does at
 * Phase 4 submit time — we mirror the same logic here so legacy and v2
 * rows produce byte-identical Commitment shapes for the same fundamental
 * call. Phase 6 will fold the receipt-canonicalization side of this back
 * into a shared module.
 *
 * Cite: V2_DECISION_RECORD §2.2 (Commitment), §3.2 (legacy → vector mapping).
 *       NativePriceAdapter at `src/verdict/market-maker/native-price.ts:101-214`
 *       (the Zod transform side; this is its inverse for legacy rows).
 */

import {
  type Commitment,
  CommitmentSchema,
} from "./markets-core.js";
import {
  NATIVE_PRICE_ADAPTER_ID,
} from "./markets.js";
import { sideToPayoutNumerators } from "./market-maker/native-price.js";

/**
 * Inputs required to derive a Commitment from a legacy submission row. Every
 * field is read directly off `submissions.*` columns (or
 * `loadResolverContext()` for the resolver hot path).
 */
export interface LegacySubmissionForCommitment {
  /** "BUY" | "SELL" — direction-binary side. */
  side: "BUY" | "SELL";
  /** [0.51, 0.95] — legacy native-price confidence band. */
  confidence: number;
  /** Legacy asset_id ("base:ETH:USD", ...). Used to synthesize the
   *  marketRef.sourceId fallback when market_id is null. */
  asset_id: string;
  /** Legacy horizon_hours (0|1|4|24|168). */
  horizon_hours: number;
  /** ISO8601 expected resolution time. The resolver computes this as
   *  `accepted_at + horizon_seconds`; verify path uses the receipt's
   *  resolved_at. Either is acceptable since the Commitment.horizon.iso
   *  is render-only — scoreOutcomeVector never reads it. */
  expected_resolves_at_iso: string;
  /** Optional market_id from `submissions.market_id`. When present, becomes
   *  the marketRef.sourceId — preferred. */
  market_id?: string | null;
  /** Optional config version from `submissions.market_config_version`.
   *  Defaults to 1 for legacy rows without a stamped version. */
  market_config_version?: number | null;
}

/**
 * Build a universal {@link Commitment} from a legacy submission row. Inverse
 * of NativePriceAdapter's `commitmentSchema` transform — produces the same
 * Commitment shape that Phase 4's v2 submit endpoint stamps directly into
 * `submissions.commitment_json`.
 *
 * Field translation (matches V2 §3.2 + native-price adapter `commitmentSchema`):
 *   side=BUY  → predictedOutcome.payoutNumerators = [1n, 0n]
 *   side=SELL → predictedOutcome.payoutNumerators = [0n, 1n]
 *   payoutDenominator = 1n; kind = 'binary'
 *
 * marketRef.protocol is hardcoded to `'native-price'` because legacy rows can
 * only have come through the native-price market family (the only adapter
 * that exists at v0.2). When a third adapter lands its corresponding
 * inverse helper would live alongside this one and dispatch by
 * `markets.adapter_id`.
 *
 * Throws on invalid inputs — caller is responsible for confirming the
 * submission row has the legacy plaintext fields populated (i.e. NOT a
 * scrubbed committed-mode row).
 */
export function legacySubmissionToCommitment(
  row: LegacySubmissionForCommitment,
): Commitment {
  if (row.side !== "BUY" && row.side !== "SELL") {
    throw new Error(
      `legacySubmissionToCommitment: invalid side '${row.side}' (expected BUY|SELL)`,
    );
  }
  if (!Number.isFinite(row.confidence)) {
    throw new Error(
      `legacySubmissionToCommitment: invalid confidence '${row.confidence}'`,
    );
  }
  // Synthesize the legacy market_id from the asset/horizon tuple when missing.
  // Mirrors the native-price adapter's commitmentSchema fallback at
  // src/verdict/market-maker/native-price.ts:191-198. The resolver path
  // typically has market_id stamped post-MIGRATION_009, so this fallback only
  // triggers for very old pre-009 rows.
  const sourceId =
    row.market_id ??
    `${row.asset_id.toLowerCase()}.${row.horizon_hours}h`;
  const commitment: Commitment = {
    marketRef: {
      protocol: NATIVE_PRICE_ADAPTER_ID,
      sourceId,
      configVersion: row.market_config_version ?? 1,
    },
    predictedOutcome: {
      kind: "binary",
      payoutNumerators: [...sideToPayoutNumerators(row.side)],
      payoutDenominator: 1n,
    },
    horizon: { iso: row.expected_resolves_at_iso },
    confidence: row.confidence,
  };
  return commitment;
}

/**
 * Parse a stored `submissions.commitment_json` blob back into a runtime
 * {@link Commitment}. Mirrors {@link deserializeOutcome} for the commitment
 * side — bigint-string fields round-trip through `BigInt()` after Zod
 * validation. Returns null if `commitment_json` is null/empty (caller
 * should fall through to {@link legacySubmissionToCommitment}).
 *
 * The wire schema in `commitment_json` matches what NativePriceAdapter's
 * `toCanonicalCommitmentWire` produces at submit/Phase 4. Round-trip is
 * lossless for the four bigint-typed fields (numerators / denominator;
 * scalarValue if present).
 */
export function parseStoredCommitment(
  commitment_json: string | null | undefined,
): Commitment | null {
  if (!commitment_json) return null;
  // FIX 2 — robustness. Any failure along the parse chain (bad JSON,
  // schema mismatch, BigInt conversion of a non-integer string,
  // unexpected mutation of CommitmentSchema, ...) returns null so the
  // resolver's v2 path can fall back to legacy without poisoning the
  // tick. Reserve throws for unexpected programmer errors only — and
  // even those are absorbed by the resolver's outer try/catch (FIX 1).
  try {
    const parsed = JSON.parse(commitment_json);
    // CommitmentSchema validates the wire shape with bigint-strings; we map
    // those back to native bigints for the runtime Commitment.
    const validated = CommitmentSchema.parse(parsed);
    return {
      marketRef: validated.marketRef,
      predictedOutcome: {
        kind: validated.predictedOutcome.kind,
        payoutNumerators: validated.predictedOutcome.payoutNumerators.map(
          (s) => BigInt(s),
        ),
        payoutDenominator: BigInt(validated.predictedOutcome.payoutDenominator),
        ...(validated.predictedOutcome.scalarValue !== undefined
          ? { scalarValue: BigInt(validated.predictedOutcome.scalarValue) }
          : {}),
      },
      horizon: validated.horizon,
      confidence: validated.confidence,
    };
  } catch (err) {
    if (process.env.MURMUR_DEBUG_NORMALIZER === "1") {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[normalizer] parseStoredCommitment failed: ${msg}`);
    }
    return null;
  }
}
