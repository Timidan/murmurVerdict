import {
  AcceptanceReceiptPayload,
  AcceptanceReceiptPayloadSchema,
  ResolutionReceiptPayload,
  ResolutionReceiptPayloadSchema,
} from "../verdict/schema.js";
import { canonicalHash, canonicalize } from "./canonical.js";

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
