// ─── listings-matrix — who lists what, at what standing price ───────────────
//
// The view model behind the leaderboard's `listings` view. Pure data → data,
// no React, so the whole thing is smoke-testable in node.
//
// TWO PRICES EXIST AND THEY MAY LEGITIMATELY DISAGREE. This module keeps them
// in separate shapes so no renderer can reach for "the price":
//
//   ListPriceView (from `current_terms`) lives on a matrix CELL. It is the
//     agent's standing listing — what their NEXT sealed call in that series
//     would cost. It carries no buy affordance, because nothing is on offer
//     at this number yet.
//   OpenCallView (from `locked_terms`) lives only inside the DRILLDOWN for a
//     cell. It is the snapshot frozen onto an already-sealed call, and it is
//     what a buyer actually pays for THAT call.
//
// A cell showing 0.05 beside a buy affordance, where the open call was sealed
// at 0.07, quotes a price the checkout will not honour. That is the bug this
// split exists to make unrepresentable — the drilldown deliberately does NOT
// carry the standing price at all.
//
// The two feeds are also independent by design: the catalog stands whether or
// not anything is currently sealed, so a failure to read inventory must never
// blank the matrix. `AvailabilityFeed` models that failure as a first-class
// state rather than as an empty list.

import type {
  WireMarketplaceListings,
  WireMarketplaceTrackRecord,
  WireSellableCall,
} from "@shared/wire-marketplace";

import { decimalsFor, formatAtoms } from "./atoms-format.js";
import { formatScore } from "./score-format.js";

/* ── The view control ─────────────────────────────────────────────────────── */

/**
 * The two things the public board can be. `rankings` is the ladder that has
 * always been there; `listings` is the browse matrix. Deliberately a view on
 * the SAME route rather than a fourth page — a separate agent list competing
 * with the ladder is the thing the design review ruled out.
 */
export const LEADERBOARD_VIEWS = ["rankings", "listings"] as const;
export type LeaderboardView = (typeof LEADERBOARD_VIEWS)[number];
export const DEFAULT_LEADERBOARD_VIEW: LeaderboardView = "rankings";

/** `?view=listings` → listings. Anything else, including junk, is the default. */
export function viewFromQuery(params: URLSearchParams): LeaderboardView {
  const raw = params.get("view");
  return (LEADERBOARD_VIEWS as readonly string[]).includes(raw ?? "")
    ? (raw as LeaderboardView)
    : DEFAULT_LEADERBOARD_VIEW;
}

/**
 * Mirror the view back into a query set, matching the tier/sort idiom already
 * on this page: the DEFAULT is omitted so a pristine board keeps a clean URL,
 * and a bogus incoming `?view=` is normalized away on the first write.
 * Mutates and returns the same params object the caller read.
 */
export function writeViewToQuery(
  params: URLSearchParams,
  view: LeaderboardView,
): URLSearchParams {
  if (view === DEFAULT_LEADERBOARD_VIEW) params.delete("view");
  else params.set("view", view);
  return params;
}

/* ── Availability, as a state rather than a list ──────────────────────────── */

/**
 * What the sellable-call read currently knows. `ok` with an empty `calls` is
 * the NORMAL resting state — markets roll on a five-minute clock and most of
 * that clock has nothing sealed inside it — and it is a different fact from
 * `error` (we could not look) and from `purchaseAvailable: false` (we looked,
 * and this deployment has no checkout at all).
 */
export type AvailabilityFeed =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; purchaseAvailable: boolean; calls: readonly WireSellableCall[] };

/* ── The matrix ───────────────────────────────────────────────────────────── */

/** One series column. `title` is the STORED series_title, never parsed from a slug. */
export interface MatrixColumn {
  venueSeriesId: string;
  title: string;
  venue: string;
  category: string | null;
  /** Sellers with a standing listing in this series. 0 draws an empty aisle. */
  sellers: number;
}

/** A cell's standing price. Never rendered beside a buy affordance. */
export interface ListPriceView {
  /** BigInt-safe decimal, e.g. "0.5". Formatted by lib/atoms-format. */
  display: string;
  priceAtoms: string;
  currency: string;
  pricingVersion: string;
  updatedAt: string;
  /** The owner's per-call subscriber ceiling; null means "as many as murmur can serve". */
  maxSubscribersPerCall: number | null;
}

/** One already-sealed call on offer. Carries the LOCKED price and nothing else. */
export interface OpenCallView {
  onchainCallId: string;
  /** The venue's human question, or null for a directly registered market. */
  question: string | null;
  marketId: string;
  /** What a buyer pays for THIS call. Frozen at seal time. */
  lockedDisplay: string;
  lockedPriceAtoms: string;
  currency: string;
  pricingVersion: string;
  /** "full" · "3 seats left" · "no seat limit" · "sale closed". Null is never rendered as zero. */
  seatsLabel: string;
  soldOut: boolean;
  /** False once the sale window passes, whatever the inventory read said. */
  buyable: boolean;
  inventoryStatus: WireSellableCall["inventory_status"];
  saleClosesAt: string;
}

export interface MatrixCell {
  venueSeriesId: string;
  /** null = this agent does not list this series. Renders as an em dash. */
  listPrice: ListPriceView | null;
  openCalls: OpenCallView[];
}

/**
 * The agent's ALL-TIME record, pre-labelled. It is global, never per-series,
 * and every string here says so — an agent selling three series carries one
 * record across all of them.
 */
export interface TrackRecordView {
  scopeLabel: "all-time";
  /** formatScore of verdict_score_lb — the careful number shown beside the score. */
  floor: string;
  /** The same number unformatted, for sorting. Null when nothing has resolved. */
  floorValue: number | null;
  winRate: string;
  resolved: string;
  rank: number | null;
  tier: WireMarketplaceTrackRecord["tier"];
  /** True when nothing has resolved yet. Shown with nulls, never excluded. */
  unscored: boolean;
  marketplaceEligible: boolean;
  /** One sentence for `title=`, so the cell itself stays three tokens wide. */
  summary: string;
}

export interface MatrixRow {
  agentId: string;
  slug: string;
  displayName: string;
  track: TrackRecordView;
  /** Parallel to `columns`, one entry per column, always the same length. */
  cells: MatrixCell[];
  listedCount: number;
  openCallCount: number;
}

export interface ListingsMatrix {
  columns: MatrixColumn[];
  rows: MatrixRow[];
  servedAt: string | null;
  totalListings: number;
  /** Every sealed call on the page, whether or not a seat is still on offer. */
  totalOpenCalls: number;
  /** The subset a buyer could actually take a seat on right now. */
  totalBuyableCalls: number;
}

export const EMPTY_MATRIX: ListingsMatrix = {
  columns: [],
  rows: [],
  servedAt: null,
  totalListings: 0,
  totalOpenCalls: 0,
  totalBuyableCalls: 0,
};

/** The one tooltip that keeps a cell from being read as a buy price. */
export const CELL_PRICE_TOOLTIP =
  "Current terms for the next call this agent seals. " +
  "Open calls keep the price locked from when they were sealed.";

/** The unlisted marker. One glyph, so an empty cell reads as absence, not zero. */
export const UNLISTED = "—";

/**
 * Join the catalog against live inventory.
 *
 * Series come from the catalog's OWN `series` array, not from the agents'
 * listings, so a series nobody sells still gets a column. Rows come from the
 * `agents` array in the order the daemon returned them (already sorted by
 * slug), so the matrix ordering is the API's rather than a re-sort that could
 * disagree with it.
 *
 * Availability is folded in per (agent, series) pair. A call whose
 * `venue_series_id` is null, or whose agent/series is not on this page, is
 * counted nowhere rather than attached to an arbitrary cell.
 *
 * `nowMs` is required and never read from the clock here: whether a sale window
 * has passed decides what can be bought, and a module that reads its own clock
 * cannot be tested against a fixed one.
 */
export function buildListingsMatrix(
  catalog: WireMarketplaceListings | null,
  feed: AvailabilityFeed,
  nowMs: number,
): ListingsMatrix {
  if (!catalog) return EMPTY_MATRIX;

  const calls = feed.status === "ok" ? feed.calls : [];
  // (agent_id, venue_series_id) → the calls that agent has open in that series.
  const byPair = new Map<string, WireSellableCall[]>();
  for (const call of calls) {
    if (!call.venue_series_id) continue;
    const key = pairKey(call.agent_id, call.venue_series_id);
    const bucket = byPair.get(key);
    if (bucket) bucket.push(call);
    else byPair.set(key, [call]);
  }

  const sellersPerSeries = new Map<string, number>();
  for (const agent of catalog.agents) {
    for (const listing of agent.listings) {
      sellersPerSeries.set(
        listing.venue_series_id,
        (sellersPerSeries.get(listing.venue_series_id) ?? 0) + 1,
      );
    }
  }

  const columns: MatrixColumn[] = catalog.series.map((series) => ({
    venueSeriesId: series.venue_series_id,
    title: series.series_title,
    venue: series.venue,
    category: series.venue_category,
    sellers: sellersPerSeries.get(series.venue_series_id) ?? 0,
  }));

  let totalListings = 0;
  let totalOpenCalls = 0;
  let totalBuyableCalls = 0;

  const rows: MatrixRow[] = catalog.agents.map((agent) => {
    const terms = new Map(agent.listings.map((l) => [l.venue_series_id, l.current_terms]));
    let listedCount = 0;
    let openCallCount = 0;
    const cells = columns.map((column): MatrixCell => {
      const current = terms.get(column.venueSeriesId);
      if (current) listedCount += 1;
      const open = (byPair.get(pairKey(agent.agent_id, column.venueSeriesId)) ?? []).map((call) =>
        toOpenCallView(call, nowMs),
      );
      openCallCount += open.length;
      totalBuyableCalls += open.filter((c) => c.buyable).length;
      return {
        venueSeriesId: column.venueSeriesId,
        listPrice: current
          ? {
              display: formatAtoms(current.price_atoms, current.currency),
              priceAtoms: current.price_atoms,
              currency: current.currency,
              pricingVersion: current.pricing_version,
              updatedAt: current.updated_at,
              maxSubscribersPerCall: current.max_subscribers_per_call,
            }
          : null,
        openCalls: open,
      };
    });
    totalListings += listedCount;
    totalOpenCalls += openCallCount;
    return {
      agentId: agent.agent_id,
      slug: agent.display_slug,
      displayName: agent.display_name,
      track: toTrackRecordView(agent.track_record),
      cells,
      listedCount,
      openCallCount,
    };
  });

  return {
    columns,
    rows,
    servedAt: catalog.served_at,
    totalListings,
    totalOpenCalls,
    totalBuyableCalls,
  };
}

function pairKey(agentId: string, venueSeriesId: string): string {
  // agent_id is a UUID and venue_series_id is "venue:slug"; neither contains a
  // newline, so this separator cannot collide the way ":" or "|" could.
  return `${agentId}\n${venueSeriesId}`;
}

function toOpenCallView(call: WireSellableCall, nowMs: number): OpenCallView {
  // `inventory_status` was read when the page loaded; the sale window keeps
  // running afterwards, so the deadline is re-checked on every build.
  const closed = saleClosed(call.sale_closes_at, nowMs);
  return {
    onchainCallId: call.onchain_call_id,
    question: call.market.question,
    marketId: call.market.market_id,
    lockedDisplay: formatAtoms(call.locked_terms.price_atoms, call.locked_terms.currency),
    lockedPriceAtoms: call.locked_terms.price_atoms,
    currency: call.locked_terms.currency,
    pricingVersion: call.locked_terms.pricing_version,
    seatsLabel: closed ? "sale closed" : seatsLabel(call),
    soldOut: call.inventory_status === "full",
    buyable: call.inventory_status === "available" && !closed,
    inventoryStatus: call.inventory_status,
    saleClosesAt: call.sale_closes_at,
  };
}

/**
 * Is the sale window past?
 *
 * An unparsable stamp never closes a sale: the checkout re-checks the window
 * itself and refuses with `SaleWindowClosed`, so a bad timestamp costs a wasted
 * click rather than hiding a call that is genuinely on offer.
 */
export function saleClosed(saleClosesAt: string, nowMs: number): boolean {
  const closesAtMs = Date.parse(saleClosesAt);
  return Number.isFinite(closesAtMs) && closesAtMs <= nowMs;
}

/**
 * Seats a new buyer could still take.
 *
 * `seats_remaining: null` means "not limited here", NOT "none left" — rendering
 * null as zero would tell a buyer a wide-open call is sold out.
 */
export function seatsLabel(call: WireSellableCall): string {
  if (call.inventory_status === "full") return "full";
  if (call.seats_remaining === null) return "no seat limit";
  if (call.seats_remaining <= 0) return "full";
  return `${call.seats_remaining} seat${call.seats_remaining === 1 ? "" : "s"} left`;
}

/**
 * The all-time record, pre-formatted. An unscored seller keeps its row: absence
 * of a score is a fact about a new agent, not grounds for hiding the listing.
 */
export function toTrackRecordView(track: WireMarketplaceTrackRecord): TrackRecordView {
  const unscored = track.resolved_calls === 0 && track.verdict_score_lb === null;
  const winRate = track.win_rate === null ? UNLISTED : `${Math.round(track.win_rate * 100)}%`;
  return {
    scopeLabel: "all-time",
    floor: formatScore(track.verdict_score_lb),
    floorValue: track.verdict_score_lb,
    winRate,
    resolved: String(track.resolved_calls),
    rank: track.rank,
    tier: track.tier,
    unscored,
    marketplaceEligible: track.marketplace_eligible,
    summary: unscored
      ? "all-time record across every series: no calls have resolved yet, so this agent is unscored."
      : `all-time record across every series (not per series): floor ${formatScore(
          track.verdict_score_lb,
        )}, win rate ${winRate}, ${track.resolved_calls} scored calls.`,
  };
}

/* ── What the page says when there is nothing to compare ──────────────────── */

/**
 * The matrix-level empty state, or null when there IS something to draw.
 *
 * A catalog with series but no sellers is not an error and not an empty page:
 * the columns still render, so this only speaks when there is no grid at all.
 */
export function matrixEmptyState(matrix: ListingsMatrix): string | null {
  if (matrix.columns.length === 0) {
    return "no venue series are registered on this deployment yet, so there is nothing to list.";
  }
  if (matrix.rows.length === 0) {
    return "no agent has published a standing price yet. Owners set one per series on their agent's pricing tab.";
  }
  if (matrix.totalListings === 0) {
    return "every listed agent has since withdrawn its prices. Nothing is on standing offer right now.";
  }
  return null;
}

export interface AvailabilityLine {
  tone: "dim" | "error";
  text: string;
}

/**
 * One quiet line under the matrix, naming which of four situations we are in.
 *
 * `checkout_unavailable` dominates an empty call list, mirroring the daemon's
 * own precedence on `inventory_status`: when nothing can be bought at all, the
 * reason a buyer needs is the missing checkout, not the seat count. In EVERY
 * branch the matrix above stays fully drawn — availability annotates standing
 * prices, it never gates them.
 */
export function availabilityLine(
  feed: AvailabilityFeed,
  matrix: ListingsMatrix,
): AvailabilityLine {
  if (feed.status === "loading") {
    return { tone: "dim", text: "checking which sealed calls are open to buy…" };
  }
  if (feed.status === "error") {
    return {
      tone: "error",
      text: `availability could not be checked (${feed.message}). The standing prices below are unaffected.`,
    };
  }
  if (!feed.purchaseAvailable) {
    return {
      tone: "dim",
      text: "checkout unavailable on this deployment. Standing prices are shown for reference; nothing can be bought here.",
    };
  }
  if (matrix.totalOpenCalls === 0) {
    return {
      tone: "dim",
      text: "no calls open to buy right now. Standing prices apply when each agent seals its next call.",
    };
  }
  // A sealed call is not the same fact as a seat on offer: a full cohort, a
  // deployment without checkout and a closed sale window all still show a call.
  const buyable = matrix.totalBuyableCalls;
  const closed = matrix.totalOpenCalls - buyable;
  if (buyable === 0) {
    return {
      tone: "dim",
      text: `${matrix.totalOpenCalls} sealed call${matrix.totalOpenCalls === 1 ? " is" : "s are"} listed. None takes a new buyer right now.`,
    };
  }
  const closedClause =
    closed > 0
      ? ` ${closed} more ${closed === 1 ? "is" : "are"} listed but closed to new buyers.`
      : "";
  return {
    tone: "dim",
    text: `${buyable} sealed call${buyable === 1 ? "" : "s"} open to buy. Each is sold at the price locked when it was sealed, not at the standing price.${closedClause}`,
  };
}


/* ── Filters ──────────────────────────────────────────────────────────────── */

/**
 * Browsing controls for the matrix. Applied to the BUILT matrix, never to the
 * fetch: both feeds are one page each, so filtering is a view concern and the
 * unfiltered matrix stays available to describe the deployment as a whole.
 */
export const LISTINGS_SORTS = ["name", "price", "record"] as const;
export type ListingsSort = (typeof LISTINGS_SORTS)[number];
export type SortDirection = "asc" | "desc";

/**
 * Which way each key runs when it is first picked.
 *
 * The useful end of a key is not always ascending: cheapest first is what a
 * buyer wants from `price`, but `record` ascending would open on the worst
 * sellers murmur has. Picking a key jumps to its useful end; clicking it again
 * flips.
 */
export const DEFAULT_SORT_DIRECTION: Record<ListingsSort, SortDirection> = {
  name: "asc",
  price: "asc",
  record: "desc",
};

/** What each direction MEANS per key, for the control's own label. */
export const SORT_DIRECTION_LABEL: Record<ListingsSort, Record<SortDirection, string>> = {
  name: { asc: "A to Z", desc: "Z to A" },
  price: { asc: "cheapest first", desc: "dearest first" },
  record: { asc: "lowest floor first", desc: "highest floor first" },
};

export interface ListingsFilters {
  /** Substring of the handle or the display name. Empty keeps every seller. */
  agent: string;
  /** One series, or null for every series. */
  venueSeriesId: string | null;
  sort: ListingsSort;
  direction: SortDirection;
  /** Drop columns nobody lists. On by default: a screen of em dashes is noise. */
  hideEmptySeries: boolean;
}

export const DEFAULT_LISTINGS_FILTERS: ListingsFilters = {
  agent: "",
  venueSeriesId: null,
  sort: "name",
  direction: DEFAULT_SORT_DIRECTION.name,
  hideEmptySeries: true,
};

/** True when anything is narrowing the view, so the UI can offer a reset. */
export function filtersActive(filters: ListingsFilters): boolean {
  return (
    filters.agent.trim() !== "" ||
    filters.venueSeriesId !== null ||
    filters.sort !== DEFAULT_LISTINGS_FILTERS.sort ||
    filters.direction !== DEFAULT_SORT_DIRECTION[filters.sort] ||
    filters.hideEmptySeries !== DEFAULT_LISTINGS_FILTERS.hideEmptySeries
  );
}

/**
 * Narrow and reorder a built matrix.
 *
 * Columns go first, then rows are dropped when the columns that survive hold
 * nothing for them — filtering to one series and leaving behind a page of
 * sellers who do not list it is not a result. The counts are recomputed over
 * what is left, so the panel header describes the rows on screen; the
 * availability line keeps reading the UNFILTERED matrix, because it describes
 * the deployment rather than the current query.
 */
export function filterListingsMatrix(
  matrix: ListingsMatrix,
  filters: ListingsFilters,
): ListingsMatrix {
  const term = filters.agent.trim().toLowerCase();
  const keep = matrix.columns.map((column) =>
    filters.venueSeriesId !== null
      ? column.venueSeriesId === filters.venueSeriesId
      : !(filters.hideEmptySeries && column.sellers === 0),
  );
  const columns = matrix.columns.filter((_, i) => keep[i]);

  let totalListings = 0;
  let totalOpenCalls = 0;
  let totalBuyableCalls = 0;

  const rows: MatrixRow[] = [];
  for (const row of matrix.rows) {
    if (term && !`${row.slug} ${row.displayName}`.toLowerCase().includes(term)) continue;
    const cells = row.cells.filter((_, i) => keep[i]);
    const listedCount = cells.filter((c) => c.listPrice !== null).length;
    const openCallCount = cells.reduce((n, c) => n + c.openCalls.length, 0);
    if (listedCount === 0 && openCallCount === 0) continue;
    totalListings += listedCount;
    totalOpenCalls += openCallCount;
    totalBuyableCalls += cells.reduce(
      (n, c) => n + c.openCalls.filter((call) => call.buyable).length,
      0,
    );
    rows.push({ ...row, cells, listedCount, openCallCount });
  }

  rows.sort(rowComparator(filters.sort, filters.direction));

  return {
    columns,
    rows,
    servedAt: matrix.servedAt,
    totalListings,
    totalOpenCalls,
    totalBuyableCalls,
  };
}

/**
 * Handle order is the tiebreak everywhere, so a sort is always stable to read.
 *
 * Direction flips the COMPARISON, never the missing values: a seller with no
 * price and a seller with no score sort last in both directions. Reversing a
 * board to see the dearest listings should not fill the top with sellers who
 * have no listing at all.
 */
function rowComparator(
  sort: ListingsSort,
  direction: SortDirection,
): (a: MatrixRow, b: MatrixRow) => number {
  const sign = direction === "desc" ? -1 : 1;
  const bySlug = (a: MatrixRow, b: MatrixRow) => a.slug.localeCompare(b.slug);
  if (sort === "price") {
    return (a, b) => {
      const pa = cheapestListing(a.cells);
      const pb = cheapestListing(b.cells);
      if (pa === null || pb === null) return pa === pb ? bySlug(a, b) : pa === null ? 1 : -1;
      if (pa === pb) return bySlug(a, b);
      return (pa < pb ? -1 : 1) * sign;
    };
  }
  if (sort === "record") {
    return (a, b) => {
      const fa = a.track.floorValue;
      const fb = b.track.floorValue;
      // Unscored is not a floor of zero: a new seller sorts below every scored one.
      if (fa === null || fb === null) return fa === fb ? bySlug(a, b) : fa === null ? 1 : -1;
      if (fa === fb) return bySlug(a, b);
      return (fa < fb ? -1 : 1) * sign;
    };
  }
  return (a, b) => bySlug(a, b) * sign;
}

/**
 * The cheapest visible listing, on ONE scale.
 *
 * Atoms are per-asset, so comparing 6-decimal USDC against 18-decimal DAI raw
 * would rank every DAI price as astronomically dearer. Everything is lifted to
 * 18 decimals before the comparison; an unknown asset has no known scale and
 * sorts last rather than being guessed at.
 */
function cheapestListing(cells: readonly MatrixCell[]): bigint | null {
  let min: bigint | null = null;
  for (const cell of cells) {
    if (!cell.listPrice) continue;
    const decimals = decimalsFor(cell.listPrice.currency);
    if (decimals === null || decimals > SORT_DECIMALS) continue;
    let value: bigint;
    try {
      value = BigInt(cell.listPrice.priceAtoms) * 10n ** BigInt(SORT_DECIMALS - decimals);
    } catch {
      continue;
    }
    if (min === null || value < min) min = value;
  }
  return min;
}

/** Wide enough for every settlement asset murmur knows (DAI and ETH are 18). */
const SORT_DECIMALS = 18;

/** What the matrix says when the filters, not the deployment, emptied it. */
export function filteredEmptyState(
  matrix: ListingsMatrix,
  shown: ListingsMatrix,
  filters: ListingsFilters,
): string | null {
  if (shown.rows.length > 0 || matrix.rows.length === 0) return null;
  const term = filters.agent.trim();
  if (term && filters.venueSeriesId) {
    return `no seller matching "${term}" lists this market.`;
  }
  if (term) return `no seller matches "${term}".`;
  if (filters.venueSeriesId) return "nobody lists this market yet.";
  return "no seller matches these filters.";
}

/* ── Layout ───────────────────────────────────────────────────────────────── */

/** Sticky row-header width, and the usable minimum every series column gets. */
export const ROW_HEAD_WIDTH_PX = 272;
export const SERIES_COL_MIN_PX = 176;

/**
 * The grid track list, computed rather than written inline.
 *
 * Columns are never squeezed to fit: each keeps `SERIES_COL_MIN_PX` and the
 * grid declares a `minWidth` wide enough for all of them, so a narrow viewport
 * scrolls sideways instead of crushing N columns into it. Cross-row comparison
 * is the entire point of a matrix, and wrapping or a card layout destroys it.
 * The `1fr` max lets columns share the slack when the viewport IS wide enough.
 */
export function matrixGridTemplate(columnCount: number): {
  gridTemplateColumns: string;
  minWidth: string;
} {
  const cols = Math.max(0, columnCount);
  return {
    gridTemplateColumns: `${ROW_HEAD_WIDTH_PX}px repeat(${cols}, minmax(${SERIES_COL_MIN_PX}px, 1fr))`,
    minWidth: `${ROW_HEAD_WIDTH_PX + cols * SERIES_COL_MIN_PX}px`,
  };
}
