import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  fetchArchivedMarkets,
  type ArchivedMarketRow,
} from "../../api.js";
import {
  assetSymbolFromSlugOrQuestion,
} from "../../lib/market-meta.js";
import { localDayEpochBounds } from "../../lib/market-windows.js";
import { ArchivedMarketLinkRow } from "./ArchivedMarketRow.js";
import { InlineError } from "./InlineError.js";

const DEBOUNCE_MS = 300;
const PAGE_LIMIT = 50;

interface SearchState {
  rows: ArchivedMarketRow[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Set once a query settles; drives the ONE announcement per query. */
  settledFor: string | null;
  error: string | null;
  loading: boolean;
}

const EMPTY: SearchState = {
  rows: [],
  nextCursor: null,
  hasMore: false,
  settledFor: null,
  error: null,
  loading: false,
};

/**
 * Archive search — every market this deployment has finished with.
 *
 * ─── The pattern, and why it is NOT a combobox ──────────────────────────────
 *
 * A combobox (`role="combobox"` + `aria-activedescendant` + a roving tabindex
 * over the options) is the right pattern when the list is a set of VALUES the
 * user is choosing between to fill the field. That is not what this is: the
 * results are destinations, the field is not a value picker, and pressing Enter
 * should run the search rather than "accept" a highlighted row.
 *
 * So this is a plain search form over a plain list of links:
 *   · `role="search"` on the form, with a VISIBLE label on the input.
 *   · The input owns focus for the entire interaction. Results updating never
 *     moves it — which is the single most important property here, because a
 *     screen-reader user typing three more characters must not be teleported
 *     into a list that is about to be replaced.
 *   · The list is `<ul>` of `<a>`: Tab reaches them in order, every assistive
 *     technology already knows what they are, and cmd-click works.
 *   · NOTHING is auto-focused. The results section is `aria-controls`-linked
 *     from the input, so a screen reader can navigate to it deliberately.
 *
 * ─── Announcements ──────────────────────────────────────────────────────────
 *
 * The list itself carries NO `aria-live`. A live list re-announces on every
 * keystroke, which turns a three-word search into thirty interruptions. Instead
 * one stable `role="status"` region says the OUTCOME, once, when a query
 * settles: "12 archived markets found". `aria-busy` on the results section
 * covers the interval in between.
 *
 * ─── Staleness ──────────────────────────────────────────────────────────────
 *
 * Two independent guards, because either alone leaks:
 *   · an `AbortController` per query, so superseded requests stop occupying a
 *     connection; and
 *   · a monotonic generation counter checked after every await, because abort
 *     is not synchronous — a response already in the microtask queue when
 *     `abort()` is called still resolves.
 */
export function MarketsArchiveSearch({
  assetFilter,
  inputRef,
}: {
  /** Symbols to keep, or null for "all". Applied client-side, like the other views. */
  assetFilter: ReadonlySet<string> | null;
  /** Focus target for the grid's "/" shortcut. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const [term, setTerm] = useState("");
  const [day, setDay] = useState("");
  const [state, setState] = useState<SearchState>(EMPTY);

  const inputId = useId();
  const helpId = useId();
  const resultsId = useId();
  const dayId = useId();

  const generation = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runQuery = useCallback(
    async (nextTerm: string, nextDay: string, cursor: string | null) => {
      const trimmed = nextTerm.trim();
      const bounds = nextDay ? localDayEpochBounds(nextDay) : null;
      const queryKey = `${trimmed}|${nextDay}`;

      // The server requires a term of 2+ characters OR a date bound. Asking
      // anyway would spend a round trip to be told so; an empty field is the
      // resting state, not an error.
      if (trimmed.replace(/\s+/g, "").length < 2 && bounds === null) {
        generation.current += 1;
        inFlight.current?.abort();
        inFlight.current = null;
        setState(EMPTY);
        return;
      }

      const mine = ++generation.current;
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      setState((prev) => ({
        ...prev,
        loading: true,
        error: null,
        // A new query (no cursor) empties the list; a "load more" keeps it.
        rows: cursor === null ? [] : prev.rows,
        settledFor: cursor === null ? null : prev.settledFor,
      }));

      try {
        const page = await fetchArchivedMarkets(
          {
            ...(trimmed.length > 0 ? { q: trimmed } : {}),
            ...(bounds ? { from: bounds.fromEpochS, to: bounds.toEpochS } : {}),
            ...(cursor ? { cursor } : {}),
            limit: PAGE_LIMIT,
          },
          controller.signal,
        );
        if (mine !== generation.current) return; // superseded mid-flight
        setState((prev) => ({
          rows: cursor === null ? page.results : [...prev.rows, ...page.results],
          nextCursor: page.next_cursor,
          hasMore: page.has_more,
          settledFor: queryKey,
          error: null,
          loading: false,
        }));
      } catch (err) {
        if (mine !== generation.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState((prev) => ({
          ...prev,
          loading: false,
          // The server's own reason, when it gave one — "provide q with at
          // least 2 characters, or a from/to date bound" is more useful than
          // "request failed".
          error: archiveErrorMessage(err),
        }));
      } finally {
        if (inFlight.current === controller) inFlight.current = null;
      }
    },
    [],
  );

  // Debounced re-query on every input change. Enter bypasses this (see the
  // form's onSubmit), which is what makes the field feel immediate to anyone
  // who types faster than 300ms and then commits.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      debounce.current = null;
      void runQuery(term, day, null);
    }, DEBOUNCE_MS);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [term, day, runQuery]);

  // Cancel anything in flight when the view unmounts (tab switch, navigation).
  useEffect(() => () => {
    generation.current += 1;
    inFlight.current?.abort();
  }, []);

  const visible = assetFilter
    ? state.rows.filter((row) => {
        const symbol = assetSymbolFromSlugOrQuestion(row.slug, row.question);
        return symbol !== null && assetFilter.has(symbol);
      })
    : state.rows;

  return (
    <div className="flex flex-col min-h-0">
      <form
        role="search"
        aria-label="Search archived markets"
        onSubmit={(e) => {
          e.preventDefault();
          // Enter commits now — drop the pending debounce rather than firing
          // the same query twice.
          if (debounce.current) {
            clearTimeout(debounce.current);
            debounce.current = null;
          }
          void runQuery(term, day, null);
        }}
        className="flex flex-wrap items-end gap-x-3 gap-y-2 px-2 py-2 border-b border-[var(--color-border)]"
      >
        <span className="flex flex-col gap-1 min-w-0 flex-1">
          <label htmlFor={inputId} className="ck-label">
            search the archive
          </label>
          <input
            id={inputId}
            ref={inputRef}
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            aria-controls={resultsId}
            aria-describedby={helpId}
            placeholder="bitcoin, doge, updown…"
            className="ck-mono min-h-[40px] w-full min-w-[10ch] bg-transparent border border-[var(--color-border)] px-2 py-1 outline-none focus:border-[var(--color-border-vis)] placeholder:text-[var(--color-disabled)]"
          />
        </span>
        <span className="flex flex-col gap-1">
          <label htmlFor={dayId} className="ck-label">
            ended on
          </label>
          <input
            id={dayId}
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            aria-controls={resultsId}
            className="ck-mono min-h-[40px] bg-transparent border border-[var(--color-border)] px-2 py-1 outline-none focus:border-[var(--color-border-vis)]"
          />
        </span>
        {day && (
          <button
            type="button"
            onClick={() => setDay("")}
            className="ck-btn ck-btn-bracket min-h-[40px]"
          >
            clear date
          </button>
        )}
        <span id={helpId} className="ck-dim ck-meta basis-full">
          Type two or more characters, or pick a day. Murmur matches the venue
          question and the slug.
        </span>
      </form>

      {/* ONE stable status region. Rendered unconditionally so assistive tech
          adopts it before the first result lands — a live region inserted at
          the same moment its text appears is frequently missed. */}
      <p role="status" className="sr-only">
        {announcementFor(state, visible.length)}
      </p>

      <section
        id={resultsId}
        aria-busy={state.loading}
        aria-label="Archived markets"
        className="flex-1 min-h-0"
      >
        {state.error && (
          <InlineError error={state.error} className="px-2 py-2 ck-mono" />
        )}
        {!state.error && state.settledFor !== null && visible.length === 0 && (
          <p className="px-2 py-2 ck-mono ck-dim">
            {state.rows.length > 0
              ? "[no results for the assets you picked]"
              : "[no archived markets found]"}
          </p>
        )}
        {!state.error && state.settledFor === null && !state.loading && (
          <p className="px-2 py-2 ck-mono ck-dim">
            [the archive holds every market murmur has finished with]
          </p>
        )}
        <ul className="m-0 p-0 list-none">
          {visible.map((row) => (
            <ArchivedMarketLinkRow key={row.market_id} row={row} />
          ))}
        </ul>
        {state.hasMore && !state.error && (
          <div className="px-2 py-2">
            <button
              type="button"
              disabled={state.loading}
              onClick={() => void runQuery(term, day, state.nextCursor)}
              className="ck-btn ck-btn-bracket min-h-[40px]"
            >
              {state.loading ? "loading…" : "load more"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Exactly one sentence per settled query. Empty while a query is in flight —
 * `aria-busy` already covers that interval, and announcing "loading" on every
 * keystroke is the noise this design exists to avoid.
 */
function announcementFor(state: SearchState, visibleCount: number): string {
  if (state.loading) return "";
  if (state.error) return "";
  if (state.settledFor === null) return "";
  if (visibleCount === 0) return "No archived markets found.";
  const noun = visibleCount === 1 ? "archived market" : "archived markets";
  if (state.hasMore) {
    return `Showing first ${visibleCount} ${noun}; more available.`;
  }
  return `${visibleCount} ${noun} found.`;
}

/** The server's structured reason when it gave one, else the raw message. */
function archiveErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.rawBody) as { message?: unknown };
      if (typeof body.message === "string" && body.message.length > 0) {
        return body.message;
      }
    } catch {
      // Not JSON — fall through to the message.
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
