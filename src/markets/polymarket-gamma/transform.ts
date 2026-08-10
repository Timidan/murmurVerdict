/**
 * Pure mapping helpers — Polymarket Gamma row → universal Outcome.
 *
 * Kept side-effect-free (no fetch, no DB, no clock) so the smoke driver
 * can exercise every branch deterministically with captured fixtures.
 * Every input that fails validation collapses to a typed sentinel
 * (`'pending'` / `'disputed'` / an `invalid` Outcome) — see
 * RESEARCH_polymarket_gamma_adapter.md §2.1 + §8 for the canonical table.
 *
 * Footgun: Gamma serializes `outcomes`, `outcomePrices`, `clobTokenIds`,
 * and `umaResolutionStatuses` as JSON-encoded STRINGS rather than arrays.
 * Every parse helper here does `JSON.parse(field)` then re-validates the
 * shape; a malformed JSON string returns 'pending' rather than throwing
 * so the resolver tick survives schema drift (V2_REVIEW BLOCKER #1).
 *
 * Cite: RESEARCH_polymarket_gamma_adapter.md §1, §2.1, §8.
 */
import type { Outcome } from "../../verdict/markets-core.js";

// ─── Snapshot shape (loose; validated by the adapter's marketConfigSchema) ──

/**
 * The subset of a Gamma `/markets` row we read. Pure-data, no methods.
 * The Zod marketConfigSchema in `./config.ts` is the canonical validator
 * for storage (with `.passthrough()` for forward-compat); this type is
 * a sympathetic mirror so the transform code reads like the schema.
 *
 * `conditionId` / `outcomes` / `outcomePrices` / `umaResolutionStatus`
 * are the load-bearing fields. Everything else is metadata that flows
 * through to `evidence.raw`.
 */
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
  /**
   * Venue-hosted artwork for the market. Gamma serves both on every row we
   * have observed and they are usually the SAME url; `icon` is the square
   * mark, `image` the wider card art. Display metadata only — nothing here
   * reaches the resolver, so a missing or hostile value can never change an
   * Outcome. First-class rather than left to the index signature below
   * because the stored config projection normalizes one of them into
   * `icon_url` (see ./config.ts) and a typo in the field name would silently
   * produce iconless markets forever.
   */
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
  // Allow forward-compat fields (Gamma adds them constantly; see §1).
  readonly [key: string]: unknown;
}

// ─── Outcome construction ───────────────────────────────────────────────────

const SOURCE_PROTOCOL = "polymarket-gamma" as const;

/**
 * GCD of two non-negative bigints. Identical to `gcdBig` in markets-core.ts
 * but inlined here so this module stays dependency-light (smoke runs
 * without pulling the full markets-core graph).
 */
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
 * Convert Gamma decimal-string prices to a reduced integer numerator /
 * denominator pair. Cross-multiplies by `10^maxDecimals` to land integer
 * numerators, then reduces by gcd. Examples (from RESEARCH §2.1):
 *
 *   ["1","0"]         → { numerators: [1n, 0n], denominator: 1n }
 *   ["0","1"]         → { numerators: [0n, 1n], denominator: 1n }
 *   ["0.5","0.5"]     → { numerators: [1n, 1n], denominator: 2n }
 *   ["0.7","0.3"]     → { numerators: [7n, 3n], denominator: 10n }
 *   ["0","0"]         → null  (caller emits kind='invalid')
 *
 * Returns null when:
 *   - input is not parseable JSON
 *   - parsed array is not length-2 of decimal strings
 *   - all prices are zero (the cancelled-market case — caller maps to
 *     kind='invalid' per §8)
 *
 * NEVER throws — caller relies on the null sentinel to collapse to
 * 'pending' or 'invalid' without aborting the resolver tick.
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
  // Validate every element is a finite non-negative decimal string.
  const decimals = parsed.map((p) => {
    if (typeof p !== "string") return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(p)) return null;
    return p;
  });
  if (decimals.some((d) => d === null)) return null;
  // Determine maxDecimals across the two strings.
  let maxDecimals = 0;
  for (const d of decimals) {
    const dot = (d as string).indexOf(".");
    const dec = dot < 0 ? 0 : (d as string).length - dot - 1;
    if (dec > maxDecimals) maxDecimals = dec;
  }
  // Build integer numerators against the scale 10^maxDecimals.
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
  // Cancelled market (all-zero prices) → caller emits kind='invalid'.
  if (numerators.every((n) => n === 0n)) return null;
  // Sum becomes the denominator (CTF payout-vector convention).
  let sum = 0n;
  for (const n of numerators) sum += n;
  if (sum === 0n) return null;
  // Reduce by gcd so [1,1]/2 stays [1,1]/2 rather than [50,50]/100.
  let g = sum;
  for (const n of numerators) g = gcdBig(g, n);
  if (g === 0n) g = 1n;
  return {
    numerators: numerators.map((n) => n / g),
    denominator: sum / g,
  };
}

/**
 * Inspect `umaResolutionStatuses` to decide whether the market is in a
 * disputed-in-flight state. Returns true iff the LAST entry is `'disputed'`
 * AND `umaResolutionStatus !== 'resolved'` — disputes that were eventually
 * re-proposed (last entry is `'proposed'` again) are NOT considered active
 * disputes here (kor-san-inc case in RESEARCH §4).
 *
 * Robust to malformed JSON (returns false; the caller will downgrade to
 * 'pending' via the outcomePrices parse path).
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
  // Last status is 'disputed' AND not yet resolved → currently disputed.
  return snapshot.umaResolutionStatus !== "resolved";
}

/**
 * Parse the `outcomes` JSON-encoded string to a `string[]` of labels.
 * Returns null on any failure; callers fall back to the conditionId-keyed
 * default index labels.
 */
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

/**
 * Compute the canonical `resolvedAt` (unix seconds) for a closed market.
 * Prefers `closedTime` (the row's own close stamp); falls back to
 * `umaEndDate`; finally to `endDate`. Returns null when none is parseable —
 * caller treats null as 'pending' (we can't sign an Outcome without a
 * resolvedAt).
 */
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
    // `closedTime` sometimes lands as `"2026-05-09 13:43:43+00"` rather
    // than ISO8601. Normalize the space → 'T' so Date.parse accepts it.
    const normalized = iso.replace(" ", "T");
    const ms = Date.parse(normalized);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

/**
 * Map a Gamma snapshot to the universal {@link Outcome} (or a sentinel).
 *
 * Return contract:
 *   - `'pending'`   — market still open, or schema drift on a USED field
 *   - `'disputed'`  — market closed but currently under UMA dispute
 *   - `Outcome`     — terminal resolution (kind='binary' or 'invalid')
 *
 * The resolved Outcome carries the FULL snapshot under `evidence.raw` so
 * verifiers can replay the mapping without an extra Gamma fetch. The
 * `sourceId` is the 32-byte hex `conditionId` (Polymarket's only stable
 * global key — slug is mutable, id is internal).
 *
 * NEVER throws. Every error path collapses to a sentinel + (in callers)
 * a logged error code; the resolver tick depends on this invariant
 * (V2_REVIEW BLOCKER #1, RESEARCH §8).
 */
export function gammaMarketToOutcome(
  snapshot: GammaMarketSnapshot,
): Outcome | "pending" | "disputed" {
  // Open market → pending.
  if (snapshot.closed !== true) return "pending";

  // Currently disputed → 'disputed' (informational; resolver waits).
  if (isDisputed(snapshot)) return "disputed";

  // UMA hasn't stamped 'resolved' yet → still pending even though
  // `closed === true` (some markets close on schedule before UMA seals).
  if (snapshot.umaResolutionStatus !== "resolved") return "pending";

  const resolvedAt = resolvedAtSeconds(snapshot);
  if (resolvedAt === null) return "pending";

  // Cancelled market (all-zero prices) → kind='invalid'. The resolver
  // voids the call per markets-core §62-86; no leaderboard impact.
  const prices = parseOutcomePrices(snapshot.outcomePrices);
  if (prices === null) {
    // Distinguish "schema drift" (no prices, no closed-zero signal) from
    // a real all-zero cancellation. Both routes look the same from here
    // because parseOutcomePrices returns null on either — but the
    // cancellation case has a parseable outcomes string with the
    // zero-zero signal. We can't recover the original numerator vector
    // for the evidence record on schema drift, so we stay 'pending'
    // (the resolver will retry next tick, and an operator alert fires
    // upstream from the client's consecutive_failures counter).
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
        // Fall through to 'pending'.
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
