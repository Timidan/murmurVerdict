import { useEffect, useRef, useState } from "react";
import { useStream } from "../../hooks/useStream.js";
import { formatScore } from "../../lib/score-format.js";

/**
 * COMPACT live tape — terminal-style scroll of accepted/resolved events.
 * One row per event, single line, monospace, dot prefix for outcome.
 */
export function CompactLiveFeed({
  limit = 40,
  marketId,
}: {
  limit?: number;
  /** When set, show only calls on this market (SSE events carry market_id). */
  marketId?: string;
}) {
  const { recentCalls, status } = useStream();
  // A short grace so the SSE connection has a beat to deliver its first event
  // before we decide the tape is genuinely quiet. During the grace an empty
  // tape shows the skeleton; after it, an empty tape reads as "no activity yet"
  // instead of skeleton-ing forever (indistinguishable from a hung loader).
  const [graceElapsed, setGraceElapsed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setGraceElapsed(true), 3000);
    return () => clearTimeout(id);
  }, []);

  const scoped = marketId
    ? recentCalls.filter((evt) => evt.market_id === marketId)
    : recentCalls;
  const rows = scoped.slice(0, limit);

  // tape-row-enter is for genuinely-new events only: latch the keys present
  // in the first non-empty batch so first paint / remounts render still and
  // only rows that arrive later slide in (plans/003).
  const initialKeys = useRef<Set<string> | null>(null);
  if (initialKeys.current === null && rows.length > 0) {
    initialKeys.current = new Set(
      rows.map((evt) => evt.call_id + (evt.type === "call.resolved" ? "r" : "a")),
    );
  }

  if (rows.length === 0) {
    // Market-scoped tape with a live-but-nonmatching stream is a real empty
    // state, not a loading placeholder — say so immediately.
    if (marketId && recentCalls.length > 0) {
      return (
        <div className="px-2 py-2 ck-mono ck-dim">[no calls on this market yet]</div>
      );
    }
    // Entirely empty stream: skeleton only during the connect grace, then a
    // quiet no-activity line.
    if (graceElapsed) {
      // A dead connection and a genuinely-quiet stream both surface as an
      // empty tape — without this branch the "no activity yet" line reads as
      // a false all-clear while the SSE socket is actually down. When the
      // stream is reconnecting/closed, say so (ck-dim, no red: informational).
      if (status === "reconnecting" || status === "closed") {
        return (
          <div className="px-2 py-2 ck-mono ck-dim">
            [reconnecting to live feed…]
          </div>
        );
      }
      return (
        <div className="px-2 py-2 ck-mono ck-dim">
          [no activity yet — verdicts appear here live]
        </div>
      );
    }
    return <FeedSkeleton />;
  }

  return (
    <ul className="m-0 p-0 list-none">
      {rows.map((evt) => {
        const isResolved = evt.type === "call.resolved";
        const ts = (isResolved ? evt.resolved_at : evt.accepted_at).slice(11, 19);
        const rowKey = evt.call_id + (isResolved ? "r" : "a");
        const isInitial = initialKeys.current?.has(rowKey) ?? true;
        return (
          <li
            key={rowKey}
            className={(isInitial ? "" : "tape-row ") + "grid grid-cols-[8px_56px_38px_44px_1fr_64px_30px] gap-1.5 items-center px-2 py-[2px] border-b border-[var(--color-border)] ck-hoverable"}
          >
            <span
              className={
                "inline-block w-[5px] h-[5px] " +
                (isResolved
                  ? evt.outcome === "win"
                    ? "bg-[var(--color-success)]"
                    : evt.outcome === "loss"
                      ? "bg-[var(--color-accent)]"
                      : "bg-[var(--color-disabled)]"
                  : "bg-[var(--color-display)]")
              }
            />
            <span className="ck-mono ck-dim">{ts}</span>
            <span className="ck-label">
              {isResolved ? "res" : "acc"}
            </span>
            <span className="ck-mono ck-dim">
              {evt.type === "call.accepted"
                ? "sealed"
                : (evt.outcome ?? "—").slice(0, 4)}
            </span>
            <a
              href={`#/agents/${evt.agent_slug}`}
              className="ck-mono ck-pos truncate no-underline"
              title={evt.agent_slug}
            >
              {evt.agent_slug}
            </a>
            <span className="ck-mono ck-dim text-right truncate">
              {evt.type === "call.accepted"
                ? "blind"
                : evt.call_score !== null && evt.call_score !== undefined
                  ? formatScore(evt.call_score)
                  : "—"}
            </span>
            <VerifyCallLink callId={evt.call_id} />
          </li>
        );
      })}
    </ul>
  );
}

function FeedSkeleton() {
  // Hairline skeleton matching the row grid. No spinner per DESIGN.md §10.
  return (
    <ul className="m-0 p-0 list-none">
      {[0, 1, 2, 3, 4].map((i) => (
        <li
          key={i}
          className="grid grid-cols-[8px_56px_38px_44px_1fr_64px_30px] gap-1.5 items-center px-2 py-[2px] border-b border-[var(--color-border)]"
        >
          <span className="inline-block w-[5px] h-[5px] bg-[var(--color-border)]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[44px]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[24px]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[32px]" />
          <div className="h-[10px] bg-[var(--color-border)] w-[70%]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[44px] justify-self-end" />
          <div className="h-[8px] bg-[var(--color-border)] w-[18px] justify-self-end" />
        </li>
      ))}
    </ul>
  );
}

function VerifyCallLink({ callId }: { callId: string }) {
  const shortId = callId.slice(0, 8);
  return (
    <a
      href={`#/calls/${callId}`}
      aria-label={`open call detail ${shortId}`}
      className={
        "t-meta ck-mono justify-self-end inline-flex items-center border border-[var(--color-border-vis)] px-1 py-[5px] " +
        "text-[10px] leading-[14px] text-[var(--color-secondary)] no-underline " +
        "hover:bg-[var(--color-display)] hover:text-[var(--color-bg)] " +
        "hover:border-[var(--color-display)]"
      }
    >
      [V]
    </a>
  );
}
