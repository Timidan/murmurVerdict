import { useEffect, useMemo, useState } from "react";
import {
  fetchMarkets,
  fetchMarketLeaderboard,
  type MarketRow,
  type AgentMarketRow,
} from "../../api.js";
import { useStream } from "../../hooks/useStream.js";

/**
 * Markets matrix — single dense table. One row per market, with the
 * top-3 agent slugs collapsed into a single mono cell so the operator
 * can scan the entire surface at a glance.
 */
export function CompactMarketsGrid({ limit }: { limit?: number }) {
  const [markets, setMarkets] = useState<MarketRow[] | null>(null);
  const [leaderboards, setLeaderboards] = useState<Record<string, AgentMarketRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const { markets: liveMarkets } = useStream();

  useEffect(() => {
    let cancel = false;
    setError(null);

    const fetchOnce = async (): Promise<MarketRow[]> => {
      try {
        return await fetchMarkets({ status: "listed" });
      } catch (firstErr) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (cancel) throw firstErr;
        return await fetchMarkets({ status: "listed" });
      }
    };

    fetchOnce()
      .then(async (rows) => {
        if (cancel) return;
        setMarkets(rows);
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
      });
    return () => {
      cancel = true;
    };
  }, []);

  const merged = useMemo<Record<string, AgentMarketRow[]>>(() => {
    const out: Record<string, AgentMarketRow[]> = { ...leaderboards };
    for (const [market_id, evt] of Object.entries(liveMarkets)) {
      out[market_id] = evt.agents.slice(0, 3);
    }
    return out;
  }, [leaderboards, liveMarkets]);

  if (error) {
    return <div className="px-2 py-2 ck-mono ck-neg">[ERR] {error}</div>;
  }
  if (!markets) {
    return <div className="px-2 py-2 ck-mono ck-dim">[loading markets...]</div>;
  }
  if (markets.length === 0) {
    return <div className="px-2 py-2 ck-mono ck-dim">[no markets listed]</div>;
  }

  const visible = limit ? markets.slice(0, limit) : markets;

  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[110px_60px_56px_46px_1fr_60px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-label">
        <span>MARKET</span>
        <span>ASSET</span>
        <span>HZN</span>
        <span className="text-right">N</span>
        <span>TOP-3</span>
        <span className="text-right">LEAD</span>
      </li>
      {visible.map((m) => {
        const top = merged[m.market_id] ?? [];
        const leader = top[0];
        return (
          <li
            key={m.market_id}
            className="grid grid-cols-[110px_60px_56px_46px_1fr_60px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] hover:bg-[white]/[0.03]"
          >
            <a
              href={`#/markets/${encodeURIComponent(m.market_id)}?variant=compact`}
              className="contents no-underline"
            >
              <span className="ck-mono ck-pos truncate" title={m.market_id}>
                {m.market_id}
              </span>
              <span className="ck-mono ck-dim">
                {shortAssetSlug(m.asset_id).toUpperCase()}
              </span>
              <span className="ck-mono ck-dim">{formatHorizon(m.horizon_seconds)}</span>
              <span className="ck-mono ck-dim text-right">
                {top.length > 0 ? String(top.length).padStart(2, "0") : "—"}
              </span>
              <span className="ck-mono ck-dim truncate">
                {top.length === 0
                  ? "—"
                  : top.map((a) => a.display_slug).join(" · ")}
              </span>
              <span
                className={
                  "ck-mono text-right " +
                  (leader && (leader.verdict_score ?? 0) >= 0 ? "ck-pos" : "ck-neg")
                }
              >
                {formatVerdict(leader?.verdict_score ?? null)}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function formatVerdict(s: number | null): string {
  if (s === null || s === undefined) return "—";
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

function shortAssetSlug(asset_id: string): string {
  const parts = asset_id.split(":");
  const sym = parts.length >= 2 ? parts[1] : asset_id;
  return (sym ?? asset_id).toLowerCase();
}
