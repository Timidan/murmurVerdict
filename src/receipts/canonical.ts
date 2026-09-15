import { keccak256, toHex } from "viem";

// Canonical JSON, the pre-image for receipt hashes: keys sorted at every depth, undefined
// dropped, arrays keep order, primitives via JSON.stringify, no whitespace.
// The hash is keccak256 over the UTF-8 bytes, as 0x-prefixed lowercase hex.

export function canonicalize(value: unknown): string {
  return stableStringify(value);
}

export function canonicalHash(value: unknown): `0x${string}` {
  const json = canonicalize(value);
  const bytes = new TextEncoder().encode(json);
  return keccak256(toHex(bytes));
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-finite numbers are not canonicalizable");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new Error(
      "bigint is not canonicalizable; serialize as decimal string before hashing",
    );
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ":" + stableStringify(obj[k]),
    );
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`unsupported value type: ${typeof value}`);
}
