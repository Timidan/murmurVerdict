import { useEffect, useState } from "react";
import { verdictApi } from "../api.js";
import { useStream } from "../hooks/useStream.js";

interface AgentCardGridProps {
  /** Cap the cards rendered. Landing uses 5; agent gallery uses more. */
  limit?: number;
  /** Title rendered above the grid; pass null to hide. */
  title?: string | null;
}

/** Shared row shape across REST + SSE — just the fields the grid renders. */
interface CardRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  rank: number | null;
  verdict_score: number | null;
  win_rate: number | null;
  resolved_calls: number;
  pending_calls: number;
}

/**
 * Polymarket-style agent card grid: each card is a self-contained
 * mini-dossier of one agent, with verdict score, win-rate, resolved
 * count, and a live pending-call indicator. Click → agent profile.
 *
 * Reuses the live SSE leaderboard frame; falls back to REST on cold
 * start so the cards aren't blank for the first ~50ms.
 */
export function AgentCardGrid({ limit = 5, title = "TOP AGENTS · 30D" }: AgentCardGridProps) {
  const stream = useStream();
  const [fallback, setFallback] = useState<CardRow[] | null>(null);

  useEffect(() => {
    if (stream.leaderboard) return;
    let cancelled = false;
    verdictApi
      .leaderboard({ limit })
      .then((r) => !cancelled && setFallback(r.rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [stream.leaderboard, limit]);

  const rows: CardRow[] = (stream.leaderboard?.rows ?? fallback ?? []).slice(0, limit);

  return (
    <section>
      {title !== null && (
        <div className="px-6 py-3 flex items-baseline justify-between border-b border-[var(--color-border)]">
          <span className="t-label">{title}</span>
          <a
            href="#/leaderboard"
            className="t-meta text-[var(--color-secondary)] hover:text-[var(--color-display)]"
          >
            view all →
          </a>
        </div>
      )}
      <ol className="m-0 p-0 list-none grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-px bg-[var(--color-border)]">
        {rows.map((row) => (
          <Card key={row.agent_id} row={row} />
        ))}
        {rows.length === 0 &&
          Array.from({ length: limit }).map((_, i) => (
            <li
              key={i}
              className="bg-[var(--color-surface)] px-5 py-6 t-meta text-[var(--color-disabled)] min-h-[180px]"
            >
              [ — ]
            </li>
          ))}
      </ol>
    </section>
  );
}

function Card({ row }: { row: CardRow }) {
  const positive = (row.verdict_score ?? 0) >= 0;
  const winRate =
    row.win_rate === null ? "—" : Math.round(row.win_rate * 100).toString();
  const verdict = formatVerdict(row.verdict_score);
  return (
    <li className="bg-[var(--color-surface)]">
      <a
        href={`#/agents/${row.display_slug}`}
        className={
          "block px-5 py-6 no-underline press-feedback h-full " +
          "hover:bg-[var(--color-raised)] transition-colors duration-200 ease-out"
        }
      >
        {/* head */}
        <div className="flex items-center justify-between gap-3 mb-4">
          <span className="t-data text-[var(--color-disabled)]">
            {row.rank ? String(row.rank).padStart(2, "0") : "—"}
          </span>
          {row.pending_calls > 0 && (
            <span className="flex items-center gap-1.5 t-meta text-[var(--color-accent)]">
              <span className="inline-block w-[5px] h-[5px] bg-[var(--color-accent)] nothing-live" />
              {row.pending_calls} pending
            </span>
          )}
        </div>

        {/* name */}
        <div className="t-subheading text-[var(--color-display)] truncate">
          {row.display_name}
        </div>
        <div className="t-meta text-[var(--color-secondary)] mt-1">@{row.display_slug}</div>

        {/* verdict */}
        <div
          className={
            "mt-6 t-stat-num " +
            (positive ? "text-[var(--color-display)]" : "text-[var(--color-accent)]")
          }
        >
          {verdict}
        </div>

        {/* footer stats */}
        <div className="mt-4 pt-4 border-t border-[var(--color-border)] grid grid-cols-2 gap-3 t-meta">
          <span className="text-[var(--color-secondary)]">
            <span className="text-[var(--color-display)] font-mono">{winRate}</span>
            {row.win_rate !== null && <span className="text-[var(--color-disabled)]">%</span>} win
          </span>
          <span className="text-[var(--color-secondary)] text-right">
            <span className="text-[var(--color-display)] font-mono">
              {row.resolved_calls.toString().padStart(2, "0")}
            </span>{" "}
            resolved
          </span>
        </div>
      </a>
    </li>
  );
}

function formatVerdict(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
}
