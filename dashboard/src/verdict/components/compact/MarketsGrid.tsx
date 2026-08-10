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
} from "../../lib/market-meta.js";
import {
  formatLocalDateTime,
  formatLocalTimeLabel,
} from "../../lib/date-time-format.js";
import {
  groupMarketsByWindow,
  marketWindowPhase,
  startOfLocalDayEpochS,
  type MarketWindowPhase,
} from "../../lib/market-windows.js";
import { useDetailDrawer } from "./DetailDrawer.js";
import { ArchivedMarketLinkRow } from "./ArchivedMarketRow.js";
import { InlineError } from "./InlineError.js";
import { MarketAssetIcon } from "./MarketAssetIcon.js";
import { MarketsArchiveSearch } from "./MarketsArchiveSearch.js";
import { MarketWindowGroupPanel, PHASE_TEXT } from "./MarketWindowGroup.js";
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
  const [assets, setAssets] = useState<ReadonlySet<string> | null>(null);

  const { markets: venueMarkets, resolutions } = useVenueStream();
  const { open } = useDetailDrawer();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const nowMs = useSharedSecondTick();

  // "/" focuses the archive search — the terminal idiom the old grid had. It
  // only lands when the search view is mounted; switching views first would
  // hijack a keystroke the reader may not have meant as navigation.
  useSlashFocus(searchRef);

  // The URL is the source of truth for the view. A link click updates it via
  // pushState (no reload); Back/Forward and a pasted address re-sync here.
  useEffect(() => {
    const sync = () => setView(readViewFromLocation());
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  useEffect(() => {
    let cancel = false;
    setError(null);

    const fetchOnce = async (): Promise<MarketRow[]> => {
      try {
        return await fetchMarkets({ status: "listed" });
      } catch (firstErr) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (cancel) throw firstErr;
        return await fetchMarkets({ status: "listed" });
      }
    };

    fetchOnce()
      .then((rows) => {
        if (!cancel) setMarkets(rows);
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, []);

  // Today's settled windows. Fetched on mount rather than on tab open because
  // the header count states it ("10 live · 23 resolved today") — a number the
  // reader sees before choosing a view.
  const loadResolvedToday = useCallback(async (): Promise<void> => {
    const page = await fetchArchivedMarkets({
      from: startOfLocalDayEpochS(Date.now()),
      limit: 50,
    });
    setResolvedToday({ rows: page.results, hasMore: page.has_more });
  }, []);

  useEffect(() => {
    let cancel = false;
    loadResolvedToday().catch(() => {
      // The archive is a secondary surface; a failure here must not take the
      // live board down with it. The resolved view renders its own empty
      // state and the header simply omits the count.
      if (!cancel) setResolvedToday(null);
    });
    return () => {
      cancel = true;
    };
  }, [loadResolvedToday]);

  // Refresh the resolved list when a window we are watching settles, so the
  // board does not need a manual reload to show what just happened.
  const resolutionCount = Object.keys(resolutions).length;
  useEffect(() => {
    if (resolutionCount === 0) return;
    loadResolvedToday().catch(() => undefined);
  }, [resolutionCount, loadResolvedToday]);

  const liveMarkets = useMemo(() => markets ?? [], [markets]);

  // The chip set is DERIVED from the markets on screen, never a hardcoded list
  // of five tickers. The venue decides which assets it runs; a constant here
  // would quietly drop a sixth the day one appears, and show five dead chips
  // the day one is retired.
  const assetOptions = useMemo(
    () => deriveAssetOptions(liveMarkets, resolvedToday?.rows ?? []),
    [liveMarkets, resolvedToday],
  );

  const filteredLive = useMemo(
    () =>
      assets === null
        ? liveMarkets
        : liveMarkets.filter((m) => {
            const symbol = marketAssetSymbol(m);
            return symbol !== null && assets.has(symbol);
          }),
    [liveMarkets, assets],
  );

  const { groups, unscheduled } = useMemo(
    () =>
      groupMarketsByWindow(
        filteredLive,
        (m) => m.clock ?? null,
        "soonest",
      ),
    [filteredLive],
  );

  const visibleGroups = limit ? groups.slice(0, limit) : groups;

  // The whole cohort settles together, so ONE resolution in the group means
  // the window is over — the remaining four are moments behind it, and showing
  // four "sealed" rows beside one "resolved" would misdescribe a settled
  // window as still running.
  const phaseOf = useCallback(
    (group: { resolutionAtMs: number; items: MarketRow[] }): MarketWindowPhase => {
      const anyResolved = group.items.some(
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
        anyResolved,
      );
    },
    [nowMs, resolutions],
  );

  const announcement = usePhaseTransitionAnnouncement(
    visibleGroups.map((group) => ({
      key: group.key,
      label: formatLocalTimeLabel(group.submissionCloseAtMs) ?? group.key,
      phase: phaseOf(group),
    })),
  );

  return (
    <div className="flex flex-col min-h-0">
      <MatrixHeader
        view={view}
        onPick={setView}
        liveCount={liveMarkets.length}
        resolvedToday={resolvedToday}
      />

      <AssetFilterChips
        options={assetOptions}
        selected={assets}
        onToggle={(symbol) => setAssets((prev) => toggleAsset(prev, symbol, assetOptions))}
      />

      {/* ONE stable polite region for the whole matrix. It announces phase
          TRANSITIONS only — "1:25 window: submissions closed" — never the
          ticking countdown, which would speak once a second forever. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {view === "search" ? (
        <MarketsArchiveSearch assetFilter={assets} inputRef={searchRef} />
      ) : view === "resolved" ? (
        <ResolvedBoard
          page={resolvedToday}
          assets={assets}
          resolutions={resolutions}
        />
      ) : error ? (
        <InlineError error={error} className="px-2 py-2 ck-mono" />
      ) : markets === null ? (
        <MarketsSkeleton />
      ) : visibleGroups.length === 0 && unscheduled.length === 0 ? (
        <EmptyLive hasMarkets={liveMarkets.length > 0} onClear={() => setAssets(null)} />
      ) : (
        <div>
          {visibleGroups.map((group) => (
            <MarketWindowGroupPanel
              key={group.key}
              group={group}
              phase={phaseOf(group)}
              nowMs={nowMs}
              venueMarkets={venueMarkets}
              venueResolutions={resolutions}
              onOpenMarket={(marketId) => open("market", marketId)}
            />
          ))}
          {unscheduled.length > 0 && (
            <section
              aria-label="Markets with no window"
              className="border-b border-[var(--color-border)]"
            >
              <header className="px-2 py-1 bg-[var(--color-surface)]">
                <h3 className="ck-mono ck-dim m-0">no window bound</h3>
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
  liveCount,
  resolvedToday,
}: {
  view: MatrixView;
  onPick: (view: MatrixView) => void;
  liveCount: number;
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
              "ck-mono min-h-[40px] inline-flex items-center px-3 no-underline " +
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
        {liveCount} live
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

// ─── Asset filter ───────────────────────────────────────────────────────────

interface AssetOption {
  symbol: string;
  iconUrl: string | null;
}

/**
 * Toggle chips.
 *
 * `aria-pressed` because these are toggles, not navigation — the same control
 * in two states, which is exactly what the attribute is for. The pressed state
 * is FILLED vs outlined, not tinted: a colour-only distinction is invisible to
 * a large fraction of readers and disappears entirely in a high-contrast
 * theme.
 */
function AssetFilterChips({
  options,
  selected,
  onToggle,
}: {
  options: AssetOption[];
  selected: ReadonlySet<string> | null;
  onToggle: (symbol: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Filter by asset"
      className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b border-[var(--color-border)]"
    >
      {options.map((option) => {
        const pressed = selected === null || selected.has(option.symbol);
        return (
          <button
            key={option.symbol}
            type="button"
            aria-pressed={pressed}
            onClick={() => onToggle(option.symbol)}
            className={
              "ck-mono inline-flex items-center gap-1.5 min-h-[40px] px-2.5 " +
              "border cursor-pointer motion-safe:transition-colors " +
              (pressed
                ? "bg-[var(--color-display)] text-[var(--color-bg)] border-[var(--color-display)]"
                : "bg-transparent text-[var(--color-secondary)] border-[var(--color-border-vis)]")
            }
          >
            <MarketAssetIcon iconUrl={option.iconUrl} symbol={option.symbol} />
            {option.symbol}
          </button>
        );
      })}
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
  assets,
  resolutions,
}: {
  page: { rows: ArchivedMarketRow[]; hasMore: boolean } | null;
  assets: ReadonlySet<string> | null;
  resolutions: Record<string, WireVenueResolutionRow>;
}) {
  if (page === null) {
    return (
      <p className="px-2 py-2 ck-mono ck-dim">
        [resolved markets are unavailable right now]
      </p>
    );
  }
  const rows = assets === null
    ? page.rows
    : page.rows.filter((row) => {
        const symbol = assetSymbolFromSlugOrQuestion(row.slug, row.question);
        return symbol !== null && assets.has(symbol);
      });
  if (rows.length === 0) {
    return (
      <p className="px-2 py-2 ck-mono ck-dim">
        {page.rows.length > 0
          ? "[no resolved markets for the selected assets]"
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
        <section
          key={endedAt}
          aria-label={`Resolved ${formatLocalTimeLabel(endedAt) ?? endedAt}`}
          className="border-b border-[var(--color-border-vis)]"
        >
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 bg-[var(--color-surface)]">
            <h3 className="ck-mono ck-pos font-bold m-0">
              <time
                dateTime={endedAt}
                title={formatLocalDateTime(endedAt) ?? undefined}
              >
                {formatLocalTimeLabel(endedAt) ?? endedAt}
              </time>
            </h3>
            <span className="ck-badge ck-dim">{PHASE_TEXT.resolved}</span>
          </header>
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
        </section>
      ))}
      {page.hasMore && (
        <p className="px-2 py-2 ck-mono ck-dim m-0">
          showing the most recent 50 — use search for the rest
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
          ? "[no live markets for the selected assets]"
          : "[no markets listed]"}
      </span>
      {hasMarkets && (
        <button
          type="button"
          onClick={onClear}
          className="ck-btn ck-btn-bracket min-h-[40px]"
        >
          show all assets
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
  groups: Array<{ key: string; label: string; phase: MarketWindowPhase }>,
): string {
  const latest = useRef(groups);
  latest.current = groups;
  // The array is rebuilt every tick, so it cannot be the dependency — the
  // effect would run once a second forever. The SIGNATURE only changes when a
  // group appears, disappears, or moves phase, which is exactly the trigger.
  const signature = groups.map((g) => `${g.key}:${g.phase}`).join("|");
  const previous = useRef<Map<string, MarketWindowPhase> | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const current = latest.current;
    const next = new Map(current.map((g) => [g.key, g.phase]));
    const before = previous.current;
    previous.current = next;
    if (before === null) return; // seed pass — mounting says nothing
    const changed = current.filter(
      (g) => before.has(g.key) && before.get(g.key) !== g.phase,
    );
    if (changed.length === 0) return;
    setAnnouncement(
      changed
        .map((g) => `${g.label} window: ${PHASE_ANNOUNCEMENT[g.phase]}`)
        .join(". "),
    );
  }, [signature]);

  return announcement;
}

const PHASE_ANNOUNCEMENT: Record<MarketWindowPhase, string> = {
  upcoming: "scheduled",
  open: "open for calls",
  sealed: "submissions closed",
  resolved: "resolved",
};

// ─── View param ─────────────────────────────────────────────────────────────

function readViewFromLocation(): MatrixView {
  const raw = readRouteQuery(window.location).get(VIEW_PARAM);
  return VIEWS.includes(raw as MatrixView) ? (raw as MatrixView) : "live";
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

// ─── Asset options ──────────────────────────────────────────────────────────

/** Venue order first, then anything new, alphabetically. Stable across renders. */
const ASSET_ORDER = ["BTC", "ETH", "SOL", "XRP", "DOGE"] as const;

function deriveAssetOptions(
  live: readonly MarketRow[],
  resolved: readonly ArchivedMarketRow[],
): AssetOption[] {
  const icons = new Map<string, string | null>();
  for (const market of live) {
    const symbol = marketAssetSymbol(market);
    if (symbol === null) continue;
    if (!icons.get(symbol)) {
      icons.set(symbol, parseMarketConfig(market)?.icon_url ?? null);
    }
  }
  for (const row of resolved) {
    const symbol = assetSymbolFromSlugOrQuestion(row.slug, row.question);
    if (symbol === null) continue;
    if (!icons.get(symbol)) icons.set(symbol, row.icon_url);
  }
  return [...icons.entries()]
    .map(([symbol, iconUrl]) => ({ symbol, iconUrl }))
    .sort((a, b) => {
      const ai = ASSET_ORDER.indexOf(a.symbol as (typeof ASSET_ORDER)[number]);
      const bi = ASSET_ORDER.indexOf(b.symbol as (typeof ASSET_ORDER)[number]);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.symbol.localeCompare(b.symbol);
    });
}

/**
 * `null` means "all", which is the resting state — not a full Set, so a new
 * asset appearing mid-session is included rather than silently filtered out.
 * Un-pressing the last remaining chip returns to "all" instead of leaving an
 * empty board with no obvious way back.
 */
function toggleAsset(
  current: ReadonlySet<string> | null,
  symbol: string,
  options: AssetOption[],
): ReadonlySet<string> | null {
  if (current === null) {
    // First press narrows to everything EXCEPT the one just un-pressed.
    const next = new Set(options.map((o) => o.symbol));
    next.delete(symbol);
    return next.size === 0 ? null : next;
  }
  const next = new Set(current);
  if (next.has(symbol)) next.delete(symbol);
  else next.add(symbol);
  if (next.size === 0) return null;
  if (next.size === options.length) return null;
  return next;
}
