import type { Request } from "express";
import { keccak256, toHex } from "viem";

/**
 * Hash an arbitrary string to a deterministic 32-byte hex handle.
 * Circle's `transaction` UUID isn't 32 bytes; we keccak256 it to get
 * a stable bytes32 we can put in the binding's `eip3009Nonce` slot.
 *
 * Note: the binding-field name `eip3009Nonce` is a misnomer in the
 * SDK-pivot flow — we don't see the raw EIP-3009 nonce because the
 * SDK middleware consumed + verified it before our handler runs.
 * Callers should treat this as a "settlement-handle digest" tying
 * the binding to Circle's transaction UUID rather than to the
 * buyer's signed nonce. Phase 1b (v52) renamed the schema column
 * from `eip3009_nonce` to `payment_handle`; the binding-wire field
 * name keeps the legacy `eip3009Nonce` slot for buyer-side backwards
 * compat until Phase 2 versions the wire shape.
 */
export function transactionUuidToBytes32(uuid: string): `0x${string}` {
  return keccak256(toHex(uuid));
}

/**
 * Extract + narrow `req.params.pipelineId` to a 32-byte hex string.
 * Express 5's `req.params[k]` is typed `string | string[] | undefined`
 * because of repeated-param semantics. Single-segment routes always
 * yield a string at runtime, but the type signature still requires
 * narrowing.
 *
 * Returns null on any malformed input.
 */
export function extractPipelineId(req: Request): string | null {
  const raw = req.params.pipelineId;
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    return null;
  }
  return raw;
}
