import type { Request } from "express";
import { keccak256, toHex } from "viem";

/**
 * Hash an arbitrary string to a deterministic 32-byte hex handle.
 * Circle's `transaction` UUID isn't 32 bytes; we keccak256 it to get
 * a stable bytes32 we can put in the binding's `eip3009Nonce` slot.
 *
 * This helper remains for legacy already-settled receipt imports. The live
 * durable rail now captures and binds the actual EIP-3009 nonce before
 * settlement, so new receipts do not use this UUID digest.
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
