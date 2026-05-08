import { useEffect, useState } from "react";
import {
  fetchMarketLeaderboard,
  fetchMarkets,
  ApiError,
  type AgentMarketRow,
  type MarketRow,
} from "../api.js";
import { CalmShell } from "../components/calm/CalmShell.js";
import { CalmTopbar } from "../components/calm/CalmTopbar.js";
import { CalmFooter } from "../components/calm/CalmFooter.js";
import { CalmStatRow } from "../components/calm/CalmStatRow.js";

/**
 * CALM market detail — single (asset, horizon) pair as a placard, then
 * the full agent ladder as a vertical reading list. Same fetches as
 * the default MarketDetailPage; presentation is monochrome, hairline,
 * single-column.
 */
export function MarketDetailPageCalm({ marketId }: { marketId: string }) {
  const [market, setMarket] = useState<MarketRow | null>(null);
  const [agents, setAgents] = useState<AgentMarketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancel = false;
    setMarket(null);
    setAgents(null);
    setError(null);
    setNotFound(false);

    Promise.all([
      fetchMarketLeaderboard(marketId, { limit: 50 }).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) {
          if (!cancel) setNotFound(true);
          return null;
        }
        throw e;
      }),
      fetchMarkets().catch(() => [] as MarketRow[]),
    ])
      .then(([lb, allMarkets]) => {
        if (cancel) return;
        const m = allMarkets.find((x) => x.market_id === marketId) ?? null;
        setMarket(m);
        if (lb) {
          setAgents(lb.agents);
        } else if (!m) {
          setNotFound(true);
        } else {
          setAgents([]);
        }
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });

    return () => {
      cancel = true;
    };
  }, [marketId]);

  const assetSlug = market ? shortAssetSlug(market.asset_id) : null;
  const horizon = market ? formatHorizon(market.horizon_seconds) : null;

  return (
    <CalmShell>
      <CalmTopbar
        crumb={
          <span>
            markets <span className="mx-2">·</span>
            <span style={{ color: "var(--calm-ink)" }}>{marketId}</span>
          </span>
        }
      />
      <main>
        {error && (
          <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-section">
            <p className="calm-body" style={{ color: "var(--calm-ink-faint)" }}>
              Could not load the market. {error}
            </p>
          </section>
        )}

        {!error && notFound && (
          <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-section">
            <p className="calm-eyebrow mb-6">404</p>
            <h1 className="calm-headline mb-8">Market not found.</h1>
            <p className="calm-body mb-12">
              No market is registered under <code className="calm-code">{marketId}</code>.
              It may have been retired or the link is stale.
            </p>
            <a href="#/launch?variant=calm" className="calm-button-ghost">
              Back to install
            </a>
          </section>
        )}

        {!error && !notFound && !market && (
          <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-section">
            <p className="calm-body">Loading.</p>
          </section>
        )}

        {!error && !notFound && market && (
          <>
            {/* HERO — placard */}
            <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-section">
              <p className="calm-eyebrow mb-10 calm-enter">{market.market_kind.replace(/_/g, " ")}</p>
              <h1 className="calm-display-md calm-enter calm-enter-delay-1">
                {market.market_id}
              </h1>
              <p className="calm-body mt-10 calm-enter calm-enter-delay-2">
                {assetSlug?.toUpperCase()} resolved every <span style={{ color: "var(--calm-ink)" }}>{horizon}</span>
                {" "}against{" "}
                <span style={{ color: "var(--calm-ink)" }}>{market.primary_oracle_id}</span>
                . Status: {market.status}.
              </p>
            </section>

            {/* STATS */}
            <section className="max-w-[1080px] mx-auto px-6 md:px-10">
              <CalmStatRow
                stats={[
                  {
                    label: "Total agents",
                    value: (agents?.length ?? 0).toString().padStart(2, "0"),
                  },
                  {
                    label: "Main tier",
                    value: agents
                      ? agents
                          .filter((a) => a.market_main_tier)
                          .length.toString()
                          .padStart(2, "0")
                      : "—",
                  },
                  {
                    label: "Void band",
                    value: market.void_band,
                  },
                  {
                    label: "Config",
                    value: `v${market.market_config_version}`,
                  },
                ]}
              />
            </section>

            {/* LADDER */}
            <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-section">
              <header className="mb-12">
                <p className="calm-eyebrow mb-4">Ladder</p>
                <h2 className="calm-headline">Top performers on this market.</h2>
              </header>

              {agents === null && <p className="calm-body">Loading.</p>}
              {agents !== null && agents.length === 0 && (
                <p className="calm-body">
                  No agent has resolved a call on this market yet. Once calls
                  clear the void band, ranks will appear here.
                </p>
              )}
              {agents !== null && agents.length > 0 && (
                <ul className="m-0 p-0 list-none">
                  {agents.map((row, i) => (
                    <li key={row.agent_id} className="m-0 p-0">
                      <a
                        href={`#/agents/${row.display_slug}?variant=calm`}
                        className="calm-row grid-cols-[44px_1fr_120px_100px] md:grid-cols-[64px_1fr_160px_140px] gap-6"
                      >
                        <span className="calm-meta">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span className="flex items-baseline gap-3 min-w-0">
                          <span className="calm-headline-sm truncate">
                            {row.display_name}
                          </span>
                          <span className="calm-meta hidden md:inline">
                            {row.market_main_tier ? "main" : "provisional"}
                          </span>
                        </span>
                        <span className="calm-meta text-right">
                          {row.win_rate === null
                            ? "—"
                            : `${(row.win_rate * 100).toFixed(0)}% win`}
                        </span>
                        <span className="calm-stat-sm text-right">
                          {formatScore(row.verdict_score)}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>

      <CalmFooter />
    </CalmShell>
  );
}

function formatScore(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${(Math.abs(s)).toFixed(3)}`;
}

function formatHorizon(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 60 * 60 * 24) return `${Math.round(seconds / 3600)} hr`;
  if (seconds < 60 * 60 * 24 * 7) return `${Math.round(seconds / 86400)} day`;
  return `${Math.round(seconds / (86400 * 7))} wk`;
}

function shortAssetSlug(asset_id: string): string {
  const parts = asset_id.split(":");
  const sym = parts.length >= 2 ? parts[1] : asset_id;
  return (sym ?? asset_id).toLowerCase();
}
