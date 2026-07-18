import { type Hex } from "viem";

/**
 * Production CoFHE-input hex normalization.
 *
 * Owned in the gateway family so the production Murmur-owned sealer never has
 * to reach into the operator-blind release-gate SURFACE for basic hex
 * conversion (that inverted the dependency: a test surface defining a
 * production convention). The operator-blind surface now delegates to these
 * and retags failures into its own release-gate error type.
 *
 * `CofheNormalizeError` carries `detail` + `excerpt` so a caller that wants a
 * richer error taxonomy can reconstruct it without string-parsing.
 */
export class CofheNormalizeError extends Error {
  constructor(
    readonly detail: string,
    readonly excerpt?: unknown,
  ) {
    super(detail);
    this.name = "CofheNormalizeError";
  }
}

/** Normalize a CoFHE ct-hash (bigint / number / decimal-or-0x string) to a
 *  lowercase 0x-prefixed bytes32 hex string. */
export function normalizeCofheCtHashToHex32(value: unknown, label: string): Hex {
  let hex: string;
  if (typeof value === "bigint") {
    hex = value.toString(16);
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CofheNormalizeError(
        `${label}.ctHash is not a safe non-negative integer`,
        value,
      );
    }
    hex = BigInt(value).toString(16);
  } else if (typeof value === "string") {
    hex = value.startsWith("0x") ? value.slice(2) : BigInt(value).toString(16);
  } else {
    throw new CofheNormalizeError(
      `${label}.ctHash has unsupported type ${typeof value}`,
    );
  }
  const out = `0x${hex.padStart(64, "0")}`.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(out)) {
    throw new CofheNormalizeError(`${label}.ctHash did not normalize to bytes32`, {
      value,
      normalized: out,
    });
  }
  return out as Hex;
}

/** Normalize a signature/bytes value to an even-length 0x-prefixed hex string. */
export function normalizeCofheBytesHex(value: unknown, label: string): Hex {
  if (typeof value !== "string") {
    throw new CofheNormalizeError(`${label}.signature must be a hex string`, value);
  }
  const out = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(out)) {
    throw new CofheNormalizeError(`${label}.signature is not even-length hex`, out);
  }
  return out as Hex;
}
