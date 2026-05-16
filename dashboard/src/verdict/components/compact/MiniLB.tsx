import { useEffect, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../../api.js";
import { useStream } from "../../hooks/useStream.js";

/**
 * Cockpit-style top-N leaderboard. Single-line rows, mono-spaced
 * tabular columns. The "trend" column is reserved for a real per-agent
 * time-series once the daemon exposes /v1/agents/<slug>/series; until
 * then it renders as a hairline placeholder rather than a synthesized
 * shape, so the column never implies data we don't have.
 */
export function CompactMiniLB({ limit = 12 }: { limit?: number }) {
  const stream = useStream();
  const [fallback, setFallback] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    if (stream.leaderboard) return;
    let cancel = false;
    setError(false);
    verdictApi
      .leaderboard({ limit })
      .then((r) => {
        if (!cancel) setFallback(r.rows);
      })
      .catch(() => {
        if (!cancel) setError(true);
      });
    return () => {
      cancel = true;
    };
  }, [stream.leaderboard, limit]);

  const hasStream = Boolean(stream.leaderboard);
  const rows = (stream.leaderboard?.rows ?? fallback ?? []).slice(0, limit);

  if (rows.length === 0) {
    if (error && !hasStream) {
      return (
        <div className="px-2 py-3 ck-mono ck-dim">[feed unavailable]</div>
      );
    }
    return <SkeletonRows />;
  }

  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[24px_1fr_44px_38px_56px_28px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-label">
        <span>#</span>
        <span>agent</span>
        <span className="text-right">vs</span>
        <span className="text-right">wr</span>
        <span className="text-right">trend</span>
        <span className="text-right">p</span>
      </li>
      {rows.map((row) => {
        return (
          <li
            key={row.agent_id}
            className="grid grid-cols-[24px_1fr_44px_38px_56px_28px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] hover:bg-[white]/[0.03]"
          >
            <a
              href={`#/agents/${row.display_slug}`}
              className="contents no-underline"
            >
              <span className="ck-mono ck-dim">
                {row.rank ? String(row.rank).padStart(2, "0") : "—"}
              </span>
              <span className="ck-mono ck-pos truncate" title={row.display_name}>
                {row.display_slug}
              </span>
              <span
                className={
                  "ck-mono text-right " +
                  ((row.verdict_score ?? 0) >= 0 ? "ck-pos" : "ck-neg")
                }
              >
                {formatScore(row.verdict_score)}
              </span>
              <span className="ck-mono ck-dim text-right">
                {row.win_rate === null ? "—" : `${Math.round(row.win_rate * 100)}`}
              </span>
              <span className="flex justify-end items-center">
                <div className="h-px bg-[var(--color-border)] w-full" />
              </span>
              <span className="text-right">
                {row.pending_calls > 0 ? (
                  <span
                    className="inline-block w-[5px] h-[5px] bg-[var(--color-disabled)]"
                    title={`${row.pending_calls} pending`}
                  />
                ) : (
                  <span className="ck-mono ck-dim">·</span>
                )}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function formatScore(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
}

function SkeletonRows() {
  // Hairline skeleton matching the row grid. No spinner per DESIGN.md §10.
  return (
    <ul className="m-0 p-0 list-none">
      {[0, 1, 2, 3, 4].map((i) => (
        <li
          key={i}
          className="grid grid-cols-[24px_1fr_44px_38px_56px_28px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)]"
        >
          <div className="h-[8px] bg-[var(--color-border)] w-[16px]" />
          <div className="h-[10px] bg-[var(--color-border)] w-[60%]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[32px] justify-self-end" />
          <div className="h-[8px] bg-[var(--color-border)] w-[24px] justify-self-end" />
          <div className="h-px bg-[var(--color-border)] w-full" />
          <div className="h-[5px] w-[5px] bg-[var(--color-border)] justify-self-end" />
        </li>
      ))}
    </ul>
  );
}
