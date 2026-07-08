import { useEffect, useState } from "react";
import {
  fetchMarketLeaderboard,
  fetchMarkets,
  ApiError,
  type AgentMarketRow,
  type MarketRow,
} from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { CompactSparkline } from "../components/compact/Sparkline.js";
import { CompactLiveFeed } from "../components/compact/LiveFeed.js";
import { useStream } from "../hooks/useStream.js";

/**
 * COMPACT per-market detail. Single-screen ladder with a live sidecar tape
 * and a metrics ribbon. All numbers mono, no card chrome, sub-row shows
 * verdict_lb under the headline verdict score.
 */
export function MarketDetailPage({ marketId }: { marketId: string }) {
  const [market, setMarket] = useState<MarketRow | null>(null);
  const [agents, setAgents] = useState<AgentMarketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const stream = useStream();

  // Fold SSE markets.update for this specific market_id. The markets.update
  // rows are the lean wire shape (MarketLeaderboardEventAgentRow) — no REST-only
  // fields. MERGE the streamed wire fields onto the REST-hydrated row keyed by
  // agent_id so REST-only state survives a live tick instead of blanking,
  // mirroring LeaderboardPage's leaderboard.update merge. The RENDERED
  // REST-only fields — verdict_score_lb (lb score column) and call_scores (the
  // trend sparkline) — are preserved from the prior REST row so a live tick
  // doesn't blank them; last_resolved_at is preserved because AgentMarketRow
  // requires it. Functional updater reads prev without adding `agents` to the
  // effect deps.
  useEffect(() => {
    const evt = stream.markets[marketId];
    if (!evt) return;
    setAgents((prev) => {
      const byAgent = new Map((prev ?? []).map((r) => [r.agent_id, r]));
      return evt.agents.map((a) => {
        const previous = byAgent.get(a.agent_id);
        return {
          ...a,
          verdict_score_lb: previous?.verdict_score_lb ?? null,
          last_resolved_at: previous?.last_resolved_at ?? null,
          call_scores: previous?.call_scores,
        };
      });
    });
  }, [stream.markets, marketId]);

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
      .then(([lb, all]) => {
        if (cancel) return;
        const m = all.find((x) => x.market_id === marketId) ?? null;
        setMarket(m);
        if (lb) setAgents(lb.agents);
        else if (!m) setNotFound(true);
        else setAgents([]);
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });

    return () => {
      cancel = true;
    };
  }, [marketId]);

  const horizon = market ? formatHorizon(market.horizon_seconds) : "—";
  const assetSlug = market ? shortAssetSlug(market.asset_id) : "—";
  const taxonomy = market?.market_taxonomy ?? null;
  const mainCount = agents ? agents.filter((a) => a.market_main_tier).length : 0;
  const totalCalls = agents
    ? agents.reduce((acc, a) => acc + a.resolved_calls + a.pending_calls, 0)
    : 0;
  const leader = agents && agents.length > 0 ? agents[0] : null;

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            markets <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{marketId}</span>
          </span>
        }
      />

      {error && (
        <div className="px-2 py-2 ck-mono ck-neg">[err] {error}</div>
      )}
      {notFound && <NotFound marketId={marketId} />}

      {!error && !notFound && (
        <>
          {/* RIBBON ──────────────────────────────────────── */}
          <section className="grid grid-cols-2 md:grid-cols-8 border-b border-[var(--color-border)]">
            <RCell label="market" value={marketId} />
            <RCell label="asset" value={assetSlug.toUpperCase()} />
            <RCell label="hzn" value={horizon} />
            <RCell label="status" value={market?.status ?? "—"} tone="dim" />
            <RCell label="agents" value={agents?.length ?? "—"} />
            <RCell label="main" value={mainCount} />
            <RCell label="vol·open" value={totalCalls} tone="dim" />
            <RCell
              label="lead·vs"
              value={leader ? formatScore(leader.verdict_score) : "—"}
              tone={leader && (leader.verdict_score ?? 0) >= 0 ? "pos" : "neg"}
            />
          </section>

          {/* META FACTS ─────────────────────────────────── */}
          <details className="border-b border-[var(--color-border)]">
            <summary className="ck-label cursor-pointer px-2 py-1.5 select-none">
              market config
            </summary>
            <div className="grid grid-cols-2 md:grid-cols-6 border-t border-[var(--color-border)]">
              <RCell
                label="class"
                value={taxonomy?.label ?? market?.market_kind ?? "—"}
                tone={taxonomy?.support_status === "reserved" ? "dim" : "pos"}
              />
              <RCell
                label="support"
                value={taxonomy?.support_status ?? "—"}
                tone={taxonomy?.support_status === "reserved" ? "dim" : "pos"}
              />
              <RCell
                label="payoff"
                value={taxonomy?.payoff_model ?? "—"}
                tone="dim"
              />
              <RCell
                label="settle"
                value={taxonomy?.settlement_model?.replace(/_/g, " ") ?? "—"}
                tone="dim"
              />
              <RCell
                label="feeds"
                value={`${market?.primary_oracle_id ?? "—"} / ${market?.fallback_oracle_id ?? "—"}`}
                tone="dim"
              />
              <RCell label="void·band" value={market?.void_band ?? "—"} tone="dim" />
            </div>
          </details>

          {/* MAIN ────────────────────────────────────────── */}
          <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] min-h-0">
            <Panel
              title="agent ladder"
              meta={agents ? `${agents.length}` : ""}
              actions={
                <a href="#/" className="ck-btn">
                  all markets
                </a>
              }
              className="lg:border-r-0"
            >
              {agents === null && (
                <div className="px-2 py-2 ck-mono ck-dim">[loading…]</div>
              )}
              {agents !== null && agents.length === 0 && (
                <div className="px-2 py-2 ck-mono ck-dim">[no agents have resolved a call here yet]</div>
              )}
              {agents !== null && agents.length > 0 && <Ladder rows={agents} />}
            </Panel>
            <Panel title="live tape">
              <CompactLiveFeed limit={60} />
            </Panel>
          </main>
        </>
      )}
    </div>
  );
}

function Ladder({ rows }: { rows: AgentMarketRow[] }) {
  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[28px_1fr_56px_44px_50px_44px_60px_24px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-label">
        <span>#</span>
        <span>agent</span>
        <span className="text-right">vs</span>
        <span className="text-right">vs·lb</span>
        <span className="text-right">res</span>
        <span className="text-right">wr</span>
        <span className="text-right">trend</span>
        <span className="text-right">p</span>
      </li>
      {rows.map((r, i) => (
        <li
          key={r.agent_id}
          className="grid grid-cols-[28px_1fr_56px_44px_50px_44px_60px_24px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] hover:bg-[white]/[0.03]"
        >
          <a href={`#/agents/${r.display_slug}`} className="contents no-underline">
            <span className="ck-mono ck-dim">{String(i + 1).padStart(2, "0")}</span>
            <span className="flex items-baseline gap-1 min-w-0">
              <span className="ck-mono ck-pos truncate" title={r.display_name}>
                {r.display_slug}
              </span>
              <span className={"ck-label " + (r.market_main_tier ? "ck-pos" : "ck-dim")}>
                {r.market_main_tier ? "·main" : "·prov"}
              </span>
            </span>
            <span
              className={
                "ck-mono text-right " +
                ((r.verdict_score ?? 0) >= 0 ? "ck-pos" : "ck-neg")
              }
            >
              {formatScore(r.verdict_score)}
            </span>
            <span className="ck-mono ck-dim text-right">
              {formatScore(r.verdict_score_lb)}
            </span>
            <span className="ck-mono ck-dim text-right">
              {String(r.resolved_calls).padStart(3, "0")}
            </span>
            <span className="ck-mono ck-dim text-right">
              {r.win_rate === null ? "—" : Math.round(r.win_rate * 100)}
            </span>
            <span className="flex justify-end items-center">
              <CompactSparkline
                values={r.call_scores?.filter((s): s is number => s !== null) ?? []}
                width={56}
                height={12}
              />
            </span>
            <span className="text-right ck-mono ck-dim">
              {r.pending_calls > 0 ? r.pending_calls : <span className="ck-dim">·</span>}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function RCell({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | string;
  tone?: "pos" | "neg" | "dim" | "default";
}) {
  const toneClass =
    tone === "pos" ? "ck-pos" : tone === "neg" ? "ck-neg" : tone === "dim" ? "ck-dim" : "ck-pos";
  return (
    <div className="px-2 py-1.5 border-r border-[var(--color-border)] flex flex-col gap-0.5 min-w-0">
      <span className="ck-label">{label}</span>
      <span
        className={"ck-mono truncate " + toneClass}
        style={{ fontSize: 13, fontWeight: 700 }}
        title={String(value)}
      >
        {value}
      </span>
    </div>
  );
}

function NotFound({ marketId }: { marketId: string }) {
  return (
    <div className="px-2 py-3 ck-mono">
      <div className="ck-label ck-dim mb-1">404</div>
      <div className="ck-pos" style={{ fontSize: 14, fontWeight: 700 }}>
        market not found
      </div>
      <p className="ck-mono ck-dim mt-1 leading-tight">
        No market is registered under <span className="ck-pos">{marketId}</span>. It may be retired or stale.
      </p>
      <a href="#/launch" className="ck-btn mt-2 inline-flex">
        ← back to install
      </a>
    </div>
  );
}

function formatScore(s: number | null): string {
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
