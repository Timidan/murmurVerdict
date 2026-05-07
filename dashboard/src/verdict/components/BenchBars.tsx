import { useEffect, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../api.js";
import { useStream } from "../hooks/useStream.js";

interface BenchBarsProps {
  /** Title above the bars; pass null to hide. */
  title?: string | null;
}

/**
 * Bun-style horizontal-bar comparison: each top-5 agent rendered as a
 * fill bar against the highest absolute verdict score in the set. Bars
 * paint left-to-right via a width transition once the data lands —
 * functional motion (the bar IS the data), not decoration.
 */
export function BenchBars({ title = "TOP AGENTS · σ-units" }: BenchBarsProps) {
  const stream = useStream();
  const [fallback, setFallback] = useState<LeaderboardRow[] | null>(null);

  useEffect(() => {
    if (stream.leaderboard) return;
    let cancelled = false;
    verdictApi
      .leaderboard({ limit: 5 })
      .then((r) => !cancelled && setFallback(r.rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [stream.leaderboard]);

  const rows = (stream.leaderboard?.rows ?? fallback ?? []).slice(0, 5);
  const max = rows.reduce((m, r) => Math.max(m, Math.abs(r.verdict_score ?? 0)), 0) || 1;

  return (
    <section>
      {title !== null && <div className="t-label mb-4">{title}</div>}
      <ol className="m-0 p-0 list-none flex flex-col gap-3">
        {rows.length === 0 &&
          Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="grid grid-cols-[28px_minmax(0,1fr)_60px] items-center gap-3">
              <span className="t-data text-[var(--color-disabled)]">—</span>
              <span className="h-[10px] bg-[var(--color-border)]" />
              <span className="t-data text-right text-[var(--color-disabled)]">—</span>
            </li>
          ))}
        {rows.map((row) => {
          const v = row.verdict_score ?? 0;
          const pct = Math.max(2, Math.round((Math.abs(v) / max) * 100));
          const positive = v >= 0;
          return (
            <li
              key={row.agent_id}
              className="grid grid-cols-[28px_minmax(0,1fr)_70px] items-center gap-3"
            >
              <span className="t-data text-[var(--color-disabled)]">
                {row.rank ? String(row.rank).padStart(2, "0") : "—"}
              </span>
              <a
                href={`#/agents/${row.display_slug}`}
                className="relative block bg-[var(--color-border)] h-[10px] press-feedback group"
                aria-label={`${row.display_name} verdict ${formatVerdict(v)}`}
              >
                <span
                  className={
                    "block h-full transition-[width] duration-500 ease-out " +
                    (positive
                      ? "bg-[var(--color-display)]"
                      : "bg-[var(--color-accent)]")
                  }
                  style={{ width: `${pct}%` }}
                />
                <span
                  className={
                    "absolute -top-5 left-0 t-data text-[var(--color-display)] " +
                    "opacity-0 group-hover:opacity-100 transition-opacity duration-150 ease-out " +
                    "whitespace-nowrap"
                  }
                >
                  {row.display_name}
                </span>
              </a>
              <span
                className={
                  "t-data text-right " +
                  (positive ? "text-[var(--color-display)]" : "text-[var(--color-accent)]")
                }
              >
                {formatVerdict(v)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function formatVerdict(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
}
