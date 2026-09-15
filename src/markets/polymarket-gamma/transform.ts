/**
 * Pure Gamma row → Outcome mapping. Never throws: bad input becomes
 * 'pending', 'disputed' or an invalid Outcome so the resolver tick survives
 * schema drift.
 *
 * Gamma sends `outcomes`, `outcomePrices`, `clobTokenIds` and
 * `umaResolutionStatuses` as JSON-encoded strings, not arrays.
 */
import type { Outcome } from "../../verdict/markets-core.js";

/** The Gamma `/markets` fields we read. `./config.ts` owns the stored schema. */
export interface GammaMarketSnapshot {
  readonly conditionId: string;
  readonly slug?: string;
  /** JSON-encoded string of `string[]` (always length 2 for binary). */
  readonly outcomes: string;
  /** JSON-encoded string of `string[]` (decimal strings, e.g. `["1","0"]`). */
  readonly outcomePrices?: string;
  /** JSON-encoded string of `string[]`. Last entry is the live status. */
  readonly umaResolutionStatuses?: string;
  readonly umaResolutionStatus?: string | null;
  readonly question?: string;
  /** Display-only artwork: `icon` is the square mark, `image` the card art. Normalized into `icon_url` by config.ts. */
  readonly icon?: string;
  readonly image?: string;
  readonly closed?: boolean;
  readonly active?: boolean;
  readonly archived?: boolean;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly umaEndDate?: string;
  readonly closedTime?: string;
  readonly umaBond?: string;
  readonly resolvedBy?: string;
  // Gamma adds fields constantly.
  readonly [key: string]: unknown;
}

const SOURCE_PROTOCOL = "polymarket-gamma" as const;

/** Local copy of markets-core's gcdBig so this module only imports types. */
function gcdBig(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0n ? 1n : x;
}

/**
 * Gamma decimal-string prices → reduced integer payout vector.
 *
 *   ["1","0"]     → [1n, 0n] / 1n
 *   ["0.5","0.5"] → [1n, 1n] / 2n
 *   ["0.7","0.3"] → [7n, 3n] / 10n
 *
 * Null on bad JSON, anything but two decimal strings, or all-zero prices
 * (cancelled; the caller emits kind='invalid').
 */
export function parseOutcomePrices(
  jsonStr: string | undefined,
): { numerators: bigint[]; denominator: bigint } | null {
  if (typeof jsonStr !== "string" || jsonStr.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const decimals = parsed.map((p) => {
    if (typeof p !== "string") return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(p)) return null;
    return p;
  });
  if (decimals.some((d) => d === null)) return null;
  let maxDecimals = 0;
  for (const d of decimals) {
    const dot = (d as string).indexOf(".");
    const dec = dot < 0 ? 0 : (d as string).length - dot - 1;
    if (dec > maxDecimals) maxDecimals = dec;
  }
  const scale = 10n ** BigInt(maxDecimals);
  const numerators: bigint[] = [];
  for (const d of decimals) {
    const s = d as string;
    const dot = s.indexOf(".");
    if (dot < 0) {
      numerators.push(BigInt(s) * scale);
    } else {
      const whole = s.slice(0, dot);
      const frac = s.slice(dot + 1);
      // pad fractional to maxDecimals so concatenation is integer-exact
      const padded = (frac + "0".repeat(maxDecimals - frac.length)) || "0";
      numerators.push(BigInt(whole) * scale + BigInt(padded));
    }
  }
  if (numerators.every((n) => n === 0n)) return null;
  // CTF convention: the denominator is the sum.
  let sum = 0n;
  for (const n of numerators) sum += n;
  if (sum === 0n) return null;
  let g = sum;
  for (const n of numerators) g = gcdBig(g, n);
  if (g === 0n) g = 1n;
  return {
    numerators: numerators.map((n) => n / g),
    denominator: sum / g,
  };
}

/**
 * True when the last `umaResolutionStatuses` entry is 'disputed' and the
 * market isn't resolved. A dispute that was re-proposed is not active.
 */
export function isDisputed(snapshot: GammaMarketSnapshot): boolean {
  const raw = snapshot.umaResolutionStatuses;
  if (typeof raw !== "string" || raw.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  const last = parsed[parsed.length - 1];
  if (last !== "disputed") return false;
  return snapshot.umaResolutionStatus !== "resolved";
}

/** Parse a JSON-encoded string array; null on any failure. */
export function parseOutcomeLabels(jsonStr: string | undefined): string[] | null {
  if (typeof jsonStr !== "string" || jsonStr.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((p) => typeof p === "string")) return null;
  return parsed as string[];
}

/** Close time in unix seconds: `closedTime`, then `umaEndDate`, then `endDate`. Null means 'pending'. */
export function resolvedAtSeconds(
  snapshot: GammaMarketSnapshot,
): number | null {
  const candidates = [
    snapshot.closedTime,
    snapshot.umaEndDate,
    snapshot.endDate,
  ];
  for (const iso of candidates) {
    if (typeof iso !== "string" || iso.length === 0) continue;
    // `closedTime` sometimes arrives as "2026-05-09 13:43:43+00".
    const normalized = iso.replace(" ", "T");
    const ms = Date.parse(normalized);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

/**
 * Gamma snapshot → Outcome ('binary', or 'invalid' when cancelled),
 * 'disputed' (under UMA dispute), or 'pending' (open or drifted).
 * `evidence.raw` keeps the full snapshot for replay; `sourceId` is the
 * conditionId, Polymarket's only stable key.
 */
export function gammaMarketToOutcome(
  snapshot: GammaMarketSnapshot,
): Outcome | "pending" | "disputed" {
  if (snapshot.closed !== true) return "pending";

  if (isDisputed(snapshot)) return "disputed";

  // Some markets close on schedule before UMA seals.
  if (snapshot.umaResolutionStatus !== "resolved") return "pending";

  const resolvedAt = resolvedAtSeconds(snapshot);
  if (resolvedAt === null) return "pending";

  const prices = parseOutcomePrices(snapshot.outcomePrices);
  if (prices === null) {
    // Null is drift or cancellation. Only an all-zero pair is a
    // cancellation (voided call); drift stays 'pending' for a retry.
    const rawPrices = snapshot.outcomePrices;
    if (typeof rawPrices === "string") {
      try {
        const parsed = JSON.parse(rawPrices);
        if (Array.isArray(parsed) && parsed.length === 2) {
          const allZero = parsed.every(
            (p) => typeof p === "string" && /^0+(\.0+)?$/.test(p),
          );
          if (allZero) {
            return {
              kind: "invalid",
              payoutNumerators: [0n, 0n],
              payoutDenominator: 1n,
              resolvedAt,
              evidence: {
                sourceProtocol: SOURCE_PROTOCOL,
                sourceId: snapshot.conditionId,
                raw: snapshot,
              },
            };
          }
        }
      } catch {
        // drift: stay pending
      }
    }
    return "pending";
  }

  return {
    kind: "binary",
    payoutNumerators: prices.numerators,
    payoutDenominator: prices.denominator,
    resolvedAt,
    evidence: {
      sourceProtocol: SOURCE_PROTOCOL,
      sourceId: snapshot.conditionId,
      raw: snapshot,
    },
  };
}
