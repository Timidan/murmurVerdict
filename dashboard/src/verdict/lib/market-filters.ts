// ─── market-filters — the checkable tiers of the markets matrix ─────────────
//
// Four tiers, venue first, bottoming out in the markets themselves (owner
// sign-off 2026-08-11): venue → category → series → market. Every tier is
// multi-select with ONE selection model — the subtractive one the asset chips
// already had: `null` means "all checked" (the resting state), a click turns
// one value off, and emptying a tier returns it to `null` rather than
// blanking the board.
//
// Upper tiers narrow lower ones: the category options are those present on
// the checked venues, and so on down. A selected value whose option vanishes
// is pruned silently — offering it would be a click that returns nothing.
//
// This module is pure data → data. What renders as a chip row versus a plain
// label ("a tier earns a row only when it branches") is the component's call.

/** One market flattened to its filterable coordinates. */
export interface FilterableMarket {
  /** Adapter id — "polymarket-gamma". The stable key; never shown. */
  venue: string;
  /** What the venue chip says — "polymarket". */
  venueLabel: string;
  /** The venue's own top-level category, or null (groups as uncategorised). */
  category: string | null;
  /** Series display name — "BTC Up or Down 5m" — or null for one-offs. */
  series: string | null;
  /** Stable leaf identity that survives windows rolling: series slug for a
   *  recurring market, market id for a one-off. */
  marketKey: string;
  /** What the leaf chip shows: asset symbol where the market is an asset,
   *  the question where it is not. */
  marketLabel: string;
}

/** Per-tier selection. `null` = all checked (the resting state). */
export interface MarketFilterState {
  venues: ReadonlySet<string> | null;
  categories: ReadonlySet<string> | null;
  series: ReadonlySet<string> | null;
  markets: ReadonlySet<string> | null;
}

export const ALL_CHECKED: MarketFilterState = {
  venues: null,
  categories: null,
  series: null,
  markets: null,
};

/** A checkable value in one tier, with its live market count. */
export interface TierOption {
  key: string;
  label: string;
  count: number;
}

export interface MarketFilterOptions {
  venues: TierOption[];
  categories: TierOption[];
  series: TierOption[];
  markets: TierOption[];
}

/** Key under which uncategorised rows group. Doubles as the display word. */
export const UNCATEGORISED = "uncategorised";

const categoryKey = (m: FilterableMarket): string => m.category ?? UNCATEGORISED;
const seriesKey = (m: FilterableMarket): string => m.series ?? m.marketKey;

const checked = (sel: ReadonlySet<string> | null, key: string): boolean =>
  sel === null || sel.has(key);

/**
 * Toggle one value, in the asset chips' subtractive model: from all-on the
 * first click narrows to everything EXCEPT that value; emptying or completing
 * the set returns to `null` (all).
 */
export function toggleTierValue(
  current: ReadonlySet<string> | null,
  key: string,
  allKeys: readonly string[],
): ReadonlySet<string> | null {
  if (current === null) {
    const next = new Set(allKeys);
    next.delete(key);
    return next.size === 0 ? null : next;
  }
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  if (next.size === 0) return null;
  if (next.size === allKeys.length) return null;
  return next;
}

/** The rows every checked tier lets through. */
export function filterMarkets(
  rows: readonly FilterableMarket[],
  state: MarketFilterState,
): FilterableMarket[] {
  return rows.filter(
    (m) =>
      checked(state.venues, m.venue) &&
      checked(state.categories, categoryKey(m)) &&
      checked(state.series, seriesKey(m)) &&
      checked(state.markets, m.marketKey),
  );
}

/**
 * The options each tier offers, upper tiers narrowing lower ones. Counts are
 * live market counts at that tier's own narrowing (a category count reflects
 * the checked venues, not the checked series below it). Order is first-seen,
 * which follows the venue's own ordering and stays stable across renders.
 */
export function marketFilterOptions(
  rows: readonly FilterableMarket[],
  state: MarketFilterState,
): MarketFilterOptions {
  const venueRows = rows;
  const categoryRows = rows.filter((m) => checked(state.venues, m.venue));
  const seriesRows = categoryRows.filter((m) =>
    checked(state.categories, categoryKey(m)),
  );
  const marketRows = seriesRows.filter((m) => checked(state.series, seriesKey(m)));
  return {
    venues: collect(venueRows, (m) => [m.venue, m.venueLabel]),
    categories: collect(categoryRows, (m) => [categoryKey(m), categoryKey(m)]),
    series: collect(seriesRows, (m) => [seriesKey(m), m.series ?? m.marketLabel]),
    markets: collect(marketRows, (m) => [m.marketKey, m.marketLabel]),
  };
}

/**
 * One tier's options, deduped and in a STABLE order.
 *
 * The sort is the point. Insertion order is whatever order the venue happened
 * to return its markets in, and that order changes between polls, so the
 * filter row re-shuffled under the reader — the same five assets came back as
 * `BTC ETH SOL XRP DOGE` on one load and `DOGE SOL BTC XRP ETH` on the next.
 * A control whose options move is a control you have to re-read every time,
 * and muscle memory never forms. Sorted by label, case-insensitively, with the
 * key as the tiebreak so two identical labels never swap places either.
 */
function collect(
  rows: readonly FilterableMarket[],
  pick: (m: FilterableMarket) => [key: string, label: string],
): TierOption[] {
  const seen = new Map<string, TierOption>();
  for (const m of rows) {
    const [key, label] = pick(m);
    const entry = seen.get(key);
    if (entry) entry.count += 1;
    else seen.set(key, { key, label, count: 1 });
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
      a.key.localeCompare(b.key),
  );
}

/**
 * Drop selected values that no longer exist among the tier's options. A tier
 * whose selection empties out returns to `null` — all checked — because a
 * board silently filtered by ghosts would read as a quiet market.
 */
export function pruneFilterState(
  state: MarketFilterState,
  options: MarketFilterOptions,
): MarketFilterState {
  return {
    venues: pruneTier(state.venues, options.venues),
    categories: pruneTier(state.categories, options.categories),
    series: pruneTier(state.series, options.series),
    markets: pruneTier(state.markets, options.markets),
  };
}

function pruneTier(
  sel: ReadonlySet<string> | null,
  options: readonly TierOption[],
): ReadonlySet<string> | null {
  if (sel === null) return null;
  const live = new Set(options.map((o) => o.key));
  const next = new Set([...sel].filter((k) => live.has(k)));
  if (next.size === 0) return null;
  if (next.size === live.size) return null;
  return next.size === sel.size ? sel : next;
}

// ─── URL round-trip ─────────────────────────────────────────────────────────
// A narrowed board is shareable and survives refresh. Absent param = tier at
// rest (all checked); keys are comma-joined and sorted so the same selection
// always mints the same address.

const TIER_PARAMS = [
  ["venue", "venues"],
  ["category", "categories"],
  ["series", "series"],
  ["market", "markets"],
] as const;

export function marketFilterToQuery(
  state: MarketFilterState,
): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [param, tier] of TIER_PARAMS) {
    const sel = state[tier];
    if (sel !== null && sel.size > 0) query[param] = [...sel].sort().join(",");
  }
  return query;
}

export function marketFilterFromQuery(
  get: (param: string) => string | null,
): MarketFilterState {
  const state: {
    -readonly [K in keyof MarketFilterState]: MarketFilterState[K];
  } = { ...ALL_CHECKED };
  for (const [param, tier] of TIER_PARAMS) {
    const raw = get(param);
    if (raw === null) continue;
    const keys = raw.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
    if (keys.length > 0) state[tier] = new Set(keys);
  }
  return state;
}
