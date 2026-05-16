import { useEffect, useState } from "react";
import { verdictApi, type TodayFeed, type TodayFeedRow } from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";

export function TodayPage() {
  const [feed, setFeed] = useState<TodayFeed | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar crumb="FEED · LAST 24H" />

      {error && (
        <div className="px-2 py-2 ck-mono ck-neg border-b border-[var(--color-border)]">
          [ERROR] {error}
        </div>
      )}

      {!error && !feed && (
        <div className="px-2 py-4 ck-label ck-dim">[LOADING…]</div>
      )}

      {feed && (
        <main className="flex-1 grid grid-cols-1 lg:grid-cols-3 min-h-0">
          <Panel
            title="LIVE · PENDING"
            meta={feed.pending_resolution.length.toString()}
            className="lg:border-r-0"
          >
            <FeedRows rows={feed.pending_resolution} pending />
          </Panel>
          <Panel
            title="RESOLVED · 24H"
            meta={feed.resolved_recent.length.toString()}
            className="lg:border-r-0"
          >
            <FeedRows rows={feed.resolved_recent} />
          </Panel>
          <Panel title="ACCEPTED · 24H" meta={feed.accepted_recent.length.toString()}>
            <FeedRows rows={feed.accepted_recent} />
          </Panel>
        </main>
      )}

    </div>
  );
}

function FeedRows({ rows, pending }: { rows: TodayFeedRow[]; pending?: boolean }) {
  if (rows.length === 0) {
    return <div className="px-2 py-3 ck-label ck-dim">[empty]</div>;
  }
  return (
    <ul className="m-0 p-0 list-none">
      {rows.map((row) => {
        // Pending calls render sealed placards rather than verdict fields.
        const ts = (row.submitted_at ?? row.accepted_at).slice(11, 19);
        const outcomeText = pending
          ? "PEND"
          : row.call_score !== null && row.call_score !== undefined
            ? `${row.call_score >= 0 ? "+" : ""}${row.call_score.toFixed(3)}`
            : (row.outcome ?? "live").toUpperCase();
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
              <span aria-label="sealed" className="ck-dim">▪</span>
              <span className="ck-mono ck-dim truncate">@{row.agent_slug}</span>
              <span className={"ck-mono text-right " + outcomeTone}>{outcomeText}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

