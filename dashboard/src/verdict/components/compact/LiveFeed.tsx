import { useStream } from "../../hooks/useStream.js";

/**
 * COMPACT live tape — terminal-style scroll of accepted/resolved events.
 * One row per event, single line, monospace, dot prefix for outcome.
 */
export function CompactLiveFeed({ limit = 40 }: { limit?: number }) {
  const { recentCalls } = useStream();
  const rows = recentCalls.slice(0, limit);

  if (rows.length === 0) {
    return <FeedSkeleton />;
  }

  return (
    <ul className="m-0 p-0 list-none">
      {rows.map((evt) => {
        const isResolved = evt.type === "call.resolved";
        const ts = (isResolved ? evt.resolved_at : evt.accepted_at).slice(11, 19);
        return (
          <li
            key={evt.call_id + (isResolved ? "r" : "a")}
            className="tape-row grid grid-cols-[8px_56px_38px_44px_1fr_64px_30px] gap-1.5 items-center px-2 py-[2px] border-b border-[var(--color-border)] hover:bg-[white]/[0.03]"
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
                  : "bg-[var(--color-display)] ck-dot-live")
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
      aria-label={`verify call ${shortId}`}
      className={
        "t-meta ck-mono justify-self-end border border-[var(--color-border-vis)] px-1 " +
        "text-[9px] leading-[14px] text-[var(--color-secondary)] no-underline " +
        "hover:bg-[var(--color-display)] hover:text-[var(--color-bg)] " +
        "hover:border-[var(--color-display)]"
      }
    >
      [V]
    </a>
  );
}

function formatScore(s: number): string {
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.abs(s).toFixed(3)}`;
}
