import { strict as assert } from "node:assert";

import type {
  WireMarketplaceListings,
  WireSellableCall,
} from "@shared/wire-marketplace";

import {
  availabilityLine,
  buildListingsMatrix,
  CELL_PRICE_TOOLTIP,
  DEFAULT_LEADERBOARD_VIEW,
  EMPTY_MATRIX,
  matrixEmptyState,
  matrixGridTemplate,
  seatsLabel,
  toTrackRecordView,
  UNLISTED,
  viewFromQuery,
  writeViewToQuery,
  type AvailabilityFeed,
} from "./listings-matrix.js";

process.stdout.write("murmur listings matrix smoke\n");

// ─── The `?view=` round-trip ────────────────────────────────────────────────
//
// Same idiom the ladder's tier/sort already use: defaults are OMITTED so a
// pristine board keeps a clean URL, and junk degrades to the default rather
// than rendering an empty view.

assert.equal(DEFAULT_LEADERBOARD_VIEW, "rankings", "the ladder stays the default view");
assert.equal(viewFromQuery(new URLSearchParams("")), "rankings");
assert.equal(viewFromQuery(new URLSearchParams("view=listings")), "listings");
assert.equal(viewFromQuery(new URLSearchParams("view=rankings")), "rankings");
assert.equal(viewFromQuery(new URLSearchParams("view=matrix")), "rankings", "junk → default");
assert.equal(viewFromQuery(new URLSearchParams("view=")), "rankings");

// Round-trip: whatever a write produces, a read must return unchanged.
for (const view of ["rankings", "listings"] as const) {
  const params = writeViewToQuery(new URLSearchParams(), view);
  assert.equal(viewFromQuery(params), view, `${view} survives the URL`);
}

// The default is stripped; a non-default is written; sibling params survive
// both, because tier/sort share this query string.
assert.equal(writeViewToQuery(new URLSearchParams("view=listings"), "rankings").toString(), "");
assert.equal(writeViewToQuery(new URLSearchParams(), "listings").toString(), "view=listings");
{
  const withSiblings = writeViewToQuery(new URLSearchParams("tier=main&sort=wr"), "listings");
  assert.equal(withSiblings.get("tier"), "main");
  assert.equal(withSiblings.get("sort"), "wr");
  assert.equal(withSiblings.get("view"), "listings");
  // …and clearing the view leaves the siblings alone.
  const cleared = writeViewToQuery(withSiblings, "rankings");
  assert.equal(cleared.get("view"), null);
  assert.equal(cleared.get("tier"), "main");
}

// ─── The live catalog shape ─────────────────────────────────────────────────
//
// Modelled on what GET /v1/marketplace/listings returns today: five series,
// one seller listing exactly one of them, with an all-null track record.
// A price of 500000 atoms is 0.5 USDC — the number a reader must see.

const series = (slug: string, title: string) => ({
  venue_series_id: `polymarket:${slug}`,
  venue: "polymarket",
  series_slug: slug,
  series_title: title,
  venue_category: "Crypto" as string | null,
});

const catalog: WireMarketplaceListings = {
  schema_version: 1,
  served_at: "2026-08-26T22:56:54Z",
  series: [
    series("btc-up-or-down-5m", "BTC Up or Down 5m"),
    series("doge-up-or-down-5m", "DOGE Up or Down 5m"),
    series("eth-up-or-down-5m", "ETH Up or Down 5m"),
    series("sol-up-or-down-5m", "SOL Up or Down 5m"),
    series("xrp-up-or-down-5m", "XRP Up or Down 5m"),
  ],
  agents: [
    {
      agent_id: "10404b3a-fe41-4d6a-81fd-2db4f03690d9",
      display_slug: "claude-4",
      display_name: "Claude 4",
      track_record: {
        tier: null,
        rank: null,
        verdict_score: null,
        verdict_score_lb: null,
        resolved_calls: 0,
        win_rate: null,
        marketplace_eligible: false,
      },
      listings: [
        {
          venue_series_id: "polymarket:btc-up-or-down-5m",
          current_terms: {
            price_atoms: "500000",
            currency: "USDC",
            pricing_version: "v1",
            max_subscribers_per_call: null,
            updated_at: "2026-08-26T00:48:30.302Z",
          },
        },
      ],
    },
    {
      agent_id: "22222222-2222-4222-8222-222222222222",
      display_slug: "veteran",
      display_name: "Veteran",
      track_record: {
        tier: "main",
        rank: 1,
        verdict_score: 0.0812,
        verdict_score_lb: 0.0311,
        resolved_calls: 128,
        win_rate: 0.617,
        marketplace_eligible: true,
      },
      listings: [
        {
          venue_series_id: "polymarket:btc-up-or-down-5m",
          current_terms: {
            // Deliberately past Number.MAX_SAFE_INTEGER: a formatter that
            // round-trips through a float silently corrupts this.
            price_atoms: "9007199254740993000000",
            currency: "USDC",
            pricing_version: "v2",
            max_subscribers_per_call: 25,
            updated_at: "2026-08-25T10:00:00.000Z",
          },
        },
        {
          venue_series_id: "polymarket:eth-up-or-down-5m",
          current_terms: {
            price_atoms: "70000",
            currency: "USDC",
            pricing_version: "v2",
            max_subscribers_per_call: null,
            updated_at: "2026-08-25T10:00:00.000Z",
          },
        },
      ],
    },
  ],
};

const LOADED: AvailabilityFeed = { status: "ok", purchaseAvailable: true, calls: [] };

// ─── Series become columns, agents become rows ──────────────────────────────

{
  const m = buildListingsMatrix(catalog, LOADED);
  assert.equal(m.columns.length, 5, "every series in the catalog gets a column");
  assert.equal(m.rows.length, 2, "every agent in the catalog gets a row");
  assert.deepEqual(
    m.columns.map((c) => c.venueSeriesId),
    catalog.series.map((s) => s.venue_series_id),
    "column order is the API's, not a re-sort",
  );
}

{
  const m = buildListingsMatrix(catalog, LOADED);
  const dogeCol = m.columns[1];
  assert.equal(dogeCol.venueSeriesId, "polymarket:doge-up-or-down-5m");
  assert.equal(dogeCol.sellers, 0, "a series with no sellers still gets a column");
  assert.equal(
    m.columns.find((c) => c.venueSeriesId === "polymarket:btc-up-or-down-5m")?.sellers,
    2,
    "both agents list BTC",
  );

  // Headers use the STORED title. Nothing parses asset or window out of a slug.
  assert.equal(dogeCol.title, "DOGE Up or Down 5m");
  assert.deepEqual(
    m.columns.map((c) => c.title),
    [
      "BTC Up or Down 5m",
      "DOGE Up or Down 5m",
      "ETH Up or Down 5m",
      "SOL Up or Down 5m",
      "XRP Up or Down 5m",
    ],
  );
}

// ─── Missing terms render an em dash, never a zero ──────────────────────────

{
  const m = buildListingsMatrix(catalog, LOADED);
  const claude = m.rows[0];
  assert.equal(claude.slug, "claude-4");
  assert.equal(claude.cells.length, m.columns.length, "cells are parallel to columns");
  assert.equal(claude.cells[0].listPrice?.display, "0.5", "500000 USDC atoms is 0.5");
  assert.equal(claude.listedCount, 1);
  for (const cell of claude.cells.slice(1)) {
    assert.equal(cell.listPrice, null, "an unlisted series carries no price at all");
  }
  assert.equal(UNLISTED, "—", "the unlisted marker is an em dash, not 0");
}

// ─── BigInt-safe money ──────────────────────────────────────────────────────
//
// The whole reason atoms travel as strings. Number(9007199254740993000000)
// loses precision; the formatter must not.

{
  const m = buildListingsMatrix(catalog, LOADED);
  const veteran = m.rows[1];
  assert.equal(veteran.cells[0].listPrice?.display, "9007199254740993");
  assert.notEqual(
    veteran.cells[0].listPrice?.display,
    String(Number("9007199254740993000000") / 1e6),
    "a float round-trip would corrupt this",
  );
  assert.equal(veteran.cells[2].listPrice?.display, "0.07", "70000 USDC atoms is 0.07");
  assert.equal(veteran.cells[0].listPrice?.priceAtoms, "9007199254740993000000");
  assert.equal(veteran.cells[0].listPrice?.maxSubscribersPerCall, 25);
}

// ─── The track record is ALL-TIME, and an unscored agent still renders ──────

{
  const scored = toTrackRecordView(catalog.agents[1].track_record);
  assert.equal(scored.scopeLabel, "all-time");
  assert.equal(scored.unscored, false);
  assert.equal(scored.floor, "+0.031");
  assert.equal(scored.winRate, "62%");
  assert.equal(scored.resolved, "128");
  assert.ok(scored.summary.includes("all-time"), "the tooltip says all-time");
  assert.ok(
    scored.summary.includes("not per series"),
    "and says explicitly that it is not per series",
  );

  const unscored = toTrackRecordView(catalog.agents[0].track_record);
  assert.equal(unscored.scopeLabel, "all-time");
  assert.equal(unscored.unscored, true);
  assert.equal(unscored.floor, "—", "no score resolves to a placeholder, not to 0");
  assert.equal(unscored.winRate, "—");
  assert.equal(unscored.resolved, "0", "a factual zero IS reported as zero");
  assert.ok(unscored.summary.includes("unscored"));

  // The unscored agent is a ROW, not an exclusion.
  const m = buildListingsMatrix(catalog, LOADED);
  assert.ok(
    m.rows.some((r) => r.slug === "claude-4" && r.track.unscored),
    "an unscored seller keeps its row",
  );
}

// ─── Availability overlays the matrix; it never gates it ────────────────────

const openCall = (over: Partial<WireSellableCall> = {}): WireSellableCall => ({
  onchain_call_id: "0xcall1",
  agent: { slug: "claude-4", display_name: "Claude 4" },
  agent_id: "10404b3a-fe41-4d6a-81fd-2db4f03690d9",
  market: { market_id: "0xmarket", question: "Bitcoin Up or Down - Aug 26, 11PM ET" },
  venue_series_id: "polymarket:btc-up-or-down-5m",
  locked_terms: { price_atoms: "700000", currency: "USDC", pricing_version: "v1" },
  seats_cap: 5,
  seats_reserved: 2,
  seats_remaining: 3,
  inventory_status: "available",
  sale_closes_at: "2026-08-26T23:02:00.000Z",
  reveal_open_at: "2026-08-26T23:05:00.000Z",
  ...over,
});

{
  // The standing price is 0.5; the open call was SEALED at 0.7. Both numbers
  // must survive, in different places — this is the exact bug the split exists
  // to prevent.
  const feed: AvailabilityFeed = {
    status: "ok",
    purchaseAvailable: true,
    calls: [openCall()],
  };
  const m = buildListingsMatrix(catalog, feed);
  const cell = m.rows[0].cells[0];
  assert.equal(cell.listPrice?.display, "0.5", "the cell keeps the STANDING price");
  assert.equal(cell.openCalls.length, 1);
  assert.equal(cell.openCalls[0].lockedDisplay, "0.7", "the drilldown carries the LOCKED price");
  assert.notEqual(
    cell.listPrice?.display,
    cell.openCalls[0].lockedDisplay,
    "the two prices legitimately disagree and both are preserved",
  );
  assert.equal(cell.openCalls[0].question, "Bitcoin Up or Down - Aug 26, 11PM ET");
  assert.equal(cell.openCalls[0].seatsLabel, "3 seats left");
  assert.equal(cell.openCalls[0].saleClosesAt, "2026-08-26T23:02:00.000Z");
  assert.equal(m.totalOpenCalls, 1);

  // A call belongs to ONE cell. The other seller's BTC cell stays empty.
  assert.equal(m.rows[1].cells[0].openCalls.length, 0);
}

{
  // A call with no series linkage is counted nowhere rather than pinned to an
  // arbitrary column.
  const feed: AvailabilityFeed = {
    status: "ok",
    purchaseAvailable: true,
    calls: [openCall({ venue_series_id: null })],
  };
  const m = buildListingsMatrix(catalog, feed);
  assert.equal(m.totalOpenCalls, 0);
  assert.equal(m.rows[0].cells[0].openCalls.length, 0);
}

// Seats: null is "not limited here", NEVER "none left".
assert.equal(seatsLabel(openCall({ seats_remaining: null, seats_cap: null })), "no seat limit");
assert.equal(seatsLabel(openCall({ seats_remaining: 1 })), "1 seat left");
assert.equal(seatsLabel(openCall({ seats_remaining: 0, inventory_status: "full" })), "full");
assert.equal(
  seatsLabel(openCall({ seats_remaining: 3, inventory_status: "checkout_unavailable" })),
  "3 seats left",
  "a missing checkout does not fabricate a seat shortage",
);

// ─── The three availability situations read differently ─────────────────────

{
  const m = buildListingsMatrix(catalog, LOADED);

  const idle = availabilityLine({ status: "ok", purchaseAvailable: true, calls: [] }, m);
  assert.equal(idle.tone, "dim");
  assert.ok(idle.text.startsWith("no calls open to buy right now."), idle.text);
  assert.ok(idle.text.includes("seals its next call"));

  const noCheckout = availabilityLine(
    { status: "ok", purchaseAvailable: false, calls: [] },
    m,
  );
  assert.ok(noCheckout.text.includes("checkout unavailable on this deployment"));
  assert.notEqual(noCheckout.text, idle.text, "a missing checkout is not an empty shelf");

  const failed = availabilityLine({ status: "error", message: "GET … → 503" }, m);
  assert.equal(failed.tone, "error");
  assert.ok(failed.text.includes("availability could not be checked"));
  assert.ok(
    failed.text.includes("standing prices below are unaffected"),
    "a failed inventory read must not read as a failed catalog",
  );

  const loading = availabilityLine({ status: "loading" }, m);
  assert.equal(loading.tone, "dim");
  assert.notEqual(loading.text, idle.text, "loading is not the same as empty");

  // Every one of the four still leaves the matrix fully drawn.
  for (const feed of [
    { status: "loading" },
    { status: "error", message: "boom" },
    { status: "ok", purchaseAvailable: false, calls: [] },
    { status: "ok", purchaseAvailable: true, calls: [] },
  ] as AvailabilityFeed[]) {
    const built = buildListingsMatrix(catalog, feed);
    assert.equal(built.columns.length, 5, "availability never removes a column");
    assert.equal(built.rows.length, 2, "availability never removes a row");
    assert.equal(built.rows[0].cells[0].listPrice?.display, "0.5");
  }
}

// ─── Zero listings gives a useful empty state ───────────────────────────────

{
  assert.equal(matrixEmptyState(buildListingsMatrix(catalog, LOADED)), null, "a live matrix says nothing");

  const noSellers = buildListingsMatrix({ ...catalog, agents: [] }, LOADED);
  assert.equal(noSellers.columns.length, 5, "the columns survive with zero sellers");
  const sellerless = matrixEmptyState(noSellers);
  assert.ok(sellerless && sellerless.includes("no agent has published a standing price"), sellerless ?? "");

  const noSeries = buildListingsMatrix({ ...catalog, series: [], agents: [] }, LOADED);
  const seriesless = matrixEmptyState(noSeries);
  assert.ok(seriesless && seriesless.includes("no venue series are registered"), seriesless ?? "");
  assert.notEqual(seriesless, sellerless, "an empty venue is not an empty marketplace");

  // A seller who withdrew every price is a third, distinct thing.
  const withdrawn = buildListingsMatrix(
    { ...catalog, agents: [{ ...catalog.agents[0], listings: [] }] },
    LOADED,
  );
  const withdrawnText = matrixEmptyState(withdrawn);
  assert.ok(withdrawnText && withdrawnText.includes("withdrawn"), withdrawnText ?? "");

  // No catalog at all (first paint / a failed catalog read) is inert, not a throw.
  assert.deepEqual(buildListingsMatrix(null, LOADED), EMPTY_MATRIX);
}

// ─── Layout: columns keep a usable width instead of being squeezed ──────────

{
  const five = matrixGridTemplate(5);
  assert.ok(five.gridTemplateColumns.includes("repeat(5, minmax(176px, 1fr))"), five.gridTemplateColumns);
  assert.equal(five.minWidth, "1152px", "272 head + 5 × 176 — wider than a phone, so it scrolls");

  const twenty = matrixGridTemplate(20);
  assert.equal(twenty.minWidth, "3792px", "20 columns do not compress into the viewport");
  assert.equal(matrixGridTemplate(0).minWidth, "272px");
  assert.equal(matrixGridTemplate(-3).minWidth, "272px", "a negative count cannot invert the grid");
}

// The tooltip is the one place the two-price rule is spelled out for a reader.
assert.ok(CELL_PRICE_TOOLTIP.includes("next call this agent seals"));
assert.ok(CELL_PRICE_TOOLTIP.includes("locked from when they were sealed"));

process.stdout.write("OK listings matrix smoke\n");
