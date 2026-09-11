import { useEffect, useRef, useState } from "react";
import { useStream } from "../../hooks/useStream.js";
import { Ik } from "../../icons.js";
import { formatScore } from "../../lib/score-format.js";
import { SkeletonBar } from "./PanelSkeleton.js";
import { TimeAgo } from "./TimeAgo.js";

/**
 * The public outcome, in words. Slicing the raw enum to four characters used
 * to render `oracle_unavailable` as "orac"; the retired price-feed wording is
 * replaced by what the reader needs — no outcome landed.
 */
const OUTCOME_TEXT: Record<string, string> = {
  win: "win",
  loss: "loss",
  void: "void",
  oracle_unavailable: "no outcome",
};

function outcomeWord(outcome: string | null | undefined): string {
  if (!outcome) return "—";
  return OUTCOME_TEXT[outcome] ?? outcome.replace(/_/g, " ");
}

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
        <div className="px-2 py-2 ck-mono ck-dim">
          [no calls on this market have arrived in the live stream]
        </div>
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
            [reconnecting to the live stream…]
          </div>
        );
      }
      // An empty state on the landing page's own tape is the first thing a
      // first-time reader sees, and "[no activity yet]" alone leaves them with
      // nowhere to go — the panel is a full-height empty column on a desktop.
      // Say what fills it, and offer the one action that does.
      return (
        <div className="px-2 py-2 ck-mono ck-dim flex flex-col items-start gap-1.5">
          <span>[no calls have arrived in the live stream yet]</span>
          <span className="max-w-[42ch] leading-tight">
            This tape carries what happens while you watch. Every sealed call
            lands here the moment murmur accepts it, and again when the venue
            settles it.
          </span>
          <a href="#/install" className="ck-btn ck-btn-bracket">
            connect an agent →
          </a>
        </div>
      );
    }
    return <FeedSkeleton />;
  }

  return (
    <ul role="log" aria-relevant="additions" className="m-0 p-0 list-none">
      {rows.map((evt) => {
        const isResolved = evt.type === "call.resolved";
        const rowKey = evt.call_id + (isResolved ? "r" : "a");
        const isInitial = initialKeys.current?.has(rowKey) ?? true;
        return (
          <li
            key={rowKey}
            className={(isInitial ? "" : "tape-row ") + "ck-tape px-2 py-[2px] border-b border-[var(--color-border)] ck-hoverable"}
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
            <TimeAgo
              iso={isResolved ? evt.resolved_at : evt.accepted_at}
              className="ck-mono ck-dim truncate"
            />
            {/* The event kind was "acc" / "res" — two three-letter tokens the
                reader had to decode. The glyphs are the ones the panel titles
                already use for the same two ideas, and the accessible name
                carries the word. */}
            <span
              className="inline-flex items-center ck-dim ck-ladder-drop"
              title={isResolved ? "scored" : "sealed"}
            >
              <Ik name={isResolved ? "resolve" : "seal"} />
              <span className="sr-only">{isResolved ? "scored" : "sealed"}</span>
            </span>
            {/* Tone follows the OUTCOME, matching the call history's rule:
                right is green, wrong is red, the word carries the meaning and
                the colour only reinforces. Sealed rows stay dim. */}
            <span
              className={
                "ck-mono truncate " +
                (evt.type === "call.accepted"
                  ? "ck-dim"
                  : evt.outcome === "win"
                    ? "text-[var(--color-success)]"
                    : evt.outcome === "loss"
                      ? "ck-neg"
                      : "ck-dim")
              }
            >
              {evt.type === "call.accepted" ? "sealed" : outcomeWord(evt.outcome)}
            </span>
            <a
              href={`#/agents/${evt.agent_slug}`}
              className="ck-mono ck-pos truncate no-underline"
              title={evt.agent_slug}
            >
              {evt.agent_slug}
            </a>
            <span
              className={
                "ck-mono text-right truncate " +
                (evt.type !== "call.accepted" && evt.outcome === "win"
                  ? "text-[var(--color-success)]"
                  : evt.type !== "call.accepted" && evt.outcome === "loss"
                    ? "ck-neg"
                    : "ck-dim")
              }
            >
              {evt.type === "call.accepted"
                ? "sealed"
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
          className="ck-tape px-2 py-[2px] border-b border-[var(--color-border)]"
        >
          <span className="inline-block w-[5px] h-[5px] bg-[var(--color-border)]" />
          <SkeletonBar className="h-[8px] w-[44px]" />
          <SkeletonBar className="h-[8px] w-[24px] ck-ladder-drop" />
          <SkeletonBar className="h-[8px] w-[32px]" />
          <SkeletonBar className="h-[10px] w-[70%]" />
          <SkeletonBar className="h-[8px] w-[44px] justify-self-end" />
          <SkeletonBar className="h-[8px] w-[18px] justify-self-end" />
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
        "t-meta justify-self-end inline-flex items-center border border-[var(--color-border-vis)] px-1 py-[5px] " +
        "text-[12px] leading-[14px] text-[var(--color-secondary)] no-underline " +
        "hover:bg-[var(--color-display)] hover:text-[var(--color-bg)] " +
        "hover:border-[var(--color-display)]"
      }
    >
      [V]
    </a>
  );
}
