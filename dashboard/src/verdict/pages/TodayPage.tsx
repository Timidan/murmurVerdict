import { useEffect, useRef, useState } from "react";
import { verdictApi, type TodayFeed, type TodayFeedRow } from "../api.js";
import { useStream } from "../hooks/useStream.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { ErrorState } from "../components/compact/ErrorState.js";
import { PanelSkeleton } from "../components/compact/PanelSkeleton.js";
import { formatScore } from "../lib/score-format.js";

export function TodayPage() {
  const [feed, setFeed] = useState<TodayFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { recentCalls } = useStream();

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
      <CompactTopbar crumb="feed · last 24h" />

      {error && (
        <div className="border-b border-[var(--color-border)]">
          <ErrorState kind="error" what="feed" detail={error} />
        </div>
      )}

      {!error && !feed && (
        <main className="flex-1 grid grid-cols-1 lg:grid-cols-3 min-h-0">
          <Panel title="live · pending" className="lg:border-r-0">
            <PanelSkeleton rows={6} />
          </Panel>
          <Panel title="resolved · 24h" className="lg:border-r-0">
            <PanelSkeleton rows={6} />
          </Panel>
          <Panel title="accepted · 24h">
            <PanelSkeleton rows={6} />
          </Panel>
        </main>
      )}

      {feed && (
        <main className="flex-1 grid grid-cols-1 lg:grid-cols-3 min-h-0">
          <Panel
            title="live · pending"
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
            title="resolved · 24h"
            meta={feed.resolved_recent.length.toString()}
            className="lg:border-r-0"
          >
            <FeedRows
              rows={feed.resolved_recent}
              emptyLabel="[no verdicts resolved in the last 24h]"
            />
          </Panel>
          <Panel title="accepted · 24h" meta={feed.accepted_recent.length.toString()}>
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
  if (rows.length === 0) {
    return <div className="px-2 py-3 ck-mono ck-dim leading-tight">{emptyLabel}</div>;
  }
  return (
    <ul className="m-0 p-0 list-none">
      {rows.map((row) => {
        // Pending calls render sealed placards rather than verdict fields.
        const ts = (row.submitted_at ?? row.accepted_at).slice(11, 19);
        const outcomeText = pending
          ? "pend"
          : row.call_score !== null && row.call_score !== undefined
            ? formatScore(row.call_score)
            : (row.outcome ?? "live");
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
            className="grid grid-cols-[60px_14px_1fr_60px] gap-2 px-2 py-1 border-b border-[var(--color-border)] items-center"
          >
            <a href={`#/calls/${row.call_id}`} className="contents no-underline">
              <span className="ck-mono ck-dim">{ts}</span>
              <span aria-hidden="true" className="ck-dim">▪</span>
              <span className="ck-mono ck-dim truncate">@{row.agent_slug}</span>
              <span className={"ck-mono text-right " + outcomeTone}>{outcomeText}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

