import { useEffect, useRef, useState } from "react";
import { useStream } from "../../hooks/useStream.js";
import { Ik } from "../../icons.js";
import { formatScore } from "../../lib/score-format.js";
import { isPlainLeftClick, useDetailDrawer } from "./DetailDrawer.js";
import { SkeletonBar } from "./PanelSkeleton.js";
import { TimeAgo, useNowMs } from "./TimeAgo.js";
import { tapeRows } from "../../lib/live-tape.js";

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
 * COMPACT live tape — terminal-style scroll of recent calls.
 *
 * One row per CALL, not per event. The stream emits a call twice — once when
 * murmur seals it and again when the venue settles it — and rendering both
 * put every call on the tape two times, as `sealed` and then as its outcome.
 * The resolved event supersedes the sealed one in place, so a row goes from
 * `sealed` to `win` without moving.
 *
 * Bounded by time, not count: the last 24h, then one terminator line saying
 * how many earlier calls the stream still holds. `limit` stays as a ceiling
 * inside the window so a burst cannot make the panel unbounded either.
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

  // One row per call, last 24h, `limit` as a ceiling inside that. The shared
  // 30s ticker slides the window without a second timer. See lib/live-tape.ts.
  const nowMs = useNowMs();
  const { rows, older, overflow } = tapeRows(scoped, nowMs, limit);
  const recent = { length: rows.length + overflow };

  // tape-row-enter is for genuinely-new calls only: latch the keys present in
  // the first non-empty batch so first paint / remounts render still and only
  // calls that arrive later slide in (plans/003). Keyed by call, so a row
  // resolving in place is an update, not an entrance.
  const initialKeys = useRef<Set<string> | null>(null);
  if (initialKeys.current === null && rows.length > 0) {
    initialKeys.current = new Set(rows.map((evt) => evt.call_id));
  }

  if (rows.length === 0) {
    // Market-scoped tape with a live-but-nonmatching stream is a real empty
    // state, not a loading placeholder — say so immediately.
    if (marketId && recentCalls.length > 0) {
      return (
        <div className="px-2 py-2 ck-mono ck-empty">
          No calls on this market in the last 24h
        </div>
      );
    }
    // Calls exist, all older than the window. Say so rather than showing the
    // connect-an-agent onboarding to a deployment that plainly has agents.
    if (older > 0) {
      return (
        <div className="px-2 py-2 ck-mono ck-empty">
          Nothing in the last 24h · {older} earlier call{older === 1 ? "" : "s"}
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
          <div className="px-2 py-2 ck-mono ck-empty">
            Reconnecting to the live stream…
          </div>
        );
      }
      // The first thing a first-time reader sees, so the bare line gets a
      // sentence saying what fills the tape and the one action that does.
      return (
        <div className="px-2 py-2 ck-mono ck-dim flex flex-col items-start gap-1.5">
          <span className="ck-empty">No recent calls yet</span>
          <span className="max-w-[42ch] leading-tight">
            This tape shows recent calls and updates live. Every sealed call
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
    <>
    <ul role="log" aria-relevant="additions" className="m-0 p-0 list-none">
      {rows.map((evt) => {
        const isResolved = evt.type === "call.resolved";
        const rowKey = evt.call_id;
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
    {/* The tape ENDS, and says why. A list that just stops is
        indistinguishable from one that is still loading or was cut. */}
    {(older > 0 || overflow > 0) && (
      <p className="px-2 py-1.5 m-0 ck-mono ck-dim border-b border-[var(--color-border)]">
        {overflow > 0
          ? `showing ${rows.length} of ${recent.length} in the last 24h`
          : "nothing older than 24h shown"}
        {older > 0 ? ` · ${older} earlier call${older === 1 ? "" : "s"}` : ""}
      </p>
    )}
    </>
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

/**
 * The [V] chip. A plain left-click opens the call in the shared detail drawer
 * over the tape, so reading the feed never costs the page you were on; the href
 * stays the canonical permalink, so modifier and middle clicks, Copy Link, and
 * keyboard Enter all still reach the full page.
 */
function VerifyCallLink({ callId }: { callId: string }) {
  const { open } = useDetailDrawer();
  const shortId = callId.slice(0, 8);
  return (
    <a
      href={`#/calls/${callId}`}
      aria-label={`open call detail ${shortId}`}
      onClick={(e) => {
        if (isPlainLeftClick(e)) {
          e.preventDefault();
          open("call", callId);
        }
      }}
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
