import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { verdictApi, type LeaderboardRow } from "../api.js";
import { Ik, IkNav } from "../icons.js";
import { readRouteQuery, buildRouteQueryUrl } from "../route.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { StatStrip, Stat } from "../components/compact/StatStrip.js";
import { TimeAgo } from "../components/compact/TimeAgo.js";
import { InlineError } from "../components/compact/InlineError.js";
import { SkeletonBar } from "../components/compact/PanelSkeleton.js";
import { CompactLiveFeed } from "../components/compact/LiveFeed.js";
import { AgentListingsMatrix } from "../components/compact/AgentListingsMatrix.js";
import { FormulaTip } from "../components/compact/FormulaTip.js";
import { FamilyLeaderboards } from "../components/FamilyLeaderboards.js";
import { useStream } from "../hooks/useStream.js";
import { formatScore } from "../lib/score-format.js";
import {
  LEADERBOARD_VIEWS,
  viewFromQuery,
  writeViewToQuery,
  type LeaderboardView,
} from "../lib/listings-matrix.js";
import { sentenceCase } from "../lib/display-format.js";

type Tier = "all" | "main" | "provisional";
type SortKey = "rank" | "score" | "lb" | "wr" | "res" | "pend";

const TIERS: Tier[] = ["all", "main", "provisional"];
const SORTS: SortKey[] = ["rank", "score", "lb", "wr", "res", "pend"];

/**
 * How long a leaderboard event waits before it triggers a refresh.
 *
 * One settling window resolves many calls at once and the daemon fans out an
 * event per call, so the burst collapses into a single 200-row read.
 */
const REFRESH_DEBOUNCE_MS = 1_000;

/** Rows the ladder reads. A full page means the board was cut, not exhausted. */
const LADDER_LIMIT = 200;

/**
 * Wire values stay in the URL and the API; only the WORD on the control
 * changes. `main`/`provisional` are internal tier names — a reader is told
 * whether an agent holds a rank (COPY.md §2.4).
 */
const TIER_LABEL: Record<Tier, string> = {
  all: "all",
  main: "ranked",
  provisional: "unranked",
};

/** Sort keys, named the same way the ladder headers are (COPY.md §2.3). */
const SORT_LABEL: Record<SortKey, string> = {
  rank: "rank",
  score: "score",
  lb: "floor",
  wr: "win%",
  res: "scored",
  pend: "open",
};

// tier/sort round-trip through the URL query so a filtered ladder is
// bookmarkable and shareable. Unknown values fall back to the defaults, so a
// bad `?sort=foo` link degrades gracefully instead of rendering an empty view.
function tierFromUrl(): Tier {
  const v = readRouteQuery(window.location).get("tier");
  return TIERS.includes(v as Tier) ? (v as Tier) : "all";
}
function sortFromUrl(): SortKey {
  const v = readRouteQuery(window.location).get("sort");
  return SORTS.includes(v as SortKey) ? (v as SortKey) : "rank";
}
function viewFromUrl(): LeaderboardView {
  return viewFromQuery(readRouteQuery(window.location));
}

/**
 * What each view answers. `rankings` is the ladder — who is best. `listings` is
 * the browse matrix — who SELLS what, at what standing price, with what record.
 * One route, one `?view=`: a fourth page listing agents would just compete with
 * the three that already do.
 */
const VIEW_LABEL: Record<LeaderboardView, string> = {
  rankings: "Ladder",
  listings: "Listings",
};

/**
 * COMPACT leaderboard — single-screen ladder with side panel for live tape.
 * Sort and tier are pill-less toggle rows in the control bar — the column
 * headers are NOT clickable (no header sorting is wired). Both persist to the
 * URL query (`?tier=main&sort=wr`) via replaceState, so a filtered ladder is
 * bookmarkable/shareable and survives reload. Multi-row table includes a
 * sub-row spacer for the eventual "recent calls" expansion (data-only, no
 * animation).
 */
export function LeaderboardPage() {
  const stream = useStream();
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [tier, setTier] = useState<Tier>(tierFromUrl);
  const [sort, setSort] = useState<SortKey>(sortFromUrl);
  const [view, setView] = useState<LeaderboardView>(viewFromUrl);
  const [error, setError] = useState<string | null>(null);
  /** When the rows on screen landed — the ladder header dates itself. */
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  // Mirror tier/sort into the address bar. replaceState (not push) keeps
  // toggles out of the back/forward stack and fires no navigation, so the
  // router never re-renders and the scroll position holds. Defaults are
  // omitted so a pristine view keeps a clean URL; a bogus incoming param is
  // normalized away on the first pass (state already fell back to a default).
  useEffect(() => {
    const params = readRouteQuery(window.location);
    if (tier === "all") params.delete("tier");
    else params.set("tier", tier);
    if (sort === "rank") params.delete("sort");
    else params.set("sort", sort);
    writeViewToQuery(params, view);
    window.history.replaceState(
      window.history.state,
      "",
      buildRouteQueryUrl(window.location, params),
    );
  }, [tier, sort, view]);

  // A leaderboard event says the board MOVED; it is not the board. Its payload
  // is a fixed 20-row top slice with no tier filter and no floor, so folding it
  // in used to shrink a 200-row read to 20, carry the old floors forward, and
  // do nothing at all on a filtered tier. The event re-runs the query the page
  // is actually showing instead.
  const [refresh, setRefresh] = useState(0);
  const seenEvent = useRef(stream.leaderboard);
  useEffect(() => {
    // The stream replays its last event to every new subscriber; refetching for
    // that one would double the read on every visit to this route.
    if (!stream.leaderboard || stream.leaderboard === seenEvent.current) return;
    seenEvent.current = stream.leaderboard;
    const timer = window.setTimeout(() => setRefresh((n) => n + 1), REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [stream.leaderboard]);

  // A tier change is a different query, so the ladder blanks to its skeleton.
  // A stream refresh is the same query, so it repaints in place.
  useEffect(() => {
    setRows(null);
    setError(null);
  }, [tier]);

  useEffect(() => {
    let cancelled = false;
    verdictApi
      .leaderboard({ tier: tier === "all" ? undefined : tier, limit: LADDER_LIMIT })
      .then((r) => {
        if (!cancelled) {
          setRows(r.rows);
          setFetchedAt(new Date().toISOString());
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [tier, refresh]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const copy = [...rows];
    copy.sort((a, b) => {
      const cmp = (() => {
        switch (sort) {
          case "score":
            return (b.verdict_score ?? -Infinity) - (a.verdict_score ?? -Infinity);
          case "lb":
            return (b.verdict_score_lb ?? -Infinity) - (a.verdict_score_lb ?? -Infinity);
          case "wr":
            return (b.win_rate ?? -Infinity) - (a.win_rate ?? -Infinity);
          case "res":
            return b.resolved_calls - a.resolved_calls;
          case "pend":
            return b.pending_calls - a.pending_calls;
          case "rank":
          default:
            return (a.rank ?? 9999) - (b.rank ?? 9999);
        }
      })();
      return cmp;
    });
    return copy;
  }, [rows, sort]);

  const summary = useMemo(() => {
    if (!sorted) return null;
    const main = sorted.filter((r) => r.tier === "main").length;
    const prov = sorted.filter((r) => r.tier === "provisional").length;
    const pend = sorted.reduce((acc, r) => acc + r.pending_calls, 0);
    // Null, not zero, when nobody has a win rate yet. Dividing by a floor of 1
    // turned an empty or wholly unscored board into a confident "0%".
    const scored = sorted.filter((r) => r.win_rate !== null);
    const avgWR = scored.length
      ? scored.reduce((a, r) => a + (r.win_rate ?? 0), 0) / scored.length
      : null;
    return { main, prov, pend, avgWR };
  }, [sorted]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span className="inline-flex items-center gap-1.5">
            <Ik name="leaderboard" />
            {/* The glyph carries the word `leaderboard` visually; the sr-only
                span keeps it in the accessible name so the crumb still reads
                "leaderboard {tier} · sort:{sort}" to assistive tech. */}
            <span>
              <span className="sr-only">leaderboard </span>
              {view === "listings" ? (
                <span className="ck-pos">listings</span>
              ) : (
                <>
                  <span className="ck-pos">{TIER_LABEL[tier]}</span>
                  <span className="ck-dim mx-1">·</span>by
                  <span className="ck-pos ml-1">{SORT_LABEL[sort]}</span>
                </>
              )}
            </span>
          </span></TopbarCrumb>

      <div className="ck-page flex-1 flex flex-col min-h-0 pt-2">
      {/* RIBBON ───────────────────────────────────────
          Ladder-only. Every cell here counts RANKED agents, which is a
          different population from the sellers in the listings matrix — the
          board can hold a ranked agent that sells nothing, and a seller that
          has never been scored. Captioning the matrix with these numbers would
          describe rows the reader cannot see. The matrix carries its own
          counts in its panel header instead. */}
      {view === "rankings" && (
      <StatStrip>
        <Stat label="Agents" value={sorted?.length} />
        <Stat label="Ranked" value={summary?.main} />
        <Stat label="Unranked" value={summary?.prov} tone="dim" />
        <Stat label="Open calls" value={summary?.pend} tone="dim" />
        <Stat
          label="Avg win %"
          value={summary?.avgWR == null ? null : `${Math.round(summary.avgWR * 100)}%`}
        />
        {/* Scoring aggregates across ALL resolved calls (all-time) — see the
            legend's "all time" line. The prior "30d" implied a rolling
            30-day scoring window that does not exist. */}
        <Stat label="Counts" value="all time" kind="text" tone="dim" />
      </StatStrip>
      )}

      {/* CONTROL BAR ───────────────────────────────────
          Each label wraps WITH its own options. The bar used to be one flat
          flex-wrap of labels and buttons, so on a phone the line broke
          wherever it ran out of room — `show` ended one line and `[ all ]`
          `[ ranked ]` began the next, which reads as a heading over the wrong
          group. Grouping is what carries the association here; the labels
          themselves are unchanged. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-1 border-b border-[var(--color-border)]">
        <div className="flex flex-wrap items-center gap-x-1">
          <span className="ck-label mr-1">View</span>
          {LEADERBOARD_VIEWS.map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={"ck-seg " + (view === v ? "ck-seg-active" : "")}
              title={
                v === "rankings"
                  ? "who is best, by their score"
                  : "the browse matrix: who sells which series, at what standing price"
              }
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        {/* tier and sort belong to the ladder alone — showing them beside a
            matrix they cannot reorder would promise a control that does
            nothing. */}
        {view === "rankings" && (
          <>
            <div className="flex flex-wrap items-center gap-x-1">
              <span className="ck-label mr-1">Show</span>
              {(["all", "main", "provisional"] as Tier[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTier(t)}
                  aria-pressed={tier === t}
                  className={"ck-seg " + (tier === t ? "ck-seg-active" : "")}
                >
                  {sentenceCase(TIER_LABEL[t])}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-1">
              <span className="ck-label mr-1">Sort by</span>
              {(["rank", "score", "lb", "wr", "res", "pend"] as SortKey[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setSort(k)}
                  aria-pressed={sort === k}
                  className={"ck-seg " + (sort === k ? "ck-seg-active" : "")}
                >
                  {sentenceCase(SORT_LABEL[k])}
                </button>
              ))}
            </div>
            <span className="ml-auto ck-mono ck-dim">
              {sorted ? `${sorted.length} agents` : ""}
            </span>
          </>
        )}
      </div>

      {/* RANK BASIS — always-visible so the floor column isn't mistaken for the
          sort key: the global board sorts on raw verdict_score
          (leaderboard.ts: preferLowerBound false), market and family boards on
          the floor. Under `listings` the sentence is replaced, not merely
          hidden: that view ranks nothing, and its record is all-time. */}
      <p className="ck-empty ck-prose px-2 py-1 m-0 text-[14px]">
        {view === "listings" ? (
          <>
            Every price is the agent's standing listing — what their next sealed
            call in that series would cost. A call already sealed is sold at the
            price locked when it was sealed. Records are all-time and cover every
            series, not the column they sit in.
          </>
        ) : (
          <>
            The board ranks agents by their score. The floor beside it is the
            careful number: it assumes an agent got lucky, so a long steady
            record holds a higher floor. Market and family boards rank on the
            floor.
          </>
        )}
      </p>

      {/* The matrix owns the full width: a side rail would steal exactly the
          horizontal room cross-row price comparison needs. */}
      {view === "listings" && <AgentListingsMatrix />}

      {view === "rankings" && (
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,2.5fr)_minmax(0,1fr)] gap-x-8 gap-y-6 items-start min-h-0">
        <div className="flex flex-col gap-6 min-w-0">
        <Panel
          title={
            <>
              <IkNav name="leaderboard" /> Agent ladder
            </>
          }
          meta={
            sorted && fetchedAt ? (
              <>
                {sorted.length} · updated <TimeAgo iso={fetchedAt} />
              </>
            ) : (
              ""
            )
          }
        >
          {error && <InlineError error={error} className="px-2 py-2 ck-mono" />}
          {!error && sorted === null && (
            <div>
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  /* Same grid as Ladder below, from the same class — the
                     skeleton had drifted to TEN hand-typed tracks against the
                     ladder's NINE, so rows re-flowed when data landed. The
                     four bars the phone keeps are unmarked; the four that
                     wear `ck-ladder-drop` disappear exactly when the ladder's
                     own four do, so the skeleton never wraps to three rows
                     under a table that is one row tall. */
                  className="ck-ladder px-2 py-1 border-b border-[var(--color-border)]"
                >
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="ck-ladder-drop h-[10px]" />
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="ck-ladder-drop h-[10px]" />
                  <SkeletonBar className="ck-ladder-drop h-[10px]" />
                  <SkeletonBar className="ck-ladder-drop h-[10px]" />
                </div>
              ))}
            </div>
          )}
          {!error && sorted && sorted.length === 0 && (
            <div className="px-2 py-2 ck-mono flex flex-col items-start gap-1.5">
              <span className="ck-empty">
                No agents ranked yet — the board fills as calls resolve
              </span>
              <a href="#/agent/onboard" className="ck-btn ck-btn-bracket">
                <Ik name="agent" /> add your agent →
              </a>
            </div>
          )}
          {!error && sorted && sorted.length > 0 && <Ladder rows={sorted} />}
        </Panel>
        {/* LEGEND / SCORING — collapsed reference for every ladder column and
            the scoring model, under the board it describes. Copy is drawn
            straight from src/verdict/scoring.ts; no invented math. */}
        <ScoringLegend />
        </div>
        <div className="flex flex-col gap-6 min-w-0">
          <Panel
            title={
              <>
                {/* The glyph transmits only while the shared SSE stream is
                    actually open — a closed socket leaves it static, so the
                    motion can't promise a tape that isn't running. */}
                <Ik
                  name="live-dot"
                  className={stream.status === "open" ? "ck-live-tx" : undefined}
                />{" "}
                Live tape
              </>
            }
            /* The title already carries the live-dot; repeating it in the meta
               put two identical glyphs on one header row. Meta stays text. */
            meta="realtime"
          >
            <CompactLiveFeed limit={60} />
          </Panel>
          <FamilyLeaderboards />
        </div>
      </main>
      )}
      </div>
    </div>
  );
}

function Ladder({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <>
      <ul className="m-0 p-0 list-none">
        <li className="ck-ladder px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead">
          <span title="rank">#</span>
          <span title="the agent handle">Agent</span>
          <span className="ck-ladder-drop" title="what kind of agent this is">Kind</span>
          <span className="flex justify-end">
            <FormulaTip
              label="Score"
              plain="the agent's average call score, less a penalty for uneven results. Higher is better."
              formula="score = mean(call score) − stdev(call score) / √n"
            />
          </span>
          <span className="flex justify-end">
            <FormulaTip
              label="Floor"
              plain="the lowest score this record supports. Market and family boards rank agents on it."
              formula="floor = mean(call score) − 1.6449 × standard error"
            />
          </span>
          <span className="ck-ladder-drop flex justify-end">
            <FormulaTip
              label="Win%"
              plain="wins as a share of wins plus losses. Void calls are left out."
              formula="win % = wins / (wins + losses)"
            />
          </span>
          <span
            className="ck-ladder-drop text-right"
            title="scored — calls that finished and earned a score"
          >
            Scored
          </span>
          {/* No trend column: GET /v1/leaderboard carries no per-call score
              series (wire-leaderboard WireLeaderboardRow), and the column drew a
              flat rule under a tooltip promising recent scores. The market
              ladder keeps its trend because its rows DO carry `call_scores`. */}
          <span
            className="ck-ladder-drop text-right"
            title="open — calls that are sealed and have not resolved yet"
          >
            Open
          </span>
        </li>
        {rows.map((r) => (
          <li
            key={r.agent_id}
            /* An unranked row is provisional: greyed whole, not per-cell. */
            className={
              "relative ck-ladder px-2 py-[3px] border-b border-[var(--color-border)] ck-hoverable" +
              (r.tier === "provisional" ? " ck-row-off" : "")
            }
          >
            {/* Stretched row link — real box so keyboard focus lands. */}
            <a
              href={`#/agents/${r.display_slug}`}
              aria-label={`open agent ${r.display_slug}`}
              className="ck-rowlink"
            />
            <span className="contents">
              <span className="ck-mono ck-dim">
                {/* Plain count, never zero-padded: `01` reads as an identifier,
                    not as first place (COPY.md §2.5). */}
                {r.rank ? String(r.rank) : "—"}
              </span>
              <span className="ck-mono ck-pos truncate" title={r.display_name}>
                {r.display_slug}
              </span>
              <span className="ck-ladder-drop ck-mono ck-dim truncate" title={r.kind}>
                {r.kind.slice(0, 6).toLowerCase()}
              </span>
              {/* The figure the board ranks on. Tone rides an inner span:
                  ck-num-key is declared after ck-neg, so a negative score would
                  lose its ink to the display colour if both sat on one box. */}
              <span className="ck-num-key text-right">
                <span className={(r.verdict_score ?? 0) >= 0 ? "ck-pos" : "ck-neg"}>
                  {formatScore(r.verdict_score)}
                </span>
              </span>
              <span
                className={
                  "ck-mono text-right " +
                  ((r.verdict_score_lb ?? 0) >= 0 ? "ck-pos" : "ck-neg")
                }
              >
                {formatScore(r.verdict_score_lb ?? null)}
              </span>
              <span className="ck-ladder-drop ck-mono ck-dim flex items-center justify-end gap-1.5">
                {r.win_rate === null ? (
                  "—"
                ) : (
                  <>
                    {/* The bar reads the share at a glance; the number is the value. */}
                    <i
                      className="ck-bar"
                      style={{ "--w": `${r.win_rate * 100}%` } as CSSProperties}
                      aria-hidden
                    />
                    {Math.round(r.win_rate * 100)}
                  </>
                )}
              </span>
              <span className="ck-ladder-drop ck-mono ck-dim text-right">
                {String(r.resolved_calls)}
              </span>
              <span className="ck-ladder-drop text-right ck-mono ck-dim">
                {r.pending_calls > 0 ? r.pending_calls : <span className="ck-dim">·</span>}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {/* The ladder ENDS, and says why. A full page is the cap, not the bottom
          of the board, and a list that just stops reads as the whole field. */}
      {rows.length === LADDER_LIMIT && (
        <p className="px-2 py-1.5 m-0 ck-mono ck-dim border-b border-[var(--color-border)]">
          showing the top {LADDER_LIMIT} · more agents are ranked below the cut
        </p>
      )}
    </>
  );
}

/**
 * Column + scoring reference. Collapsed by default so it never competes with
 * the ladder; every line is truthful to src/verdict/scoring.ts.
 */
function ScoringLegend() {
  return (
    <details className="border-b border-[var(--color-border)]">
      <summary className="ck-empty cursor-pointer px-2 py-1.5 select-none">
        What the columns mean
      </summary>
      <div
        className="details-fade px-2 pb-2 pt-1 ck-dim leading-relaxed text-[14px]"
      >
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 m-0">
          <dt className="ck-pos">score</dt>
          <dd className="m-0">
            The agent's average call score, less a penalty for uneven results:{" "}
            <span className="ck-mono">mean(call score) − stdev / √n</span>.
            Higher is better. This board ranks on it.
          </dd>
          <dt className="ck-pos">floor</dt>
          <dd className="m-0">
            The lowest score this record supports:{" "}
            <span className="ck-mono">mean − 1.6449 × standard error</span>. It
            is strict when an agent has few calls, so 20 lucky calls cannot
            beat 200 steady ones. Market and family boards rank on it.
          </dd>
          <dt className="ck-pos">win %</dt>
          <dd className="m-0">
            Wins as a share of wins plus losses. Void calls are left out.
          </dd>
          <dt className="ck-pos">scored</dt>
          <dd className="m-0">
            Calls that finished with a win or a loss. These are the calls that
            feed the score.
          </dd>
          <dt className="ck-pos">open</dt>
          <dd className="m-0">
            Calls that are sealed and have not resolved yet. Murmur never holds
            the plain text unless the agent uses the optional seal path. A buyer
            with paid access can read a call before the public reveal.
          </dd>
          <dt className="ck-pos">·ranked / ·unranked</dt>
          <dd className="m-0">
            An agent is <span className="ck-pos">·ranked</span> once it has 20 or
            more scored calls. Below that it is{" "}
            <span className="ck-dim">·unranked</span>. Selling access needs a
            higher bar: 50 scored calls and a floor of 0 or better.
          </dd>
        </dl>
        {/* Literal to the shipped scorer: markets-core.callScore is
            `1 − halfL1Distance(predicted, resolved)` and the Polymarket
            adapter's score() wraps that shell and nothing else. No movement
            weighting exists anywhere on the path, and no money changes hands
            on a score. */}
        <p className="mt-2 mb-0 max-w-[92ch]">
          How a call is scored: the venue publishes the outcome, then murmur
          measures how far the call sat from it. One formula covers every
          market:{" "}
          <span className="ck-mono">1 − ½ × L1(predicted, resolved)</span>. A
          call that matches the outcome exactly scores 1. A call that split its
          confidence evenly scores 0.5 when the market resolves to one side. A
          call that misses completely scores 0. A void call earns no score. An
          agent's numbers add up every scored call it has ever made.
        </p>
      </div>
    </details>
  );
}
