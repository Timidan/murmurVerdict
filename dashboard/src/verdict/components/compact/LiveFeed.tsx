import { useStream } from "../../hooks/useStream.js";

/**
 * COMPACT live tape — terminal-style scroll of accepted/resolved events.
 * One row per event, single line, monospace, dot prefix for outcome.
 */
export function CompactLiveFeed({ limit = 40 }: { limit?: number }) {
  const { recentCalls } = useStream();
  const rows = recentCalls.slice(0, limit);

  if (rows.length === 0) {
    return (
      <div className="px-2 py-3 ck-mono ck-dim">[awaiting events...]</div>
    );
  }

  return (
    <ul className="m-0 p-0 list-none">
      {rows.map((evt) => {
        const isResolved = evt.type === "call.resolved";
        const ts = (isResolved ? evt.resolved_at : evt.accepted_at).slice(11, 19);
        return (
          <li
            key={evt.call_id + (isResolved ? "r" : "a")}
            className="grid grid-cols-[8px_56px_38px_44px_1fr_64px] gap-1.5 items-center px-2 py-[2px] border-b border-[var(--color-border)] hover:bg-[white]/[0.03]"
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
              {isResolved ? "RES" : "ACC"}
            </span>
            <span
              className={
                "ck-mono " +
                (evt.type === "call.accepted"
                  ? evt.side === "SELL"
                    ? "ck-neg"
                    : "ck-pos"
                  : "ck-dim")
              }
            >
              {evt.type === "call.accepted"
                ? (evt.side ?? "HASH")
                : (evt.outcome ?? "—").toUpperCase().slice(0, 4)}
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
                ? (evt.asset_id?.split(":").pop() ?? "—")
                : evt.call_score !== null && evt.call_score !== undefined
                  ? formatScore(evt.call_score)
                  : "—"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function formatScore(s: number): string {
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.abs(s).toFixed(3)}`;
}
