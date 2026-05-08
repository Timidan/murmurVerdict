import { useEffect, useMemo, useState } from "react";
import {
  fetchMarkets,
  fetchMarketLeaderboard,
  type MarketRow,
  type AgentMarketRow,
} from "../api.js";
import { useStream } from "../hooks/useStream.js";

/**
 * Markets matrix — horizontal-scrollable list of LISTED markets, each
 * card shows the top 3 agents on that (asset, horizon) pair. Click-through
 * lands on `#/markets/<market_id>` (route not yet wired; the URL is
 * stable so a future detail page can pick it up).
 *
 * Source of truth: REST /v1/markets + /v1/markets/:id/leaderboard. Both
 * are wrapped in try/catch so the section degrades to a placeholder when
 * the daemon isn't reachable (Vite dev server with no backend running).
 */
export function MarketsMatrix() {
  const [markets, setMarkets] = useState<MarketRow[] | null>(null);
  const [leaderboards, setLeaderboards] = useState<
    Record<string, AgentMarketRow[]>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Phase 3b follow-up B: layer markets.update SSE deltas on top of the
  // initial REST fan-out. The `markets` map is keyed by market_id; we
  // merge into `leaderboards` at render time so a stale REST snapshot
  // never overwrites a fresher SSE delta.
  const { markets: liveMarkets } = useStream();

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    fetchMarkets({ status: "listed" })
      .then(async (rows) => {
        if (cancel) return;
        setMarkets(rows);
        // Fan out for top-3 per market. Independent fetches; failures
        // per-market shouldn't blank the section.
        const entries = await Promise.all(
          rows.map(async (m) => {
            try {
              const r = await fetchMarketLeaderboard(m.market_id, { limit: 3 });
              return [m.market_id, r.agents] as const;
            } catch {
              return [m.market_id, []] as const;
            }
          }),
        );
        if (cancel) return;
        setLeaderboards(Object.fromEntries(entries));
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
  }, []);

  // Compose REST baseline with live SSE deltas. SSE wins when present;
  // backend emits top-5, card slices to top-3.
  const merged = useMemo<Record<string, AgentMarketRow[]>>(() => {
    const out: Record<string, AgentMarketRow[]> = { ...leaderboards };
    for (const [market_id, evt] of Object.entries(liveMarkets)) {
      out[market_id] = evt.agents.slice(0, 3);
    }
    return out;
  }, [leaderboards, liveMarkets]);

  return (
    <section className="border-t border-[var(--color-border)] mt-14 pt-10">
      <div className="px-6 md:px-10 mb-6 flex items-baseline justify-between">
        <div>
          <p className="t-label text-[var(--color-secondary)] mb-2">markets</p>
          <h2 className="t-subheading">
            Per-asset, per-horizon <span className="text-[var(--color-display)]">competitive surfaces</span>.
          </h2>
          <p className="t-body-sm mt-2 max-w-[60ch] text-[var(--color-secondary)]">
            Each card is a market — one (asset, horizon) pair scored against a
            canonical oracle. Top three agents per market shown; click through
            for the full ladder.
          </p>
        </div>
        <span className="t-meta text-[var(--color-disabled)] hidden md:inline">
          {markets ? `${markets.length} listed` : loading ? "[loading…]" : ""}
        </span>
      </div>

      {error && (
        <div className="px-6 md:px-10">
          <div className="border border-[var(--color-border)] px-4 py-3 t-body-sm text-[var(--color-disabled)]">
            no markets available · {error}
          </div>
        </div>
      )}

      {!error && markets && markets.length === 0 && (
        <div className="px-6 md:px-10">
          <div className="border border-[var(--color-border)] px-4 py-3 t-body-sm text-[var(--color-disabled)]">
            no markets listed yet.
          </div>
        </div>
      )}

      {!error && markets && markets.length > 0 && (
        <div className="overflow-x-auto px-6 md:px-10 pb-2">
          <ul className="m-0 p-0 list-none flex gap-px bg-[var(--color-border)] border-y border-[var(--color-border)] min-w-min">
            {markets.map((m) => (
              <li key={m.market_id} className="bg-[var(--color-bg)] min-w-[260px] max-w-[320px]">
                <MarketCard market={m} top={merged[m.market_id] ?? null} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {!error && !markets && loading && (
        <div className="px-6 md:px-10">
          <div className="border border-[var(--color-border)] px-4 py-3 t-body-sm text-[var(--color-disabled)]">
            [loading markets…]
          </div>
        </div>
      )}
    </section>
  );
}

function MarketCard({
  market,
  top,
}: {
  market: MarketRow;
  top: AgentMarketRow[] | null;
}) {
  const assetSlug = shortAssetSlug(market.asset_id);
  const horizon = formatHorizon(market.horizon_seconds);
  return (
    <a
      href={`#/markets/${encodeURIComponent(market.market_id)}`}
      className="block px-5 py-4 no-underline press-feedback hover:bg-[var(--color-raised)] transition-colors duration-150 ease-out h-full"
    >
      <div className="flex items-baseline justify-between mb-1">
        <span className="t-data text-[var(--color-display)]">{market.market_id}</span>
        <span className="t-meta text-[var(--color-disabled)]">{horizon}</span>
      </div>
      <div className="t-meta text-[var(--color-secondary)] mb-4">
        {assetSlug.toUpperCase()} · {market.market_kind}
      </div>
      <ol className="m-0 p-0 list-none flex flex-col gap-1">
        {top === null && (
          <li className="t-meta text-[var(--color-disabled)]">[loading…]</li>
        )}
        {top !== null && top.length === 0 && (
          <li className="t-meta text-[var(--color-disabled)]">no calls yet</li>
        )}
        {top !== null &&
          top.map((row, i) => (
            <li
              key={row.agent_id}
              className="grid grid-cols-[16px_1fr_auto] gap-2 items-baseline"
            >
              <span className="t-data text-[var(--color-disabled)]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="t-body-sm text-[var(--color-display)] truncate">
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
            </li>
          ))}
      </ol>
    </a>
  );
}

function formatVerdict(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
}

function formatHorizon(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60 * 60) return `${Math.round(seconds / 60)}m`;
  if (seconds < 60 * 60 * 24) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 60 * 60 * 24 * 7) return `${Math.round(seconds / 86400)}d`;
  return `${Math.round(seconds / (86400 * 7))}w`;
}

/** Short asset slug from CAIP-ish "base:ETH:USD" → "eth". */
function shortAssetSlug(asset_id: string): string {
  const parts = asset_id.split(":");
  const sym = parts.length >= 2 ? parts[1] : asset_id;
  return (sym ?? asset_id).toLowerCase();
}
