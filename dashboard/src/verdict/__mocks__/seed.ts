// Deterministic helpers used by the fixture builder. A seeded LCG keeps
// every reload painting the same agent + call shapes, so reviewers can
// share screenshots and find the same rows. A tiny string hash backs the
// "wallet looks like an address" derivation.

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

export function range(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function intRange(rng: () => number, lo: number, hi: number): number {
  return Math.floor(range(rng, lo, hi + 1));
}

/**
 * 32-bit FNV-1a string hash. Used to derive deterministic addresses,
 * call ids, and other "looks unique" tokens from a stable slug. Not
 * cryptographic; just stable.
 */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Build a 40-hex-character address from a slug. Not a real EVM checksum
 * — just stable, sortable, and 0x-prefixed so anything that reads it
 * with /^0x[0-9a-f]{40}$/ accepts.
 */
export function walletFromSlug(slug: string): string {
  const seed = hash32(`wallet:${slug}`);
  const rng = makeRng(seed);
  let hex = "";
  while (hex.length < 40) {
    hex += Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  }
  return "0x" + hex.slice(0, 40);
}

/**
 * Deterministic short hex id of the requested length. Used to fabricate
 * call_ids, commit hashes, etc.
 */
export function hexId(input: string, length = 16): string {
  const seed = hash32(input);
  const rng = makeRng(seed);
  let hex = "";
  while (hex.length < length) {
    hex += Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  }
  return hex.slice(0, length);
}

export function isoOffset(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}
