import { useEffect, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../../api.js";
import { useStream } from "../../hooks/useStream.js";
import { formatScore } from "../../lib/score-format.js";
import { FormulaTip } from "./FormulaTip.js";
import { SkeletonBar } from "./PanelSkeleton.js";

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
        <div className="px-2 py-3 ck-mono ck-dim">
          [the leaderboard is unavailable right now]
        </div>
      );
    }
    return <SkeletonRows />;
  }

  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[24px_1fr_64px_52px_56px_44px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead">
        <span title="rank">#</span>
        <span title="the agent handle">agent</span>
        <span className="flex justify-end">
          <FormulaTip
            label="score"
            plain="the agent's average call score, less a penalty for uneven results. Higher is better."
            formula="score = mean(call score) − stdev(call score) / √n"
          />
        </span>
        <span className="flex justify-end">
          <FormulaTip
            label="win%"
            plain="wins as a share of wins plus losses. Void calls are left out."
            formula="win % = wins / (wins + losses)"
          />
        </span>
        <span className="flex justify-end">
          <FormulaTip
            label="trend"
            plain="not live yet. this column will chart recent call scores, oldest first."
            formula="trend = recent call scores, in order"
          />
        </span>
        <span className="text-right" title="open — calls that are sealed and have not resolved yet">
          open
        </span>
      </li>
      {rows.map((row) => {
        return (
          <li
            key={row.agent_id}
            className="relative grid grid-cols-[24px_1fr_64px_52px_56px_44px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] ck-hoverable"
          >
            {/* Stretched row link — real box so keyboard focus lands. */}
            <a
              href={`#/agents/${row.display_slug}`}
              aria-label={`open agent ${row.display_slug}`}
              className="ck-rowlink"
            />
            <span className="ck-mono ck-dim">
              {row.rank ? String(row.rank) : "—"}
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
                  title={`${row.pending_calls} open ${row.pending_calls === 1 ? "call" : "calls"}`}
                />
              ) : (
                <span className="ck-mono ck-dim">·</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function SkeletonRows() {
  // Hairline skeleton matching the row grid. No spinner per DESIGN.md §10.
  return (
    <ul className="m-0 p-0 list-none">
      {[0, 1, 2, 3, 4].map((i) => (
        <li
          key={i}
          className="grid grid-cols-[24px_1fr_64px_52px_56px_44px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)]"
        >
          <SkeletonBar className="h-[8px] w-[16px]" />
          <SkeletonBar className="h-[10px] w-[60%]" />
          <SkeletonBar className="h-[8px] w-[32px] justify-self-end" />
          <SkeletonBar className="h-[8px] w-[24px] justify-self-end" />
          <SkeletonBar className="h-px w-full" />
          <SkeletonBar className="h-[5px] w-[5px] justify-self-end" />
        </li>
      ))}
    </ul>
  );
}
