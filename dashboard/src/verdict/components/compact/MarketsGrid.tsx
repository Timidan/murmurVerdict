import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchArchivedMarkets,
  fetchMarkets,
  type ArchivedMarketRow,
  type MarketRow,
} from "../../api.js";
import { useVenueStream } from "../../hooks/useVenueStream.js";
import type { WireVenueResolutionRow } from "@shared/wire-venue";
import { useSlashFocus } from "../../hooks/useSlashFocus.js";
import { buildRouteQueryUrl, readRouteQuery } from "../../route.js";
import {
  marketAssetSymbol,
  assetSymbolFromSlugOrQuestion,
  parseMarketConfig,
  marketGrouping,
  providerLabel,
  filterableMarket,
  type MarketGrouping,
} from "../../lib/market-meta.js";
import {
  ALL_CHECKED,
  filterMarkets,
  marketFilterFromQuery,
  marketFilterOptions,
  marketFilterToQuery,
  pruneFilterState,
  UNCATEGORISED,
  type MarketFilterState,
} from "../../lib/market-filters.js";
import { MarketFilterBar } from "./MarketFilterBar.js";
import {
  formatLocalDateTime,
  formatLocalTimeLabel,
} from "../../lib/date-time-format.js";
import {
  groupMarketsByWindow,
  marketWindowPhase,
  countdownOwnerKey,
  type MarketWindowGroup,
  startOfLocalDayEpochS,
  type MarketWindowPhase,
} from "../../lib/market-windows.js";
import { useDetailDrawer } from "./DetailDrawer.js";
import { ArchivedMarketLinkRow } from "./ArchivedMarketRow.js";
import { InlineError } from "./InlineError.js";
import { MarketAssetIcon } from "./MarketAssetIcon.js";
import { MarketsArchiveSearch } from "./MarketsArchiveSearch.js";
import {
  MarketWindowGroupPanel,
  PHASE_TEXT,
  windowPhaseText,
} from "./MarketWindowGroup.js";
import { SkeletonBar } from "./PanelSkeleton.js";

/**
 * The markets matrix.
 *
 * murmur's venue markets come in cohorts: five assets share one five-minute
 * window, settle together, and are replaced. The old grid rendered them as ten
 * independent rows with ten identical countdowns and a "10/10" counter — a
 * table of the data, not a picture of what is happening. This is the picture:
 * windows, each with one countdown and one phase, and the assets inside them.
 *
 * Three views, because "what is running", "what just settled" and "what
 * happened before" are three different questions with three different shapes:
 *
 *   live      the windows currently in flight (default)
 *   resolved  today's settled windows, newest first
 *   search    the whole archive, by text and by day
 *
 * The views are LINKS, not buttons — real `<a href>` carrying a `?mm=` query,
 * so cmd-click opens a view in a new tab, the address is shareable, and back
 * works. That also means no `role="tablist"` machinery: links already announce
 * themselves correctly, and `aria-current` states which one is active.
 */

type MatrixView = "live" | "resolved" | "search";

const VIEWS: readonly MatrixView[] = ["live", "resolved", "search"] as const;
const VIEW_PARAM = "mm";

export function CompactMarketsGrid({ limit }: { limit?: number }) {
  const [markets, setMarkets] = useState<MarketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolvedToday, setResolvedToday] = useState<{
    rows: ArchivedMarketRow[];
    hasMore: boolean;
  } | null>(null);
  const [view, setView] = useState<MatrixView>(() => readViewFromLocation());
  // The checkable tiers (venue → category → series → market), URL-backed so a
  // narrowed board is shareable and survives refresh. Toggles replaceState
  // rather than push: a chip is a refinement of this address, not a new one.
  const [filter, setFilter] = useState<MarketFilterState>(() =>
    readFilterFromLocation(),
  );
  const applyFilter = useCallback((next: MarketFilterState) => {
    setFilter(next);
    writeFilterToLocation(next);
  }, []);

  const { markets: venueMarkets, resolutions } = useVenueStream();
  const { open } = useDetailDrawer();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const nowMs = useSharedSecondTick();

  // "/" focuses the archive search — the terminal idiom the old grid had. It
  // only lands when the search view is mounted; switching views first would
  // hijack a keystroke the reader may not have meant as navigation.
  useSlashFocus(searchRef);

  // The URL is the source of truth for the view AND the filter tiers. A link
  // click updates it via pushState (no reload); Back/Forward and a pasted
  // address re-sync here.
  useEffect(() => {
    const sync = () => {
      setView(readViewFromLocation());
      setFilter(readFilterFromLocation());
    };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  // The registry is re-fetched on a cadence, not loaded once. New five-minute
  // windows register continuously; a one-shot fetch meant the live board only
  // learned about them on a full page reload (review finding #2). Sixty
  // seconds matches the discovery tick, and a venue frame that mentions a
  // market this list has never seen triggers an immediate refresh — that is
  // the earliest possible signal a new window exists.
  const marketsRef = useRef<MarketRow[]>([]);
  const registryFetchInFlight = useRef(false);
  const refreshRegistry = useCallback(async (): Promise<void> => {
    if (registryFetchInFlight.current) return;
    registryFetchInFlight.current = true;
    try {
      const rows = await fetchMarkets({ status: "listed" });
      marketsRef.current = rows;
      setMarkets(rows);
      setError(null);
    } finally {
      registryFetchInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    let cancel = false;
    setError(null);

    const initial = async (): Promise<void> => {
      try {
        await refreshRegistry();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (cancel) return;
        try {
          await refreshRegistry();
        } catch (e) {
          // The raw ApiError reads "GET /v2/markets → 500". The board
          // already retries every minute; say that instead.
          if (!cancel) {
            setError("the markets board did not load. murmur retries every minute.");
          }
        }
      }
    };
    void initial();

    const interval = window.setInterval(() => {
      // A background refresh that fails keeps the board on its last good
      // rows; the next tick tries again.
      void refreshRegistry().catch(() => {});
    }, 60_000);
    return () => {
      cancel = true;
      window.clearInterval(interval);
    };
  }, [refreshRegistry]);

  // A market the venue stream knows but the registry list does not = a window
  // registered since the last fetch. Refresh now rather than in up to 60s.
  useEffect(() => {
    const known = new Set(marketsRef.current.map((m) => m.market_id));
    const unknown = Object.keys(venueMarkets).some((id) => !known.has(id));
    if (unknown && marketsRef.current.length > 0) {
      void refreshRegistry().catch(() => {});
    }
  }, [venueMarkets, refreshRegistry]);

  // Today's settled windows. Fetched on mount rather than on tab open because
  // the header count states it ("10 taking calls · 23 resolved today") — a
  // number the reader sees before choosing a view.
  const loadResolvedToday = useCallback(async (): Promise<void> => {
    const page = await fetchArchivedMarkets({
      from: startOfLocalDayEpochS(Date.now()),
      limit: 50,
    });
    setResolvedToday({ rows: page.results, hasMore: page.has_more });
  }, []);

  // Re-read when the SET of settled markets changes, or when the reader's own
  // day rolls over. Keying on the count alone missed both: midnight keeps the
  // count, and a replacement (one market evicted as another settles) does too,
  // so the board sat on yesterday's results.
  const resolutionSignature = Object.keys(resolutions).sort().join(",");
  const localDayStartS = startOfLocalDayEpochS(nowMs);
  useEffect(() => {
    // The archive is a secondary surface; a failure here must not take the
    // live board down with it, and it must not drop rows already on screen.
    // Before the first success the state is null, which renders its own
    // "unavailable" line and leaves the header count off.
    loadResolvedToday().catch(() => undefined);
  }, [loadResolvedToday, resolutionSignature, localDayStartS]);

  const liveMarkets = useMemo(() => markets ?? [], [markets]);

  // What the header states. "live" counted every LISTED row — upcoming and
  // closed windows included — and read 0 before the registry landed. This is
  // the markets whose window is taking calls right now, and null until the
  // registry answers.
  const takingCalls = useMemo(
    () =>
      markets === null
        ? null
        : markets.filter(
            (m) => m.clock && marketWindowPhase(m.clock, nowMs, false) === "open",
          ).length,
    [markets, nowMs],
  );

  // ── Filter tiers ──────────────────────────────────────────────────────────
  // Each live row flattened to its tier coordinates once; the bar, the board
  // and the URL all read the same projection.
  const projected = useMemo(
    () => liveMarkets.map((m) => ({ market: m, coords: filterableMarket(m) })),
    [liveMarkets],
  );
  const filterRows = useMemo(() => projected.map((p) => p.coords), [projected]);
  // Ghost selections (a checked market whose windows all retired) prune at
  // derivation rather than in an effect, so the board and the bar can never
  // disagree for a frame.
  const effectiveFilter = useMemo(
    () => pruneFilterState(filter, marketFilterOptions(filterRows, filter)),
    [filterRows, filter],
  );
  const visibleMarkets = useMemo(() => {
    const survivors = new Set(filterMarkets(filterRows, effectiveFilter));
    return projected.filter((p) => survivors.has(p.coords)).map((p) => p.market);
  }, [projected, filterRows, effectiveFilter]);

  // Market-tier chip artwork. Only symbol-labelled leaves carry a glyph, so
  // membership doubles as "this leaf is an asset" for the symbol narrowing
  // the archive surfaces need.
  const iconByMarketKey = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const p of projected) {
      if (marketAssetSymbol(p.market) === null) continue;
      if (!map.get(p.coords.marketKey)) {
        map.set(p.coords.marketKey, parseMarketConfig(p.market)?.icon_url ?? null);
      }
    }
    return map;
  }, [projected]);

  // ── Hierarchy: provider → category buckets ────────────────────────────────
  // Live rows normalize client-side (adapter_id + config); archived rows
  // arrive pre-normalized from the server. Same shape, so both boards group
  // identically. Built from the FILTERED rows: the grid mirrors the bar.
  const liveBuckets = useMemo(() => {
    const map = new Map<string, { key: string; grouping: MarketGrouping; markets: MarketRow[] }>();
    for (const m of visibleMarkets) {
      const g = marketGrouping(m);
      const key = `${g.provider_key}//${g.category_label ?? "uncategorized"}`;
      const bucket = map.get(key);
      if (bucket) bucket.markets.push(m);
      else map.set(key, { key, grouping: g, markets: [m] });
    }
    return [...map.values()];
  }, [visibleMarkets]);

  const resolvedBuckets = useMemo(() => {
    const rows = resolvedToday?.rows ?? [];
    const map = new Map<string, { key: string; grouping: MarketGrouping; rows: ArchivedMarketRow[] }>();
    for (const row of rows) {
      const providerKey = row.provider ?? "unknown";
      const key = `${providerKey}//${row.category_label ?? "uncategorized"}`;
      const bucket = map.get(key);
      if (bucket) bucket.rows.push(row);
      else
        map.set(key, {
          key,
          grouping: {
            provider_key: providerKey,
            provider_label: providerLabel(providerKey),
            category_label: row.category_label ?? null,
          },
          rows: [row],
        });
    }
    return [...map.values()];
  }, [resolvedToday]);

  // Resolved buckets narrowed by the venue + category tiers. Those two map
  // 1:1 onto archived rows; the market tier narrows by symbol further down,
  // and series has no archived counterpart to filter on.
  const resolvedVisibleBuckets = useMemo(
    () =>
      resolvedBuckets.filter(
        (b) =>
          (effectiveFilter.venues === null ||
            effectiveFilter.venues.has(b.grouping.provider_key)) &&
          (effectiveFilter.categories === null ||
            effectiveFilter.categories.has(
              b.grouping.category_label ?? UNCATEGORISED,
            )),
      ),
    [resolvedBuckets, effectiveFilter],
  );

  const bucketWindows = useMemo(() => {
    const out = new Map<
      string,
      { groups: MarketWindowGroup<MarketRow>[]; unscheduled: MarketRow[] }
    >();
    for (const bucket of liveBuckets) {
      // Bucket rows already passed the tiers; grouping is all that is left.
      const { groups, unscheduled } = groupMarketsByWindow(
        bucket.markets,
        (m) => m.clock ?? null,
        "soonest",
      );
      out.set(bucket.key, {
        groups: limit ? groups.slice(0, limit) : groups,
        unscheduled,
      });
    }
    return out;
  }, [liveBuckets, limit]);

  // Flat view of every bucket's visible windows — the phase announcement and
  // empty-state logic care about totals, not the hierarchy.
  const visibleGroups = useMemo(
    () => [...bucketWindows.values()].flatMap((w) => w.groups),
    [bucketWindows],
  );
  const unscheduled = useMemo(
    () => [...bucketWindows.values()].flatMap((w) => w.unscheduled),
    [bucketWindows],
  );

  // Archive surfaces (resolved rows, search) narrow by asset SYMBOL — the one
  // coordinate an archived row still carries. Checked symbol-labelled leaves
  // translate directly; a checked question-market has no archived analogue and
  // contributes nothing.
  const symbolFilter = useMemo((): ReadonlySet<string> | null => {
    if (effectiveFilter.markets === null) return null;
    // The reader emptied the tier; the archive stays empty with it.
    if (effectiveFilter.markets.size === 0) return new Set<string>();
    const labelByKey = new Map(filterRows.map((f) => [f.marketKey, f.marketLabel]));
    const symbols = new Set<string>();
    for (const key of effectiveFilter.markets) {
      if (!iconByMarketKey.has(key)) continue;
      const label = labelByKey.get(key);
      if (label) symbols.add(label);
    }
    return symbols.size > 0 ? symbols : null;
  }, [effectiveFilter, filterRows, iconByMarketKey]);

  // A window may only be pulled to `resolved` EARLY when every market in it
  // carries a venue outcome. One resolution used to speak for the cohort,
  // which declared four windows settled on the evidence of a fifth.
  const phaseOf = useCallback(
    (group: { resolutionAtMs: number; items: MarketRow[] }): MarketWindowPhase => {
      const allResolved = group.items.every(
        (m) => resolutions[m.market_id] !== undefined,
      );
      const clock = group.items[0]?.clock;
      return marketWindowPhase(
        {
          submission_open_at_ms: clock?.submission_open_at_ms ?? 0,
          submission_close_at_ms: clock?.submission_close_at_ms ?? 0,
          resolution_at_ms: group.resolutionAtMs,
        },
        nowMs,
        allResolved,
      );
    },
    [nowMs, resolutions],
  );

  const announcement = usePhaseTransitionAnnouncement(
    visibleGroups.map((group) => ({
      key: group.key,
      label: formatLocalTimeLabel(group.submissionCloseAtMs) ?? group.key,
      // The same words the badge shows, so heard matches seen.
      text: windowPhaseText(
        phaseOf(group),
        group.items.every((m) => resolutions[m.market_id] !== undefined),
      ),
    })),
  );

  return (
    <div className="flex flex-col min-h-0">
      <MatrixHeader
        view={view}
        onPick={setView}
        takingCalls={takingCalls}
        resolvedToday={resolvedToday}
      />

      {/* ONE stable polite region for the whole matrix. It announces phase
          TRANSITIONS only — "1:25 window: submissions closed" — never the
          ticking countdown, which would speak once a second forever. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {/* The tiers govern live and resolved alike; search carries its own
          name + date controls and takes only the symbol narrowing. */}
      {view !== "search" && (
        <MarketFilterBar
          rows={filterRows}
          state={effectiveFilter}
          iconByMarketKey={iconByMarketKey}
          onChange={applyFilter}
        />
      )}

      {view === "search" ? (
        <MarketsArchiveSearch assetFilter={symbolFilter} inputRef={searchRef} />
      ) : view === "resolved" ? (
        resolvedVisibleBuckets.length === 0 ? (
          <ResolvedBoard page={resolvedToday} rows={[]} resolutions={resolutions} />
        ) : (
          <div>
            {groupBucketsByProvider(resolvedVisibleBuckets).map(
              ({ providerKey, providerName, buckets }, _i, providers) => (
                <section key={providerKey} aria-label={`Provider ${providerName}`}>
                  {providers.length > 1 && <ProviderHeader label={providerName} />}
                  {buckets.map((bucket) => (
                    <section
                      key={bucket.key}
                      aria-label={`Category ${bucket.grouping.category_label ?? UNCATEGORISED}`}
                    >
                      {buckets.length > 1 && (
                        <CategoryHeader
                          label={bucket.grouping.category_label ?? UNCATEGORISED}
                        />
                      )}
                      <ResolvedBoard
                        page={resolvedToday}
                        rows={filterArchivedRows(bucket.rows, symbolFilter)}
                        resolutions={resolutions}
                      />
                    </section>
                  ))}
                </section>
              ),
            )}
          </div>
        )
      ) : error ? (
        <InlineError error={error} className="px-2 py-2 ck-mono" />
      ) : markets === null ? (
        <MarketsSkeleton />
      ) : visibleGroups.length === 0 && unscheduled.length === 0 ? (
        <EmptyLive
          hasMarkets={liveMarkets.length > 0}
          onClear={() => applyFilter(ALL_CHECKED)}
        />
      ) : (
        <div>
          {/* The grid mirrors the bar: a venue header when more than one venue
              is showing, a category header when the venue's categories branch.
              The same branch test drives both, so they can never disagree. */}
          {groupBucketsByProvider(liveBuckets).map(
            ({ providerKey, providerName, buckets }, _i, providers) => (
              <section key={providerKey} aria-label={`Provider ${providerName}`}>
                {providers.length > 1 && <ProviderHeader label={providerName} />}
                {buckets.map((bucket) => (
                  <section
                    key={bucket.key}
                    aria-label={`Category ${bucket.grouping.category_label ?? UNCATEGORISED}`}
                  >
                    {buckets.length > 1 && (
                      <CategoryHeader
                        label={bucket.grouping.category_label ?? UNCATEGORISED}
                      />
                    )}
                    {(() => {
                      const groups = bucketWindows.get(bucket.key)?.groups ?? [];
                      const clockKey = countdownOwnerKey(groups, phaseOf);
                      return groups.map((group) => (
                        <MarketWindowGroupPanel
                          key={group.key}
                          group={group}
                          phase={phaseOf(group)}
                          nowMs={nowMs}
                          showCountdown={group.key === clockKey}
                          venueMarkets={venueMarkets}
                          venueResolutions={resolutions}
                          onOpenMarket={(marketId) => open("market", marketId)}
                        />
                      ));
                    })()}
                  </section>
                ))}
              </section>
            ),
          )}
          {unscheduled.length > 0 && (
            <section
              aria-label="Markets that have no window yet"
              className="border-b border-[var(--color-border)]"
            >
              <header className="px-2 py-1 bg-[var(--color-surface)]">
                <h3 className="ck-mono ck-dim m-0">no window yet</h3>
              </header>
              <ul className="m-0 p-0 list-none">
                {unscheduled.map((market) => (
                  <li
                    key={market.market_id}
                    className="border-b border-[var(--color-border)] last:border-b-0"
                  >
                    <a
                      href={`#/markets/${encodeURIComponent(market.market_id)}`}
                      className="flex items-center gap-2 min-h-[40px] px-2 py-1 no-underline text-[var(--color-primary)] ck-hoverable"
                    >
                      <MarketAssetIcon
                        iconUrl={parseMarketConfig(market)?.icon_url}
                        symbol={marketAssetSymbol(market)}
                      />
                      <span className="ck-mono truncate min-w-0 flex-1">
                        {parseMarketConfig(market)?.question ?? market.market_id}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Header: views + the count, in words ────────────────────────────────────

function MatrixHeader({
  view,
  onPick,
  takingCalls,
  resolvedToday,
}: {
  view: MatrixView;
  onPick: (view: MatrixView) => void;
  /** null until the registry has answered — a count of 0 would be a claim. */
  takingCalls: number | null;
  resolvedToday: { rows: ArchivedMarketRow[]; hasMore: boolean } | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-1 border-b border-[var(--color-border)]">
      <nav aria-label="Markets view" className="flex items-center">
        {VIEWS.map((option) => (
          <a
            key={option}
            href={viewHref(option)}
            aria-current={option === view ? "true" : undefined}
            onClick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
                return; // let the browser open a new tab / window
              }
              e.preventDefault();
              // pushState, not a hash assignment: it updates the address and
              // the history entry without a reload, and Back still works
              // (the popstate listener above re-syncs).
              window.history.pushState(null, "", viewHref(option));
              onPick(option);
            }}
            className={
              "ck-mono min-h-[40px] max-lg:min-h-[44px] inline-flex items-center px-3 no-underline " +
              "border border-[var(--color-border)] -ml-px first:ml-0 " +
              "focus-visible:outline-offset-[-2px] motion-safe:transition-colors " +
              (option === view
                ? "ck-pos bg-[var(--color-raised)] border-[var(--color-border-vis)]"
                : "ck-dim hover:text-[var(--color-display)]")
            }
          >
            {option}
          </a>
        ))}
      </nav>
      {/* Words, not "10/10". A ratio of two numbers nobody named is a puzzle;
          this states what is on the board. */}
      <p className="ml-auto ck-mono ck-dim m-0">
        {takingCalls ?? "—"} taking calls
        {resolvedToday !== null && (
          <>
            {" · "}
            {resolvedToday.hasMore
              ? `${resolvedToday.rows.length}+ resolved today`
              : `${resolvedToday.rows.length} resolved today`}
          </>
        )}
      </p>
    </div>
  );
}

// ─── Resolved board ─────────────────────────────────────────────────────────

/**
 * Today's settled windows, newest first.
 *
 * Grouped by the instant they ended, which is the same cohort the live board
 * shows — the five assets that shared a window settle at the same moment, so
 * they stay together after the fact.
 *
 * These rows come from the archive endpoint, so the header states the END of
 * the window and not a range: an archived row carries the instant it ended,
 * and inventing a start from an assumed window length would be a guess
 * rendered as a fact.
 */
function ResolvedBoard({
  page,
  rows,
  resolutions,
}: {
  page: { rows: ArchivedMarketRow[]; hasMore: boolean } | null;
  /** Pre-filtered by the caller's (provider, category, chips) scope. */
  rows: ArchivedMarketRow[];
  resolutions: Record<string, WireVenueResolutionRow>;
}) {
  if (page === null) {
    return (
      <p className="px-2 py-2 ck-mono ck-dim">
        [resolved markets are unavailable right now]
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="px-2 py-2 ck-mono ck-dim">
        {page.rows.length > 0
          ? "[no resolved markets match your filters]"
          : "[nothing has resolved today yet]"}
      </p>
    );
  }

  // Group by the shared end instant. `rows` already arrive newest-first from
  // the endpoint, so insertion order IS the display order.
  const byInstant = new Map<string, ArchivedMarketRow[]>();
  for (const row of rows) {
    const bucket = byInstant.get(row.ended_at);
    if (bucket) bucket.push(row);
    else byInstant.set(row.ended_at, [row]);
  }

  return (
    <div>
      {[...byInstant.entries()].map(([endedAt, bucket]) => (
        <details
          key={endedAt}
          aria-label={`Resolved ${formatLocalTimeLabel(endedAt) ?? endedAt}`}
          className="border-b border-[var(--color-border-vis)]"
        >
          {/* Collapsed by default: a settled window is history, so the board
              opens as a scannable index of windows rather than 50 rows. */}
          <summary className="mmr-window-summary flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 bg-[var(--color-surface)]">
            <h3 className="ck-mono ck-pos font-bold m-0">
              <time
                dateTime={endedAt}
                title={formatLocalDateTime(endedAt) ?? undefined}
              >
                {formatLocalTimeLabel(endedAt) ?? endedAt}
              </time>
            </h3>
            <span className="ck-badge ck-dim">{PHASE_TEXT.resolved}</span>
            <span className="ck-mono ck-dim">
              {bucket.length} {bucket.length === 1 ? "market" : "markets"}
            </span>
            <span className="mmr-disclosure-marker ml-auto" aria-hidden="true" />
          </summary>
          <ul className="m-0 p-0 list-none">
            {bucket.map((row) => (
              <ArchivedMarketLinkRow
                key={row.market_id}
                row={row}
                resolution={resolutions[row.market_id]}
                showEndedTime={false}
              />
            ))}
          </ul>
        </details>
      ))}
      {page.hasMore && (
        <p className="px-2 py-2 ck-mono ck-dim m-0">
          Showing the most recent 50. Use search for the rest.
        </p>
      )}
    </div>
  );
}

// ─── Empty + skeleton ───────────────────────────────────────────────────────

function EmptyLive({
  hasMarkets,
  onClear,
}: {
  hasMarkets: boolean;
  onClear: () => void;
}) {
  return (
    <div className="px-2 py-2 flex flex-wrap items-center gap-2 ck-mono ck-dim">
      <span>
        {hasMarkets
          ? "[no live markets match your filters]"
          : "[no markets are open right now]"}
      </span>
      {hasMarkets && (
        <button
          type="button"
          onClick={onClear}
          className="ck-btn ck-btn-bracket min-h-[40px]"
        >
          clear filters
        </button>
      )}
    </div>
  );
}

function MarketsSkeleton() {
  // Hairline skeleton matching the group shape — one header strip and its
  // rows — so nothing shifts when the real windows land. No spinner
  // (DESIGN.md §10).
  return (
    <div>
      <p role="status" className="sr-only">
        Loading markets.
      </p>
      <div aria-hidden="true">
      {[0, 1].map((group) => (
        <section key={group} className="border-b border-[var(--color-border-vis)]">
          <div className="flex items-center gap-3 px-2 py-1 bg-[var(--color-surface)] min-h-[28px]">
            <SkeletonBar className="h-[12px] w-[110px]" />
            <SkeletonBar className="h-[12px] w-[64px]" />
          </div>
          {[0, 1, 2, 3, 4].map((row) => (
            <div
              key={row}
              className="flex items-center gap-2 min-h-[40px] px-2 py-1 border-b border-[var(--color-border)]"
            >
              <SkeletonBar className="h-[16px] w-[16px]" />
              <SkeletonBar className="h-[12px] w-[44px]" />
              <SkeletonBar className="h-[12px] w-[96px] ml-auto" />
            </div>
          ))}
        </section>
      ))}
      </div>
    </div>
  );
}

// ─── Shared clock ───────────────────────────────────────────────────────────

/**
 * ONE interval for every countdown on the page.
 *
 * Each group needs a per-second re-render, and a timer per group means N
 * timers drifting apart — two windows counting the same second differently is
 * the kind of detail that makes a board look broken. One interval at the top,
 * one `nowMs` passed down.
 *
 * Aligned to the wall clock (it re-arms on the next whole second) so the
 * displayed seconds change when the reader's own clock does, not 400ms after.
 */
function useSharedSecondTick(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const now = Date.now();
      timer = setTimeout(() => {
        setNowMs(Date.now());
        schedule();
      }, 1000 - (now % 1000));
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return nowMs;
}

// ─── Phase transitions ──────────────────────────────────────────────────────

/**
 * Announce phase CHANGES, never phase state.
 *
 * The countdown re-renders every second and carries no live region; this does
 * the speaking, and only when something actually happened — "1:25 window:
 * sealed". The first render seeds the map silently, so mounting the page does
 * not read the whole board aloud.
 */
function usePhaseTransitionAnnouncement(
  groups: Array<{ key: string; label: string; text: string }>,
): string {
  const latest = useRef(groups);
  latest.current = groups;
  // The array is rebuilt every tick, so it cannot be the dependency — the
  // effect would run once a second forever. The SIGNATURE only changes when a
  // group appears, disappears, or moves phase, which is exactly the trigger.
  const signature = groups.map((g) => `${g.key}:${g.text}`).join("|");
  const previous = useRef<Map<string, string> | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const current = latest.current;
    const next = new Map(current.map((g) => [g.key, g.text]));
    const before = previous.current;
    previous.current = next;
    if (before === null) return; // seed pass — mounting says nothing
    const changed = current.filter(
      (g) => before.has(g.key) && before.get(g.key) !== g.text,
    );
    if (changed.length === 0) return;
    setAnnouncement(
      changed.map((g) => `${g.label} window: ${g.text}`).join(". "),
    );
  }, [signature]);

  return announcement;
}

// ─── View param ─────────────────────────────────────────────────────────────

function readViewFromLocation(): MatrixView {
  const raw = readRouteQuery(window.location).get(VIEW_PARAM);
  return VIEWS.includes(raw as MatrixView) ? (raw as MatrixView) : "live";
}

// ─── Filter params ──────────────────────────────────────────────────────────

const FILTER_PARAMS = ["venue", "category", "series", "markets"] as const;

function readFilterFromLocation(): MarketFilterState {
  const params = readRouteQuery(window.location);
  return marketFilterFromQuery((key) => params.get(key));
}

/** replaceState, not push: a chip refines this address, it is not a new one. */
function writeFilterToLocation(state: MarketFilterState): void {
  const params = readRouteQuery(window.location);
  for (const param of FILTER_PARAMS) params.delete(param);
  for (const [param, value] of Object.entries(marketFilterToQuery(state))) {
    params.set(param, value);
  }
  window.history.replaceState(null, "", buildRouteQueryUrl(window.location, params));
}

/**
 * A real URL for a view, in whichever routing mode is live (hash or path).
 * `live` drops the param rather than spelling out the default, so the plain
 * address and the default view are the same address.
 */
function viewHref(view: MatrixView): string {
  const params = readRouteQuery(window.location);
  if (view === "live") params.delete(VIEW_PARAM);
  else params.set(VIEW_PARAM, view);
  return buildRouteQueryUrl(window.location, params);
}

// ─── Hierarchy sections ─────────────────────────────────────────────────────

interface ProviderGroup<B extends { grouping: MarketGrouping }> {
  providerKey: string;
  providerName: string;
  buckets: B[];
}

/** Stable provider-ordered view of category buckets. */
function groupBucketsByProvider<B extends { grouping: MarketGrouping }>(
  buckets: B[],
): ProviderGroup<B>[] {
  const map = new Map<string, ProviderGroup<B>>();
  for (const bucket of buckets) {
    const key = bucket.grouping.provider_key;
    const group = map.get(key);
    if (group) group.buckets.push(bucket);
    else
      map.set(key, {
        providerKey: key,
        providerName: bucket.grouping.provider_label,
        buckets: [bucket],
      });
  }
  return [...map.values()];
}

/** Provider tier — the venue the markets live on. Rendered only when more
 *  than one venue is showing; the filter bar names the venue otherwise. */
function ProviderHeader({ label }: { label: string }) {
  return (
    <header className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--color-border-vis)] bg-[var(--color-surface)]">
      <h3 className="ck-mono ck-pos font-bold m-0">{label}</h3>
    </header>
  );
}

/** Category tier — the venue's own top-level tag, or "uncategorised". Never
 *  murmur's taxonomy class: that names settlement, not subject. Rendered only
 *  when the venue's categories branch, mirroring the filter bar. */
function CategoryHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-x-3 px-2 py-1 border-b border-[var(--color-border)]">
      <h4 className="ck-mono m-0 lowercase text-[var(--color-primary)]">{label}</h4>
    </div>
  );
}

/** Archived rows narrowed by the market tier's checked symbols. */
function filterArchivedRows(
  rows: ArchivedMarketRow[],
  selection: ReadonlySet<string> | null,
): ArchivedMarketRow[] {
  if (selection === null) return rows;
  return rows.filter((row) => {
    const symbol = assetSymbolFromSlugOrQuestion(row.slug, row.question);
    return symbol !== null && selection.has(symbol);
  });
}
