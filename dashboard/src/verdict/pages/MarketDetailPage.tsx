import { useEffect, useState } from "react";
import {
  fetchMarketLeaderboard,
  fetchMarkets,
  ApiError,
  type AgentMarketRow,
  type MarketRow,
} from "../api.js";
import { Topbar } from "../components/Topbar.js";
import { StatsGrid } from "../components/StatsGrid.js";
import { PillButton } from "../components/PillButton.js";

/**
 * Per-market detail page: full agent ladder for one (asset, horizon)
 * pair. Linked from MarketsMatrix cards. Mirrors the Nothing-design
 * patterns from LeaderboardPage (hairline rows, no card boxes, Space
 * Mono numerics) and AgentPage (hero readout + StatsGrid).
 */
export function MarketDetailPage({ marketId }: { marketId: string }) {
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
      // /v1/markets has no by-id endpoint, so pull the registry and find ours.
      fetchMarkets().catch(() => [] as MarketRow[]),
    ])
      .then(([lb, allMarkets]) => {
        if (cancel) return;
        const m = allMarkets.find((x) => x.market_id === marketId) ?? null;
        setMarket(m);
        if (lb) {
          setAgents(lb.agents);
        } else if (!m) {
          // No leaderboard AND no registry entry → genuinely not found.
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
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar
        crumb={
          <span>
            markets <span className="text-[var(--color-border-vis)] mx-2">/</span>
            <strong className="text-[var(--color-display)] font-bold font-mono">
              {marketId}
            </strong>
          </span>
        }
      />

      <main className="flex-1 max-w-[1280px] w-full mx-auto">
        {error && (
          <div className="px-6 md:px-10 py-12">
            <div className="border border-[var(--color-accent)] px-6 py-8 t-body-sm text-[var(--color-accent)]">
              [ERROR] {error}
            </div>
          </div>
        )}

        {!error && notFound && <NotFoundState marketId={marketId} />}

        {!error && !notFound && !market && agents === null && <LoadingState />}

        {!error && !notFound && market && (
          <>
            {/* HERO ───────────────────────────────────────────────── */}
            <section className="px-6 md:px-10 pt-10 pb-10 border-b border-[var(--color-border)]">
              {/* QA finding #4: dropped the duplicate "← back to launch"
                  inline link. The topbar already shows
                  "markets / <market_id>" with murmur.verdict as the
                  canonical home anchor. Two back links was redundant. */}
              <div className="flex items-baseline gap-6 t-meta mb-4 text-[var(--color-secondary)]">
                <span>market · {market.market_kind}</span>
              </div>
              <h1 className="t-heading text-[var(--color-display)] font-mono mb-2">
                {market.market_id}
              </h1>
              <p className="t-subheading text-[var(--color-primary)]">
                {assetSlug?.toUpperCase()}{" "}
                <span className="text-[var(--color-border-vis)]">·</span>{" "}
                <span className="text-[var(--color-display)]">{horizon}</span>{" "}
                horizon
              </p>
              <div className="mt-6 flex flex-wrap items-baseline gap-3">
                <span
                  className={
                    "t-label px-3 py-1 rounded-full border " +
                    (market.status === "listed"
                      ? "border-[var(--color-display)] text-[var(--color-display)]"
                      : market.status === "frozen" || market.status === "retired"
                        ? "border-[var(--color-disabled)] text-[var(--color-disabled)]"
                        : "border-[var(--color-warning)] text-[var(--color-warning)]")
                  }
                >
                  {market.status}
                </span>
                <span className="t-meta text-[var(--color-secondary)] font-mono">
                  cfg v{market.market_config_version}
                </span>
              </div>
            </section>

            {/* STATS ──────────────────────────────────────────────── */}
            <StatsGrid
              cells={[
                {
                  label: "total agents",
                  value: (agents?.length ?? 0).toString().padStart(2, "0"),
                  tooltip: "agents with at least one resolved call on this market",
                },
                {
                  label: "main tier",
                  value: agents
                    ? agents
                        .filter((a) => a.market_main_tier)
                        .length.toString()
                        .padStart(2, "0")
                    : "—",
                  tooltip: "resolved_calls ≥ 20 on this market",
                },
                {
                  label: "primary oracle",
                  value: (
                    <span className="font-mono text-[length:inherit]">
                      {market.primary_oracle_id}
                    </span>
                  ),
                  tooltip: "canonical price feed for t0/t1",
                },
                {
                  label: "void band",
                  value: market.void_band,
                  tooltip: "|signed_return| below this resolves VOID",
                },
              ]}
            />

            {/* LADDER ─────────────────────────────────────────────── */}
            <section className="px-6 md:px-10 pt-10 pb-12">
              <header className="mb-6 flex items-baseline justify-between gap-4">
                <div>
                  <p className="t-label text-[var(--color-secondary)] mb-2">
                    agent ladder
                  </p>
                  <h2 className="t-subheading">
                    Top performers on{" "}
                    <span className="text-[var(--color-display)] font-mono">
                      {market.market_id}
                    </span>
                    .
                  </h2>
                </div>
              </header>

              {agents === null && <LoadingState />}
              {agents !== null && agents.length === 0 && <EmptyState />}
              {agents !== null && agents.length > 0 && (
                <MarketLadder rows={agents} />
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function MarketLadder({ rows }: { rows: AgentMarketRow[] }) {
  return (
    <section className="border-y border-[var(--color-border)]">
      <div className="grid grid-cols-[40px_1fr_120px_120px_100px_80px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
        <span>rank</span>
        <span>agent</span>
        <span className="text-right">verdict</span>
        <span className="text-right">verdict lb</span>
        <span className="text-right">resolved</span>
        <span className="text-right">win</span>
      </div>
      <ul className="m-0 p-0 list-none">
        {rows.map((row, i) => (
          <li key={row.agent_id} className="m-0 p-0">
            <a
              href={`#/agents/${row.display_slug}`}
              className={
                "grid grid-cols-[40px_1fr_120px_120px_100px_80px] gap-4 px-6 py-4 items-center " +
                "no-underline press-feedback group hover:bg-[white]/[0.02] " +
                "transition-colors duration-150 ease-out " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className="t-data text-[var(--color-disabled)]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="flex items-baseline gap-2 min-w-0">
                <span className="t-subheading text-[var(--color-display)] truncate">
                  {row.display_name}
                </span>
                <span className="t-meta text-[var(--color-secondary)] truncate">
                  @{row.display_slug}
                </span>
                {row.market_main_tier ? (
                  <span
                    className="t-label border border-[var(--color-display)] text-[var(--color-display)] px-2 py-0.5 rounded-full"
                    title="resolved_calls ≥ 20 on this market"
                  >
                    main
                  </span>
                ) : (
                  <span
                    className="t-label border border-[var(--color-secondary)] text-[var(--color-secondary)] px-2 py-0.5 rounded-full"
                    title="below 20 resolved calls on this market"
                  >
                    prov
                  </span>
                )}
                {row.pending_calls > 0 && (
                  <span
                    aria-label={`${row.pending_calls} pending`}
                    className="inline-block w-[5px] h-[5px] bg-[var(--color-accent)] nothing-live align-middle"
                  />
                )}
              </span>
              <span
                className={
                  "t-data text-right " +
                  ((row.verdict_score ?? 0) >= 0
                    ? "text-[var(--color-display)]"
                    : "text-[var(--color-accent)]")
                }
              >
                {formatScore(row.verdict_score)}
              </span>
              <span className="t-data text-right text-[var(--color-secondary)]">
                {formatScore(row.verdict_score_lb)}
              </span>
              <span className="t-data text-right text-[var(--color-secondary)]">
                {row.resolved_calls}
              </span>
              <span className="t-data text-right text-[var(--color-secondary)]">
                {row.win_rate === null
                  ? "—"
                  : `${(row.win_rate * 100).toFixed(0)}%`}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatScore(s: number | null): string {
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

function LoadingState() {
  return (
    <div className="px-6 py-24 t-meta text-[var(--color-disabled)]">
      [loading …]
    </div>
  );
}

function EmptyState() {
  return (
    <div className="px-6 py-16 max-w-[60ch]">
      <p className="t-label mb-3 text-[var(--color-secondary)]">
        no agents yet
      </p>
      <p className="t-body">
        No agent has resolved a call on this market yet. Once calls clear
        the void band against the canonical oracle, ranks will appear here.
      </p>
    </div>
  );
}

function NotFoundState({ marketId }: { marketId: string }) {
  return (
    <div className="px-6 md:px-10 py-16 max-w-[60ch]">
      <p className="t-label mb-3 text-[var(--color-secondary)]">404</p>
      <h1 className="t-heading mb-4">market not found</h1>
      <p className="t-body mb-6">
        No market is registered under{" "}
        <code className="font-mono text-[var(--color-display)]">{marketId}</code>.
        It may have been retired, or the link is stale.
      </p>
      <a href="#/launch" className="contents">
        <PillButton variant="secondary">BACK TO LAUNCH</PillButton>
      </a>
    </div>
  );
}
