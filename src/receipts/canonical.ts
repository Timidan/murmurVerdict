import { keccak256, toHex } from "viem";

// Canonical JSON encoder used as the pre-image for receipt hashes.
//
// Rules:
//   - Object keys are sorted lexicographically at every depth.
//   - undefined fields are dropped (JSON.stringify default is preserved).
//   - Arrays preserve order; their elements are canonicalized recursively.
//   - Primitives serialize via JSON.stringify (matches RFC 8259 number form).
//   - No trailing newline, no whitespace.
//
// keccak256 is computed over the UTF-8 bytes of the canonical string. The
// returned hash is a 0x-prefixed lowercase 32-byte hex string.

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
