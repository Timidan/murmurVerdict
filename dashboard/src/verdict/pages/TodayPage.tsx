import { useEffect, useState } from "react";
import { verdictApi, type TodayFeed, type TodayFeedRow } from "../api.js";
import { Ik, IkNav } from "../icons.js";
import { useDetailDrawer, isPlainLeftClick } from "../components/compact/DetailDrawer.js";
import { useStream } from "../hooks/useStream.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { ErrorState } from "../components/compact/ErrorState.js";
import { PanelSkeleton } from "../components/compact/PanelSkeleton.js";
import { TimeAgo } from "../components/compact/TimeAgo.js";
import { formatScore } from "../lib/score-format.js";

/**
 * Panel titles carry a semantic glyph in place of the generic ::before square
 * (icon-adoption sweep, P2). Declared once each because every title renders
 * twice — the loading-skeleton branch and the loaded branch — and the two must
 * never drift into different markers (the indent differs between a square and a
 * glyph, so a mismatch would shift the header when the feed lands).
 *
 * "live · pending" is a function of the stream state rather than a constant:
 * its glyph transmits (compact.css `.ck-live-tx`) only while the shared SSE
 * connection is actually open, so the marker can never animate a liveness the
 * socket doesn't have. Both branches call it with the same flag, so the
 * declared-once guarantee above still holds.
 */
const titlePending = (live: boolean) => (
  <>
    <Ik name="live-dot" className={live ? "ck-live-tx" : undefined} /> recent open calls
  </>
);
/* Every panel is the last 24h now: the feed builder bounds all three lists by
   the same window as feed.totals.*_24h and keeps the twenty-row cap as a ceiling
   inside it, so a quiet week shows a short panel instead of rows weeks old.
   "outcomes", not "scored": these rows also carry void and no-outcome calls,
   which settle without earning a score. */
const TITLE_RESOLVED = (
  <>
    <Ik name="resolve" /> recent outcomes
  </>
);
/** The rows on screen, against the window they came from. `total` is the 24h
 *  counter for panels that have one, so a panel at its twenty-row ceiling says
 *  so instead of passing the cap off as the whole window. */
const shownMeta = (shown: number, total?: number) => (
  <span title="calls on screen, out of the last 24h. The feed carries at most 20 per panel.">
    {total !== undefined && total > shown ? `${shown} of ${total}` : shown} in the last 24h
  </span>
);
const TITLE_ACCEPTED = (
  <>
    <IkNav name="confirm-live" /> sealed · recent
  </>
);

/** The public outcome, in words — shared wording with the tape and the ladder. */
const OUTCOME_TEXT: Record<string, string> = {
  win: "win",
  loss: "loss",
  void: "void",
  oracle_unavailable: "no outcome",
};

function outcomeWord(outcome: string): string {
  return OUTCOME_TEXT[outcome] ?? outcome.replace(/_/g, " ");
}

export function TodayPage() {
  const [feed, setFeed] = useState<TodayFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { recentCalls, status } = useStream();
  // useStream is a per-tab singleton (one EventSource however many components
  // subscribe), so reading it here costs no extra connection.
  const live = status === "open";

  // Every call.accepted / call.resolved event moves rows between the three
  // panels, so the REST feed is re-read when a new one lands. Streamed rows are
  // the lean wire shape and can't be merged into TodayFeedRow — REST stays the
  // source of truth. `live` is a dependency too: events that arrive while the
  // socket is down never arrive at all, so a reconnect has to re-read the feed
  // rather than trust a snapshot with a hole in it. A refresh failure keeps the
  // last good feed; only a cold load paints the error.
  const newest = recentCalls[0];
  const streamKey = newest ? `${newest.type}:${newest.call_id}` : null;
  useEffect(() => {
    let cancelled = false;
    verdictApi
      .todayFeed()
      .then((r) => {
        if (cancelled) return;
        setFeed(r);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled && feed === null) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamKey, live]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span className="inline-flex items-center gap-1.5">
            <Ik name="feed" /> <span className="sr-only">feed </span>recent
          </span></TopbarCrumb>

      {error && (
        <div className="border-b border-[var(--color-border)]">
          <ErrorState kind="error" what="feed" detail={error} />
        </div>
      )}

      {!error && !feed && (
        <main className="flex-1 grid grid-cols-1 lg:grid-cols-3 min-h-0">
          <Panel title={titlePending(live)} className="lg:border-r-0">
            <PanelSkeleton rows={6} />
          </Panel>
          <Panel title={TITLE_RESOLVED} className="lg:border-r-0">
            <PanelSkeleton rows={6} />
          </Panel>
          <Panel title={TITLE_ACCEPTED}>
            <PanelSkeleton rows={6} />
          </Panel>
        </main>
      )}

      {feed && (
        <main className="flex-1 grid grid-cols-1 lg:grid-cols-3 min-h-0">
          <Panel
            title={titlePending(live)}
            meta={shownMeta(feed.pending_resolution.length)}
            className="lg:border-r-0"
          >
            <FeedRows
              rows={feed.pending_resolution}
              variant="open"
              emptyLabel="[no open calls — sealed calls waiting to resolve appear here]"
            />
          </Panel>
          <Panel
            title={TITLE_RESOLVED}
            meta={shownMeta(feed.resolved_recent.length, feed.totals.resolved_24h)}
            className="lg:border-r-0"
          >
            <FeedRows
              rows={feed.resolved_recent}
              variant="scored"
              emptyLabel="[no outcomes yet — resolved calls appear here]"
            />
          </Panel>
          <Panel title={TITLE_ACCEPTED} meta={shownMeta(feed.accepted_recent.length, feed.totals.accepted_24h)}>
            <FeedRows
              rows={feed.accepted_recent}
              variant="sealed"
              emptyLabel="[no sealed calls yet — new calls appear here]"
            />
          </Panel>
        </main>
      )}

    </div>
  );
}

/**
 * One panel's rows.
 *
 * `variant` is what keeps the three panels from reading as three copies of one
 * list. Every panel used to stamp `submitted_at`, so a call that was sealed and
 * then scored printed the SAME time in the sealed column and the scored column
 * — two panels, twenty rows, identical to the character. Each panel now shows
 * the moment ITS panel is about: sealed shows when the call was accepted,
 * scored shows when the venue settled it.
 *
 * It also decides the score column. `sealed` used to render one, and the wire's
 * accepted projection carries no score, so the column was twenty em-dashes with
 * a screen-reader label reading "not scored yet" — about calls whose score was
 * visible in the next panel over.
 */
function FeedRows({
  rows,
  variant,
  emptyLabel,
}: {
  rows: TodayFeedRow[];
  variant: "open" | "scored" | "sealed";
  emptyLabel: string;
}) {
  const scored = variant === "scored";
  const { open } = useDetailDrawer();
  if (rows.length === 0) {
    return <div className="px-2 py-3 ck-mono ck-dim leading-tight">{emptyLabel}</div>;
  }
  return (
    <ul className="m-0 p-0 list-none">
      {rows.map((row) => {
        // A row only speaks when it has a verdict to report. The panel title
        // already names the state, so the old fallbacks printed one word down
        // an entire column: "pending" 20 times under "open calls", and "open"
        // 20 times under "sealed" — contradicting the header it sat beneath.
        // A scored row still shows its score; an unscored one defers to the
        // house empty glyph. Real outcomes go through the shared word map, so
        // `oracle_unavailable` reads "no outcome" instead of the old
        // four-character slice ("orac") that fitted but said nothing.
        const outcomeText = !scored
          ? null
          : row.call_score !== null && row.call_score !== undefined
            ? formatScore(row.call_score)
            : row.outcome
              ? outcomeWord(row.outcome)
              : null;
        const outcomeTone =
          row.outcome === "win" ? "ck-pos" : row.outcome === "loss" ? "ck-neg" : "ck-dim";
        return (
          <li
            key={row.call_id}
            className={
              "relative grid gap-2 px-2 py-1 border-b border-[var(--color-border)] items-center " +
              (scored ? "grid-cols-[76px_1fr_64px]" : "grid-cols-[76px_1fr]")
            }
          >
            {/* Stretched row link — real box so keyboard focus lands. */}
            <a
              href={`#/calls/${row.call_id}`}
              aria-label={`open call ${row.call_id.slice(0, 8)} by ${row.agent_slug}`}
              onClick={(e) => {
                if (isPlainLeftClick(e)) {
                  e.preventDefault();
                  open("call", row.call_id);
                }
              }}
              className="ck-rowlink"
            />
            <TimeAgo
              iso={
                scored
                  ? (row.resolved_at ?? row.accepted_at)
                  : (row.submitted_at ?? row.accepted_at)
              }
              className="ck-mono ck-dim truncate"
            />
            <span className="ck-mono ck-dim truncate">@{row.agent_slug}</span>
            {scored && (
              <span className={"ck-mono text-right " + outcomeTone}>
                {outcomeText ?? (
                  <>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">not scored yet</span>
                  </>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

