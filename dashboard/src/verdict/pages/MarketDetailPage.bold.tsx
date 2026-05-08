import { useEffect, useState } from "react";
import {
  fetchMarketLeaderboard,
  fetchMarkets,
  ApiError,
  type AgentMarketRow,
  type MarketRow,
} from "../api.js";
import { BoldShell } from "../components/bold/BoldShell.js";
import { BoldTopbar, boldHref } from "../components/bold/BoldTopbar.js";

/**
 * Market detail — BOLD variant. Same fetches as MarketDetailPage.tsx
 * (fetchMarketLeaderboard + fetchMarkets registry). Renders the market
 * id at hero scale in Doto, the asset and horizon as caption, then the
 * agent ladder as tall hairline rows.
 */
export function MarketDetailPageBold({ marketId }: { marketId: string }) {
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
    <BoldShell>
      <BoldTopbar crumb={`MARKET ▌ ${marketId}`} />
      <main className="flex-1">
        {error && (
          <div className="px-4 md:px-10 py-12">
            <div className="border-4 border-[var(--color-accent)] px-6 py-12">
              <span className="bold-hero-sm text-[var(--color-accent)]">!</span>
              <p className="t-body mt-4 text-[var(--color-accent)]">
                [ERROR] {error}
              </p>
            </div>
          </div>
        )}

        {!error && notFound && (
          <NotFoundState marketId={marketId} />
        )}

        {!error && !notFound && !market && agents === null && (
          <div className="px-6 py-24 bold-faint-text">— [loading] —</div>
        )}

        {!error && !notFound && market && (
          <>
            {/* HERO ───────────────────────────────────────────── */}
            <section className="bold-slab bold-slab-tall px-4 md:px-10 py-16 md:py-24">
              <p className="t-label text-[var(--color-accent)] mb-6">
                ▲ market · {market.market_kind}
              </p>
              <h1 className="bold-hero-md break-words font-mono">
                {market.market_id}
              </h1>
              <div className="mt-10 flex flex-wrap items-baseline gap-6 md:gap-10">
                <span
                  className="bold-headline-sm text-[var(--color-secondary)] uppercase"
                >
                  {assetSlug}
                </span>
                <span className="bold-faint-text">×</span>
                <span className="bold-headline-sm text-[var(--color-display)]">
                  {horizon}
                </span>
                <span className="bold-faint-text">horizon</span>
              </div>
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <span
                  className={
                    "t-button px-4 py-2 border-2 " +
                    (market.status === "listed"
                      ? "border-[var(--color-display)] text-[var(--color-display)]"
                      : market.status === "frozen" || market.status === "retired"
                        ? "border-[var(--color-disabled)] text-[var(--color-disabled)]"
                        : "border-[var(--color-warning)] text-[var(--color-warning)]")
                  }
                >
                  ▌ {market.status.toUpperCase()}
                </span>
                <span className="bold-faint-text">
                  cfg v{market.market_config_version}
                </span>
              </div>
            </section>

            {/* STATS — four big cells ─────────────────────────── */}
            <section className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[var(--color-border)]">
              <BoldStat
                label="total agents"
                value={(agents?.length ?? 0).toString().padStart(2, "0")}
              />
              <BoldStat
                label="main tier"
                value={
                  agents
                    ? agents
                        .filter((a) => a.market_main_tier)
                        .length.toString()
                        .padStart(2, "0")
                    : "—"
                }
              />
              <BoldStat
                label="oracle"
                value={market.primary_oracle_id}
                size="small"
              />
              <BoldStat
                label="void band"
                value={market.void_band}
                size="small"
              />
            </section>

            {/* LADDER ─────────────────────────────────────────── */}
            <section className="px-2 md:px-4 pt-16 pb-20">
              <header className="px-2 md:px-6 mb-10">
                <p className="t-label text-[var(--color-secondary)] mb-3">
                  ▌ AGENT LADDER
                </p>
                <h2 className="bold-headline-sm">
                  top performers on{" "}
                  <span className="font-mono text-[var(--color-accent)]">
                    {market.market_id}
                  </span>
                  .
                </h2>
              </header>

              {agents === null && (
                <div className="px-6 py-24 bold-faint-text">— [loading] —</div>
              )}
              {agents !== null && agents.length === 0 && (
                <div className="px-6 py-16 max-w-[60ch]">
                  <p className="bold-headline-sm">∅</p>
                  <p className="t-body mt-6 text-[var(--color-primary)]">
                    no agents yet on this market. Once calls clear the void
                    band against the canonical oracle, ranks appear here.
                  </p>
                </div>
              )}
              {agents !== null && agents.length > 0 && (
                <ol className="m-0 p-0 list-none flex flex-col">
                  {agents.map((row, i) => (
                    <BoldLadderRow key={row.agent_id} row={row} index={i} />
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </main>
    </BoldShell>
  );
}

function BoldLadderRow({
  row,
  index,
}: {
  row: AgentMarketRow;
  index: number;
}) {
  const score = row.verdict_score ?? 0;
  const negative = score < 0;
  return (
    <li className="bold-slab">
      <a
        href={boldHref(`agents/${row.display_slug}`)}
        className="grid grid-cols-[60px_minmax(0,1fr)_120px] md:grid-cols-[120px_minmax(0,1fr)_220px] gap-3 md:gap-8 items-center px-3 md:px-6 py-6 md:py-8 no-underline press-feedback hover:bg-[white]/[0.03] transition-colors duration-150 ease-out group"
      >
        <span className="bold-hero-sm text-[var(--color-display)] opacity-25 group-hover:opacity-100 transition-opacity leading-none">
          {String(index + 1).padStart(2, "0")}
        </span>
        <div className="min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span
              className="font-sans truncate"
              style={{
                fontSize: "clamp(20px, 2.4vw, 32px)",
                fontWeight: 500,
                letterSpacing: "-0.02em",
                color: "var(--color-display)",
              }}
            >
              {row.display_name}
            </span>
            {row.market_main_tier ? (
              <span className="t-label border-2 border-[var(--color-display)] text-[var(--color-display)] px-2 py-1">
                MAIN
              </span>
            ) : (
              <span className="t-label border-2 border-[var(--color-secondary)] text-[var(--color-secondary)] px-2 py-1">
                PROV
              </span>
            )}
            {row.pending_calls > 0 && (
              <span
                aria-label={`${row.pending_calls} pending`}
                className="inline-block w-[8px] h-[8px] bg-[var(--color-accent)] bold-pulse"
              />
            )}
          </div>
          <p className="bold-faint-text mt-3">
            @{row.display_slug} ▌ {row.resolved_calls} resolved ▌{" "}
            {row.win_rate === null
              ? "—"
              : `${(row.win_rate * 100).toFixed(0)}% win`}{" "}
            ▌ verdict-lb {formatScore(row.verdict_score_lb)}
          </p>
        </div>
        <span
          className={
            "text-right font-mono tabular-nums leading-none whitespace-nowrap " +
            (negative ? "text-[var(--color-accent)]" : "text-[var(--color-display)]")
          }
          style={{
            fontSize: "clamp(28px, 4vw, 64px)",
            letterSpacing: "-0.04em",
          }}
        >
          {formatScore(row.verdict_score)}
        </span>
      </a>
    </li>
  );
}

function BoldStat({
  label,
  value,
  size = "large",
}: {
  label: string;
  value: string | number;
  size?: "large" | "small";
}) {
  return (
    <div className="bg-[var(--color-bg)] px-6 py-10 md:py-14 min-h-[180px] flex flex-col justify-between">
      <span className="t-label text-[var(--color-secondary)]">▌ {label}</span>
      <span
        className={
          (size === "large" ? "bold-hero-sm" : "bold-headline-sm") +
          " font-mono text-[var(--color-display)] mt-6 break-words"
        }
      >
        {value}
      </span>
    </div>
  );
}

function NotFoundState({ marketId }: { marketId: string }) {
  return (
    <div className="px-4 md:px-10 py-24 max-w-[60ch]">
      <p className="bold-hero-sm text-[var(--color-accent)]">404</p>
      <h1 className="bold-headline-sm mt-6">market not found</h1>
      <p className="t-body mt-4 text-[var(--color-primary)]">
        no market is registered under{" "}
        <code className="font-mono text-[var(--color-display)]">
          {marketId}
        </code>
        . it may have been retired, or the link is stale.
      </p>
      <a
        href={boldHref("launch")}
        className="t-button mt-8 inline-block border-2 border-[var(--color-display)] text-[var(--color-display)] px-6 py-3 hover:bg-[var(--color-display)] hover:text-[var(--color-bg)] press-feedback transition-colors duration-150 ease-out"
      >
        ▌ BACK TO LAUNCH
      </a>
    </div>
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

function shortAssetSlug(asset_id: string): string {
  const parts = asset_id.split(":");
  const sym = parts.length >= 2 ? parts[1] : asset_id;
  return (sym ?? asset_id).toLowerCase();
}
