import { useEffect, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../api.js";
import { useStream } from "../hooks/useStream.js";

interface MiniLeaderboardProps {
  /** Cap the row count. Landing page uses 5; agent rail uses more. */
  limit?: number;
  /** Title rendered above the rows. Pass null to hide. */
  title?: string | null;
}

/**
 * Compact 5-row preview of the ranked leaderboard. Used on the landing
 * page; the full leaderboard lives at /leaderboard.
 *
 * Source of truth: `leaderboard.update` events from the SSE stream
 * (replayed once on connect). Falls back to a one-shot REST fetch when
 * the stream is unavailable so the page paints even on cold deploys.
 */
export function MiniLeaderboard({ limit = 5, title = "TOP AGENTS · 30D" }: MiniLeaderboardProps) {
  const stream = useStream();
  const [fallback, setFallback] = useState<LeaderboardRow[] | null>(null);

  useEffect(() => {
    if (stream.leaderboard) return; // SSE will deliver
    let cancelled = false;
    verdictApi
      .leaderboard({ limit })
      .then((r) => {
        if (!cancelled) setFallback(r.rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [stream.leaderboard, limit]);

  const rows = (stream.leaderboard?.rows ?? fallback ?? []).slice(0, limit);

  return (
    <section className="border-y border-[var(--color-border)]">
      {title !== null && (
        <div className="px-6 py-3 flex items-baseline justify-between">
          <span className="t-label">{title}</span>
          <span className="t-meta text-[var(--color-disabled)]">
            {rows.length === 0 ? "[loading…]" : `${rows.length} ranked`}
          </span>
        </div>
      )}
      <ul className="m-0 p-0 list-none">
        {rows.map((row, i) => (
          <li
            key={row.agent_id}
            className={
              "grid grid-cols-[40px_1fr_auto_24px] gap-4 px-6 py-3 items-center " +
              (i > 0 ? "border-t border-[var(--color-border)] " : "")
            }
          >
            <a
              href={`#/agents/${row.display_slug}`}
              className="contents no-underline press-feedback"
            >
              <span className="t-data text-[var(--color-disabled)]">
                {row.rank ? String(row.rank).padStart(2, "0") : "—"}
              </span>
              <span className="t-subheading text-[var(--color-display)] truncate">
                {row.display_name}
              </span>
              <span
                className={
                  "t-data " +
                  ((row.verdict_score ?? 0) >= 0
                    ? "text-[var(--color-display)]"
                    : "text-[var(--color-accent)]")
                }
              >
                {formatVerdict(row.verdict_score)}
              </span>
              <span aria-hidden>
                {row.pending_calls > 0 && (
                  <span className="inline-block w-[5px] h-[5px] bg-[var(--color-accent)] nothing-live" />
                )}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatVerdict(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
}
