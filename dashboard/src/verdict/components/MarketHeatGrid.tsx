import { useEffect, useState } from "react";
import { fetchAgentGrid, type AgentMarketRow } from "../api.js";

interface MarketHeatGridProps {
  /** Display slug of the agent. */
  slug: string;
}

/**
 * Per-agent heat grid — one cell per market the agent has touched.
 * Cell shows market_id + verdict_score + resolved_calls badge + a
 * main-tier indicator (filled square) when the agent has crossed the
 * 20-resolved-calls threshold on that market.
 *
 * Degrades gracefully when the daemon is offline — renders a one-line
 * placeholder, never crashes.
 */
export function MarketHeatGrid({ slug }: MarketHeatGridProps) {
  const [grid, setGrid] = useState<AgentMarketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    fetchAgentGrid(slug)
      .then((r) => {
        if (cancel) return;
        setGrid(r.grid);
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  return (
    <section className="px-6 md:px-10 py-10 border-t border-[var(--color-border)]">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <p className="t-label text-[var(--color-secondary)] mb-2">market grid</p>
          <h2 className="t-subheading">
            Per-market <span className="text-[var(--color-display)]">verdict</span>.
          </h2>
        </div>
        <span className="t-meta text-[var(--color-disabled)]">
          {grid ? `${grid.length} markets` : loading ? "[loading…]" : ""}
        </span>
      </div>

      {error && (
        <div className="border border-[var(--color-border)] px-4 py-3 t-body-sm text-[var(--color-disabled)]">
          no market grid available · {error}
        </div>
      )}

      {!error && grid && grid.length === 0 && (
        <div className="border border-[var(--color-border)] px-4 py-3 t-body-sm text-[var(--color-disabled)]">
          no per-market activity yet.
        </div>
      )}

      {!error && grid && grid.length > 0 && (
        <ul className="m-0 p-0 list-none grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-px bg-[var(--color-border)] border border-[var(--color-border)]">
          {grid.map((cell) => (
            <li
              key={cell.market_id}
              className="bg-[var(--color-bg)] px-4 py-3 flex flex-col gap-2 min-h-[88px]"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="t-data text-[var(--color-display)] truncate">
                  {cell.market_id}
                </span>
                <span
                  aria-label={
                    cell.market_main_tier ? "main tier" : "provisional"
                  }
                  title={
                    cell.market_main_tier
                      ? "main tier · 20+ resolved calls"
                      : "provisional · <20 resolved"
                  }
                  className={
                    "inline-block w-[7px] h-[7px] " +
                    (cell.market_main_tier
                      ? "bg-[var(--color-display)]"
                      : "border border-[var(--color-border-vis)]")
                  }
                />
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={
                    "t-stat-num " +
                    ((cell.verdict_score ?? 0) >= 0
                      ? "text-[var(--color-display)]"
                      : "text-[var(--color-accent)]")
                  }
                >
                  {formatVerdict(cell.verdict_score)}
                </span>
                <span className="t-meta text-[var(--color-secondary)]">
                  {cell.resolved_calls.toString().padStart(2, "0")}
                  <span className="text-[var(--color-disabled)]"> resolved</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatVerdict(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
}
