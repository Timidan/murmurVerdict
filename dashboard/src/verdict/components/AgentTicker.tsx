import { useEffect, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../api.js";
import { useStream } from "../hooks/useStream.js";
import { Sparkline } from "./Sparkline.js";

/**
 * TradingView-style multi-asset ribbon, but for agents. One horizontally
 * scrolling row that shows: rank · agent · verdict · per-agent sparkline ·
 * pending dot. Updates from the SSE leaderboard frame; sparkline values
 * come from this tab's recent-call buffer plus a cold-start REST fetch.
 */
export function AgentTicker() {
  const stream = useStream();
  const [fallback, setFallback] = useState<LeaderboardRow[] | null>(null);
  const [history, setHistory] = useState<Record<string, number[]>>({});

  // Cold start: snapshot top 5 from REST until SSE delivers leaderboard.update.
  useEffect(() => {
    if (stream.leaderboard) return;
    let cancelled = false;
    verdictApi
      .leaderboard({ limit: 5 })
      .then((r) => {
        if (!cancelled) setFallback(r.rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [stream.leaderboard]);

  const rows = (stream.leaderboard?.rows ?? fallback ?? []).slice(0, 5);

  // Cold start: pull each agent's last 8 call scores so sparklines aren't blank.
  useEffect(() => {
    rows.forEach((row) => {
      if (history[row.display_slug]) return;
      verdictApi
        .agentCalls(row.display_slug, 8)
        .then((r) => {
          const series = r.calls
            .map((c) => (c.signed_return ? Number(c.signed_return) : null))
            .filter((v): v is number => v !== null && !Number.isNaN(v))
            .reverse();
          setHistory((h) => ({ ...h, [row.display_slug]: series }));
        })
        .catch(() => {});
    });
  }, [rows]);

  // SSE: append new resolved-call values to the right agent's series.
  useEffect(() => {
    const event = stream.recentCalls[0];
    if (!event || event.type !== "call.resolved") return;
    const ret = event.signed_return ? Number(event.signed_return) : null;
    if (ret === null || Number.isNaN(ret)) return;
    setHistory((h) => {
      const prev = h[event.agent_slug] ?? [];
      return { ...h, [event.agent_slug]: [...prev.slice(-7), ret] };
    });
  }, [stream.recentCalls]);

  if (rows.length === 0) {
    return (
      <div className="border-y border-[var(--color-border)] px-6 py-3 t-meta text-[var(--color-disabled)]">
        ticker · awaiting data
      </div>
    );
  }

  return (
    <div className="border-y border-[var(--color-border)] overflow-x-auto">
      <ol className="m-0 p-0 list-none flex items-center gap-px bg-[var(--color-border)] min-w-full">
        {rows.map((row) => (
          <li
            key={row.agent_id}
            className="flex-1 min-w-[200px] bg-[var(--color-bg)] px-5 py-3"
          >
            <a
              href={`#/agents/${row.display_slug}`}
              className="contents no-underline press-feedback"
            >
              <div className="flex items-center justify-between gap-3 mb-1">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="t-data text-[var(--color-disabled)]">
                    {row.rank ? String(row.rank).padStart(2, "0") : "—"}
                  </span>
                  <span className="t-subheading text-[var(--color-display)] truncate">
                    {row.display_name}
                  </span>
                </div>
                {row.pending_calls > 0 && (
                  <span aria-label={`${row.pending_calls} pending`} className="inline-block w-[5px] h-[5px] bg-[var(--color-accent)] nothing-live" />
                )}
              </div>
              <div className="flex items-center justify-between gap-3">
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
                <Sparkline values={history[row.display_slug] ?? []} />
              </div>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function formatVerdict(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
}
