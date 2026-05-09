import {
  AcceptanceReceiptPayload,
  AcceptanceReceiptPayloadSchema,
  ResolutionReceiptPayload,
  ResolutionReceiptPayloadSchema,
  SCORING_VERSION,
} from "../verdict/schema.js";
import { canonicalHash, canonicalize } from "./canonical.js";
import {
  serializeOutcome,
  type Commitment,
  type Outcome as UniversalOutcome,
} from "../verdict/markets-core.js";

export interface BuiltReceipt<T> {
  payload: T;
  canonical_json: string;
  receipt_hash: `0x${string}`;
}

export function buildAcceptanceReceipt(
  payload: AcceptanceReceiptPayload,
): BuiltReceipt<AcceptanceReceiptPayload> {
  const parsed = AcceptanceReceiptPayloadSchema.parse(payload);
  const canonical_json = canonicalize(parsed);
  const receipt_hash = canonicalHash(parsed);
  return { payload: parsed, canonical_json, receipt_hash };
}

export function buildResolutionReceipt(
  payload: ResolutionReceiptPayload,
): BuiltReceipt<ResolutionReceiptPayload> {
  const parsed = ResolutionReceiptPayloadSchema.parse(payload);
  const canonical_json = canonicalize(parsed);
  const receipt_hash = canonicalHash(parsed);
  return { payload: parsed, canonical_json, receipt_hash };
}

// Helper for the resolver: build a re-resolution receipt that chains to the
// previous resolution receipt instead of the original acceptance receipt.
// Both `acceptance_receipt_hash` (top-level invariant: still the original
// acceptance) and `previous_hash` (the prior resolution) are tracked in DB,
// but the receipt payload itself only encodes acceptance_receipt_hash. The
// prior-resolution chain is recorded in the `disputes` table audit log.
export function buildReResolutionReceipt(
  payload: ResolutionReceiptPayload,
): BuiltReceipt<ResolutionReceiptPayload> {
  return buildResolutionReceipt(payload);
}

// ─── Phase 5 — V2 universal payout-vector receipt ────────────────────────────
//
// The legacy {@link buildResolutionReceipt} canonicalizes the price-specific
// resolution payload (t0/p0/t1/p1/t1_feed/signed_return/outcome/call_score).
// The Phase 5 cutover dual-writes a universal payout-vector receipt alongside
// it, canonicalizing the {@link Commitment} + {@link Outcome} pair plus the
// computed `call_score` (which may be `null` for void outcomes — see the
// scoreOutcomeVector void-mapping rule).
//
// Why a dedicated builder vs reusing buildResolutionReceipt:
//   The legacy ResolutionReceiptPayloadSchema has price-specific required
//   fields (p0, p1, signed_return, t0_feed, t1_feed) that don't exist on
//   non-financial markets. The v2 receipt drops those entirely — it carries
//   ONLY the canonical Commitment / Outcome pair plus the score. Phase 6
//   will widen ResolutionReceiptPayloadSchema to absorb both shapes; until
//   then this is a sibling builder.
//
// Cite: V2_DECISION_RECORD §2.1 (Outcome), §2.2 (Commitment), §2.3 (Score).

export interface V2ResolutionReceiptPayload {
  /** Schema marker — distinguishes universal-payout v2 receipts from the
   *  legacy v1 / v2-with-reveal-block resolution receipts. */
  schema: "murmur-resolution-v2@1";
  scoring_version: typeof SCORING_VERSION;
  call_id: string;
  /** Hash of the call's `acceptance` receipt — anchors the receipt chain
   *  back to submit. Same role as ResolutionReceiptPayload.acceptance_receipt_hash. */
  acceptance_receipt_hash: string;
  /** Universal Commitment in wire form (bigints stringified). Round-trips
   *  through `parseStoredCommitment`. */
  commitment: unknown;
  /** Universal Outcome in wire form (bigints stringified). Round-trips
   *  through `deserializeOutcome`. */
  outcome: unknown;
  /** Convenience copy of `outcome.payoutNumerators` so verifiers can
   *  inspect the vector without parsing the nested Outcome shape.
   *  Bigints stringified. */
  payout_vector: string[];
  /** Score from `scoreOutcomeVector(commitment, outcome)`. NULL for void
   *  outcomes (binary [0,0] or kind='invalid') — preserves the legacy
   *  leaderboard-exclusion semantics. */
  call_score: number | null;
  /** Adapter that produced the resolution. Today always 'native-price';
   *  Phase 11+ adds polymarket-gamma, etc. */
  adapter_id: string;
  /** ISO8601 UTC. */
  resolved_at: string;
}

export interface BuildV2ResolutionReceiptInput {
  call_id: string;
  acceptance_receipt_hash: string;
  commitment: Commitment;
  outcome: UniversalOutcome;
  call_score: number | null;
  adapter_id: string;
  resolved_at: string;
}

/**
 * Build the universal payout-vector resolution receipt. Canonical JSON shape
 * is fully self-describing (`schema` field) so a verifier can dispatch
 * v1-vs-v2 receipts without consulting external state.
 *
 * Bigint-safe canonicalization: `commitment` and `outcome` are pre-serialized
 * via {@link serializeOutcome} / inline transform so `canonicalize` (which
 * runs through `JSON.stringify`) doesn't see bigint values.
 *
 * The receipt does NOT chain to the previous resolution — the `previous_hash`
 * column on the receipts table carries that linkage. The payload itself only
 * encodes `acceptance_receipt_hash` so a receipt is replayable from the
 * canonical bytes alone (matches the legacy receipt's invariant).
 */
export function buildV2ResolutionReceipt(
  input: BuildV2ResolutionReceiptInput,
): BuiltReceipt<V2ResolutionReceiptPayload> {
  const commitmentWire = serializeCommitment(input.commitment);
  const outcomeWire = serializeOutcome(input.outcome);
  const payload: V2ResolutionReceiptPayload = {
    schema: "murmur-resolution-v2@1",
    scoring_version: SCORING_VERSION,
    call_id: input.call_id,
    acceptance_receipt_hash: input.acceptance_receipt_hash,
    commitment: commitmentWire,
    outcome: outcomeWire,
    payout_vector: input.outcome.payoutNumerators.map((n) => n.toString()),
    call_score: input.call_score,
    adapter_id: input.adapter_id,
    resolved_at: input.resolved_at,
  };
  // canonicalize requires a Record<string, unknown>; the typed payload
  // satisfies that structurally — pass through after a defensive shallow
  // copy so callers can't mutate post-build.
  const canonical_json = canonicalize({ ...payload });
  const receipt_hash = canonicalHash({ ...payload });
  return { payload, canonical_json, receipt_hash };
}

/** Bigint → wire-string transform for {@link Commitment}. Mirrors the same
 *  shape NativePriceAdapter's `toCanonicalCommitmentWire` produces. */
function serializeCommitment(c: Commitment): unknown {
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
