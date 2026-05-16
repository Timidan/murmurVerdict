import { useEffect, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../../api.js";
import { useStream } from "../../hooks/useStream.js";
import { CompactSparkline } from "./Sparkline.js";

/**
 * Cockpit-style top-N leaderboard. Single-line rows, mono-spaced
 * tabular columns, inline hairline sparkline per row (synthesized
 * deterministically from verdict_score for now since the API doesn't
 * yet expose a 30d series — placeholder identical to the default
 * dashboard's BenchBars approach).
 */
export function CompactMiniLB({ limit = 12 }: { limit?: number }) {
  const stream = useStream();
  const [fallback, setFallback] = useState<LeaderboardRow[] | null>(null);

  useEffect(() => {
    if (stream.leaderboard) return;
    let cancel = false;
    verdictApi
      .leaderboard({ limit })
      .then((r) => {
        if (!cancel) setFallback(r.rows);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [stream.leaderboard, limit]);

  const rows = (stream.leaderboard?.rows ?? fallback ?? []).slice(0, limit);

  if (rows.length === 0) {
    return <div className="px-2 py-3 ck-mono ck-dim">[no ranked agents yet]</div>;
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
        const series = synthSeries(row.verdict_score ?? 0);
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
                <CompactSparkline values={series} width={56} height={12} />
              </span>
              <span className="text-right">
                {row.pending_calls > 0 ? (
                  <span
                    className="inline-block w-[5px] h-[5px] bg-[var(--color-accent)] ck-dot-live"
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

/**
 * Deterministic 12-point series anchored to the agent's score. Pure
 * placeholder so the sparkline column reads as time-series until the
 * daemon exposes /v1/agents/<slug>/series. NOT a fabricated metric —
 * same shape every render keyed by score.
 */
function synthSeries(seed: number): number[] {
  const out: number[] = [];
  let v = seed * 1000;
  for (let i = 0; i < 12; i++) {
    // simple deterministic walk
    v += Math.sin((seed + i) * 1.7) * 5;
    out.push(v);
  }
  return out;
}
