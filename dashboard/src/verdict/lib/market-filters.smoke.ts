import { strict as assert } from "node:assert";

import {
  ALL_CHECKED,
  filterMarkets,
  marketFilterFromQuery,
  marketFilterOptions,
  marketFilterToQuery,
  pruneFilterState,
  toggleTierValue,
  UNCATEGORISED,
  type FilterableMarket,
} from "./market-filters.js";

process.stdout.write("murmur markets filter tiers smoke\n");

// The catalogue from the signed-off Plate E states: two venues, mixed
// categories, one venue carrying two series, plus an uncategorised row.
const btc = (n: number): FilterableMarket => ({
  venue: "polymarket-gamma",
  venueLabel: "polymarket",
  category: "Crypto",
  series: "BTC Up or Down 5m",
  marketKey: "btc-up-or-down-5m",
  marketLabel: "BTC",
});
const rows: FilterableMarket[] = [
  btc(0),
  btc(1),
  {
    venue: "polymarket-gamma",
    venueLabel: "polymarket",
    category: "Crypto",
    series: "ETH Up or Down 5m",
    marketKey: "eth-up-or-down-5m",
    marketLabel: "ETH",
  },
  {
    venue: "polymarket-gamma",
    venueLabel: "polymarket",
    category: null,
    series: null,
    marketKey: "0xoneoff",
    marketLabel: "Will ETH break 5k",
  },
  {
    venue: "kalshi",
    venueLabel: "kalshi",
    category: "Politics",
    series: null,
    marketKey: "fed-cut-march",
    marketLabel: "Fed cuts in March",
  },
  {
    venue: "kalshi",
    venueLabel: "kalshi",
    category: "Economy",
    series: null,
    marketKey: "cpi-q3",
    marketLabel: "CPI above 3% in Q3",
  },
];

// ── resting state: everything through, options carry live counts ────────────
{
  assert.equal(filterMarkets(rows, ALL_CHECKED).length, rows.length);
  const opts = marketFilterOptions(rows, ALL_CHECKED);
  // Label order, not first-seen order. The venue returns its markets in an
  // order that changes between polls, so a first-seen tier re-shuffled the
  // filter row under the reader on every refresh.
  assert.deepEqual(
    opts.venues.map((o) => [o.key, o.count]),
    [["kalshi", 2], ["polymarket-gamma", 4]],
    "label order, live counts",
  );
  assert.deepEqual(
    opts.categories.map((o) => o.key),
    ["Crypto", "Economy", "Politics", UNCATEGORISED],
  );
  // The property that matters: the same set of markets yields the same option
  // order however the wire happened to sequence them.
  assert.deepEqual(
    marketFilterOptions([...rows].reverse(), ALL_CHECKED).venues.map((o) => o.key),
    opts.venues.map((o) => o.key),
    "option order is independent of row order",
  );
  // A row with no series leans on its market key so the tier stays total.
  assert.equal(opts.series.length, 5);
  assert.equal(opts.markets.length, 5, "two BTC windows collapse to one leaf");
  assert.equal(opts.markets[0]!.count, 2, "the BTC leaf counts both windows");
}

// ── subtractive toggling: the asset-chip model, verbatim ────────────────────
{
  const all = ["a", "b", "c"];
  const first = toggleTierValue(null, "b", all);
  assert.deepEqual([...first!].sort(), ["a", "c"], "first click = all except");
  assert.equal(toggleTierValue(first, "b", all), null, "completing returns to all");
  const down = toggleTierValue(toggleTierValue(first, "a", all), "c", all);
  assert.equal(down!.size, 0, "unchecking the last chip does not check them all");
}

// ── upper tiers narrow lower options; filtering composes ────────────────────
{
  const onlyPoly: typeof ALL_CHECKED = {
    ...ALL_CHECKED,
    venues: new Set(["polymarket-gamma"]),
  };
  const opts = marketFilterOptions(rows, onlyPoly);
  assert.deepEqual(
    opts.categories.map((o) => o.key),
    ["Crypto", UNCATEGORISED],
    "kalshi-only categories drop out",
  );
  const alsoCrypto: typeof ALL_CHECKED = {
    ...onlyPoly,
    categories: new Set(["Crypto"]),
  };
  assert.deepEqual(
    marketFilterOptions(rows, alsoCrypto).markets.map((o) => o.label),
    ["BTC", "ETH"],
  );
  const narrowed = filterMarkets(rows, {
    ...alsoCrypto,
    markets: new Set(["btc-up-or-down-5m"]),
  });
  assert.equal(narrowed.length, 2, "both BTC windows, nothing else");
}

// ── pruning: ghost selections die silently, empty tiers rest ────────────────
{
  const stale: typeof ALL_CHECKED = {
    ...ALL_CHECKED,
    venues: new Set(["polymarket-gamma"]),
    categories: new Set(["Economy", "Crypto"]),
  };
  const pruned = pruneFilterState(
    stale,
    marketFilterOptions(rows, { ...stale, categories: null }),
  );
  assert.deepEqual(
    [...pruned.categories!],
    ["Crypto"],
    "Economy only existed on kalshi; unchecking kalshi drops it",
  );
  const ghostOnly: typeof ALL_CHECKED = {
    ...ALL_CHECKED,
    categories: new Set(["Sports"]),
  };
  assert.equal(
    pruneFilterState(ghostOnly, marketFilterOptions(rows, ALL_CHECKED)).categories,
    null,
    "a selection of nothing but ghosts returns the tier to rest",
  );
}

// ── URL round-trip: same selection, same address, absent = at rest ──────────
{
  const state: typeof ALL_CHECKED = {
    venues: new Set(["kalshi", "polymarket-gamma"]),
    categories: null,
    series: null,
    markets: new Set(["btc-up-or-down-5m"]),
  };
  const query: Record<string, string> = marketFilterToQuery(state);
  // Captured before deepEqual: strict assert narrows `query` to the literal.
  const get = (k: string): string | null => query[k] ?? null;
  // `markets`, not `market` — that key belongs to the detail drawer.
  assert.deepEqual(query, {
    venue: "kalshi,polymarket-gamma",
    markets: "btc-up-or-down-5m",
  });
  const back = marketFilterFromQuery(get);
  assert.deepEqual([...back.venues!].sort(), ["kalshi", "polymarket-gamma"]);
  assert.equal(back.categories, null);
  assert.deepEqual([...back.markets!], ["btc-up-or-down-5m"]);
  assert.deepEqual(marketFilterToQuery(ALL_CHECKED), {}, "rest carries no params");
}

// ── An emptied tier survives the reload it used to undo ─────────────────────
{
  const emptied: typeof ALL_CHECKED = { ...ALL_CHECKED, markets: new Set() };
  const query: Record<string, string> = marketFilterToQuery(emptied);
  const back = marketFilterFromQuery((k) => query[k] ?? null);
  assert.equal(back.markets?.size, 0, "an emptied tier comes back empty, not at rest");
}

process.stdout.write("markets filter tiers smoke ok\n");
