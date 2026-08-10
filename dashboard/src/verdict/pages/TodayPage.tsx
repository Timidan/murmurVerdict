import { useEffect, useRef, useState } from "react";
import { verdictApi, type TodayFeed, type TodayFeedRow } from "../api.js";
import { Ik, IkNav } from "../icons.js";
import { useDetailDrawer, isPlainLeftClick } from "../components/compact/DetailDrawer.js";
import { useStream } from "../hooks/useStream.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
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
    <Ik name="live-dot" className={live ? "ck-live-tx" : undefined} /> live · pending
  </>
);
const TITLE_RESOLVED = (
  <>
    <Ik name="resolve" /> resolved · 24h
  </>
);
const TITLE_ACCEPTED = (
  <>
    <IkNav name="confirm-live" /> accepted · 24h
  </>
);

export function TodayPage() {
  const [feed, setFeed] = useState<TodayFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { recentCalls, status } = useStream();
  // useStream is a per-tab singleton (one EventSource however many components
  // subscribe), so reading it here costs no extra connection.
  const live = status === "open";

  useEffect(() => {
    let cancelled = false;
    verdictApi
      .todayFeed()
      .then((r) => {
        if (!cancelled) setFeed(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep "live · pending" honest: every call.accepted / call.resolved event
  // on the shared SSE stream moves rows between the three panels, so refetch
  // the feed when a new one lands. Streamed rows are the lean wire shape and
  // can't be merged into TodayFeedRow directly — the REST endpoint stays the
  // source of truth. Keyed on the newest event (type + call_id) so replayed
  // snapshots at mount don't trigger a redundant fetch; refresh failures keep
  // the last good feed rather than blanking the page.
  const newest = recentCalls[0];
  const streamKey = newest ? `${newest.type}:${newest.call_id}` : null;
  const seenKey = useRef(streamKey);
  useEffect(() => {
    if (streamKey === null || streamKey === seenKey.current) return;
    seenKey.current = streamKey;
    let cancelled = false;
    verdictApi
      .todayFeed()
      .then((r) => {
        if (!cancelled) {
          setFeed(r);
          setError(null);
        }
      })
      .catch(() => {
        // Transient refresh failure — the next stream event retries.
      });
    return () => {
      cancelled = true;
    };
  }, [streamKey]);

  return (
    <div className="mmr-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span className="inline-flex items-center gap-1.5">
            <Ik name="feed" /> <span className="sr-only">feed </span>last 24h
          </span>
        }
      />

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
            meta={feed.pending_resolution.length.toString()}
            className="lg:border-r-0"
          >
            <FeedRows
              rows={feed.pending_resolution}
              pending
              emptyLabel="[nothing pending — sealed verdicts awaiting resolution appear here]"
            />
          </Panel>
          <Panel
            title={TITLE_RESOLVED}
            meta={feed.resolved_recent.length.toString()}
            className="lg:border-r-0"
          >
            <FeedRows
              rows={feed.resolved_recent}
              emptyLabel="[no verdicts resolved in the last 24h]"
            />
          </Panel>
          <Panel title={TITLE_ACCEPTED} meta={feed.accepted_recent.length.toString()}>
            <FeedRows
              rows={feed.accepted_recent}
              emptyLabel="[no new verdicts accepted in the last 24h]"
            />
          </Panel>
        </main>
      )}

    </div>
  );
}

function FeedRows({
  rows,
  pending,
  emptyLabel,
}: {
  rows: TodayFeedRow[];
  pending?: boolean;
  emptyLabel: string;
}) {
  const { open } = useDetailDrawer();
  if (rows.length === 0) {
    return <div className="px-2 py-3 ck-mono ck-dim leading-tight">{emptyLabel}</div>;
  }
  return (
    <ul className="m-0 p-0 list-none">
      {rows.map((row) => {
        // Pending calls render sealed placards rather than verdict fields.
        // The unscored fallback is sliced to 4 like every other tape in the
        // cockpit (LiveFeed, AgentPage.formatOutcome) — printing it raw let
        // `oracle_unavailable` run 122px off the end of the row.
        const outcomeText = pending
          ? "pend"
          : row.call_score !== null && row.call_score !== undefined
            ? formatScore(row.call_score)
            : (row.outcome ?? "live").slice(0, 4);
        const outcomeTone = pending
          ? "ck-dim"
          : row.outcome === "win"
            ? "ck-pos"
            : row.outcome === "loss"
              ? "ck-neg"
              : "ck-dim";
        return (
          <li
            key={row.call_id}
            className="relative grid grid-cols-[76px_14px_1fr_64px] gap-2 px-2 py-1 border-b border-[var(--color-border)] items-center"
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
              iso={row.submitted_at ?? row.accepted_at}
              className="ck-mono ck-dim truncate"
            />
            <span aria-hidden="true" className="ck-dim">▪</span>
            <span className="ck-mono ck-dim truncate">@{row.agent_slug}</span>
            <span className={"ck-mono text-right " + outcomeTone}>{outcomeText}</span>
          </li>
        );
      })}
    </ul>
  );
}

