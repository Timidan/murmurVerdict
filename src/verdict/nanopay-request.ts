import type { Request } from "express";
import { keccak256, toHex } from "viem";

/**
 * keccak256 of Circle's transaction UUID as a stable bytes32. Only for legacy settled-receipt
 * imports; the live rail binds the real EIP-3009 nonce.
 */
export function transactionUuidToBytes32(uuid: string): `0x${string}` {
  return keccak256(toHex(uuid));
}

/** `req.params.pipelineId` narrowed to 32-byte hex, or null. */
export function extractPipelineId(req: Request): string | null {
  const raw = req.params.pipelineId;
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    return null;
  }
  return raw;
}
