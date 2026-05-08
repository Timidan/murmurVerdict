import { useEffect, useMemo, useState } from "react";
import {
  verdictApi,
  fetchAgentGrid,
  type AgentCallRow,
  type AgentMarketRow,
  type AgentProfile,
} from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { CompactSparkline } from "../components/compact/Sparkline.js";
import { useFollow } from "../hooks/useFollow.js";

/**
 * COMPACT per-agent dashboard. Single screen splits:
 *   ribbon → identity / score / kind / wallet / actions
 *   3-col main → call log · market heat · sticky sidecar (stats + actions)
 * No hero number, no oversized Doto. The large readout is mono.
 */
export function AgentPageCompact({ slug }: { slug: string }) {
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [calls, setCalls] = useState<AgentCallRow[] | null>(null);
  const [grid, setGrid] = useState<AgentMarketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { following, toggle } = useFollow(slug);

  useEffect(() => {
    let cancel = false;
    setAgent(null);
    setCalls(null);
    setGrid(null);
    setError(null);
    Promise.all([
      verdictApi.agent(slug),
      verdictApi.agentCalls(slug, 100),
      fetchAgentGrid(slug).catch(() => null),
    ])
      .then(([a, c, g]) => {
        if (cancel) return;
        setAgent(a);
        setCalls(c.calls);
        setGrid(g?.grid ?? []);
      })
      .catch((e) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  const stats = useMemo(() => {
    if (!calls) return null;
    const resolved = calls.filter((c) => c.outcome);
    const wins = resolved.filter((c) => c.outcome === "win").length;
    const losses = resolved.filter((c) => c.outcome === "loss").length;
    const pending = calls.filter((c) => !c.outcome).length;
    const winRate = wins + losses === 0 ? null : wins / (wins + losses);
    const avgScore =
      resolved.length === 0
        ? null
        : resolved.reduce((acc, c) => acc + (c.call_score ?? 0), 0) / resolved.length;
    let streak = 0;
    for (const c of calls) {
      if (c.outcome === "win") streak++;
      else if (c.outcome === "loss") break;
    }
    return {
      total: calls.length,
      resolved: resolved.length,
      wins,
      losses,
      pending,
      winRate,
      avgScore,
      streak,
    };
  }, [calls]);

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            AGENTS <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{agent?.display_slug ?? slug}</span>
          </span>
        }
      />

      {error && <div className="px-2 py-2 ck-mono ck-neg">[ERR] {error}</div>}

      {agent && (
        <>
          {/* IDENTITY RIBBON ─────────────────────────────────── */}
          <section className="grid grid-cols-2 md:grid-cols-8 border-b border-[var(--color-border)]">
            <RCell label="HANDLE" value={`@${agent.display_slug}`} />
            <RCell label="NAME" value={agent.display_name} />
            <RCell label="KIND" value={agent.kind.toUpperCase()} tone={kindTone(agent.kind)} />
            <RCell
              label="VERDICT·30D"
              value={stats ? formatScore(stats.avgScore) : "—"}
              tone={(stats?.avgScore ?? 0) >= 0 ? "pos" : "neg"}
            />
            <RCell label="WR" value={stats ? formatWR(stats.winRate) : "—"} />
            <RCell label="RES" value={stats ? String(stats.resolved).padStart(2, "0") : "—"} />
            <RCell
              label="PEND"
              value={stats ? String(stats.pending).padStart(2, "0") : "—"}
              tone={stats && stats.pending > 0 ? "neg" : "dim"}
            />
            <RCell label="STREAK" value={stats ? `${stats.streak}W` : "—"} />
          </section>

          {/* IDENTITY META + ACTIONS ─────────────────────────── */}
          <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--color-border)] flex-wrap">
            {agent.wallet_address && (
              <a
                href={`https://basescan.org/address/${agent.wallet_address}`}
                target="_blank"
                rel="noreferrer"
                className="ck-mono ck-pos no-underline"
                title={`${agent.wallet_address} on ${agent.chain_id ?? "eip155:8453"}`}
              >
                {agent.wallet_address.slice(0, 8)}…{agent.wallet_address.slice(-6)}
              </a>
            )}
            {agent.verified_identities && agent.verified_identities.length > 0 && (
              <span className="ck-label ck-dim">
                ID: {agent.verified_identities.map((v) => v.kind.toUpperCase()).join(" · ")}
              </span>
            )}
            <span className="ck-label ck-dim">
              SINCE {agent.created_at.slice(0, 10)}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <button
                onClick={toggle}
                className={"ck-btn " + (following ? "ck-btn-accent" : "ck-btn-active")}
              >
                {following ? "× UNFOLLOW" : "+ FOLLOW"}
              </button>
              <a href={`#/share/${agent.display_slug}`} className="ck-btn">
                SHARE
              </a>
              {agent.kind === "shadow" && (
                <a
                  href={`#/agents/${agent.display_slug}/claim`}
                  className="ck-btn ck-btn-accent"
                >
                  CLAIM
                </a>
              )}
            </span>
          </div>

          {agent.bio && (
            <div className="px-2 py-1 border-b border-[var(--color-border)] ck-mono ck-dim leading-tight">
              {agent.bio}
            </div>
          )}

          {/* MAIN GRID ───────────────────────────────────────── */}
          <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)] min-h-0">
            <Panel
              title="CALL LOG"
              meta={calls ? `${calls.length}` : ""}
              className="lg:border-r-0"
            >
              {calls === null && (
                <div className="px-2 py-2 ck-mono ck-dim">[loading...]</div>
              )}
              {calls !== null && calls.length === 0 && (
                <div className="px-2 py-2 ck-mono ck-dim">[no calls yet]</div>
              )}
              {calls !== null && calls.length > 0 && <CallTable calls={calls} />}
            </Panel>

            <Panel
              title="MARKET HEAT"
              meta={grid ? `${grid.length} mkts` : ""}
              className="lg:border-r-0"
            >
              {grid === null && (
                <div className="px-2 py-2 ck-mono ck-dim">[loading...]</div>
              )}
              {grid !== null && grid.length === 0 && (
                <div className="px-2 py-2 ck-mono ck-dim">[no per-market data]</div>
              )}
              {grid !== null && grid.length > 0 && <GridTable rows={grid} />}
            </Panel>

            <Panel title="DETAIL · SCORES">
              <SidebarStats stats={stats} agent={agent} />
            </Panel>
          </main>
        </>
      )}
    </div>
  );
}

function CallTable({ calls }: { calls: AgentCallRow[] }) {
  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[64px_36px_36px_44px_1fr_50px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-label">
        <span>TIME</span>
        <span>SIDE</span>
        <span>AST</span>
        <span>HZN</span>
        <span>NOTE</span>
        <span className="text-right">OUT</span>
      </li>
      {calls.map((c) => {
        const ts = formatTs(c.submitted_at ?? c.accepted_at);
        const sealed = c.privacy_mode === "committed" && c.side === undefined;
        const isSell = c.side === "SELL";
        const horizon = sealed ? "SEAL" : `${c.horizon_hours}H`;
        const ast = sealed ? "COMMIT" : (c.asset_id?.split(":").pop() ?? "—");
        const note = formatNote(c);
        const outLabel = formatOutcome(c);
        return (
          <li
            key={c.call_id}
            className="grid grid-cols-[64px_36px_36px_44px_1fr_50px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] hover:bg-[white]/[0.03]"
          >
            <a href={`#/calls/${c.call_id}`} className="contents no-underline">
              <span className="ck-mono ck-dim">{ts}</span>
              <span
                className={
                  "ck-mono " + (sealed ? "ck-dim" : isSell ? "ck-neg" : "ck-pos")
                }
              >
                {sealed ? "HASH" : c.side}
              </span>
              <span className="ck-mono ck-pos truncate">{ast}</span>
              <span className="ck-mono ck-dim">{horizon}</span>
              <span className="ck-mono ck-dim truncate">{note}</span>
              <span
                className={
                  "ck-mono text-right " +
                  (c.outcome === "win"
                    ? "ck-pos"
                    : c.outcome === "loss"
                      ? "ck-neg"
                      : "ck-dim")
                }
              >
                {outLabel}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function GridTable({ rows }: { rows: AgentMarketRow[] }) {
  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[1fr_44px_44px_56px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-label">
        <span>MARKET</span>
        <span className="text-right">VS</span>
        <span className="text-right">WR</span>
        <span className="text-right">TREND</span>
      </li>
      {rows.map((r) => (
        <li
          key={r.market_id}
          className="grid grid-cols-[1fr_44px_44px_56px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] hover:bg-[white]/[0.03]"
        >
          <a
            href={`#/markets/${encodeURIComponent(r.market_id)}?variant=compact`}
            className="contents no-underline"
          >
            <span className="ck-mono ck-pos truncate">{r.market_id}</span>
            <span
              className={
                "ck-mono text-right " +
                ((r.verdict_score ?? 0) >= 0 ? "ck-pos" : "ck-neg")
              }
            >
              {formatScore(r.verdict_score)}
            </span>
            <span className="ck-mono ck-dim text-right">
              {r.win_rate === null ? "—" : Math.round(r.win_rate * 100)}
            </span>
            <span className="flex justify-end">
              <CompactSparkline values={synth(r.verdict_score ?? 0)} width={56} height={12} />
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

interface AgentStats {
  total: number;
  resolved: number;
  wins: number;
  losses: number;
  pending: number;
  winRate: number | null;
  avgScore: number | null;
  streak: number;
}

function SidebarStats({
  stats,
  agent,
}: {
  stats: AgentStats | null;
  agent: AgentProfile;
}) {
  return (
    <div className="flex flex-col">
      <FactRow label="WINS" value={stats ? String(stats.wins) : "—"} tone="pos" />
      <FactRow label="LOSSES" value={stats ? String(stats.losses) : "—"} tone="neg" />
      <FactRow
        label="VERDICT"
        value={stats ? formatScore(stats.avgScore) : "—"}
        tone={(stats?.avgScore ?? 0) >= 0 ? "pos" : "neg"}
      />
      <FactRow label="WR" value={stats ? formatWR(stats.winRate) : "—"} />
      <FactRow label="STREAK" value={stats ? `${stats.streak}W` : "—"} />
      <FactRow label="TOTAL" value={stats ? String(stats.total) : "—"} tone="dim" />
      <FactRow label="KIND" value={agent.kind.toUpperCase()} tone="dim" />
      <FactRow label="WALLET" value={agent.wallet_address ? "BOUND" : "NONE"} tone="dim" />
      <FactRow
        label="CHAIN"
        value={agent.chain_id ?? "eip155:8453"}
        tone="dim"
      />
      <div className="px-2 py-2 ck-mono ck-dim leading-tight border-t border-[var(--color-border)]">
        {agent.kind === "shadow" && (
          <span>
            SHADOW · wins scored but don't count toward main leaderboard. Claim
            to lock wallet + import history.
          </span>
        )}
        {agent.kind === "verified" && (
          <span>VERIFIED · wallet-bound · main-tier eligible.</span>
        )}
        {agent.kind === "benchmark" && (
          <span>BENCHMARK · system-curated comparison agent.</span>
        )}
      </div>
    </div>
  );
}

function FactRow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg" | "dim" | "default";
}) {
  const toneClass =
    tone === "pos" ? "ck-pos" : tone === "neg" ? "ck-neg" : tone === "dim" ? "ck-dim" : "ck-pos";
  return (
    <div className="grid grid-cols-[60px_1fr] items-center px-2 py-1 border-b border-[var(--color-border)]">
      <span className="ck-label">{label}</span>
      <span
        className={"ck-mono text-right " + toneClass}
        style={{ fontSize: 12, fontWeight: 700 }}
      >
        {value}
      </span>
    </div>
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

function kindTone(kind: AgentProfile["kind"]): "pos" | "neg" | "dim" | "default" {
  if (kind === "verified") return "pos";
  if (kind === "shadow") return "neg";
  return "dim";
}

function formatScore(s: number | null): string {
  if (s === null || s === undefined) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
}

function formatWR(wr: number | null): string {
  return wr === null ? "—" : `${Math.round(wr * 100)}%`;
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toISOString().slice(11, 19);
  }
  return iso.slice(5, 10) + " " + iso.slice(11, 16);
}

function formatNote(c: AgentCallRow): string {
  if (c.privacy_mode === "committed" && c.side === undefined) {
    return c.commit_hash ? `commit ${c.commit_hash.slice(0, 8)}` : "committed";
  }
  if (!c.outcome && !c.signed_return) return "acceptance";
  if (c.outcome === "void") return "void · ±0%";
  if (c.signed_return) {
    const pct = (Number(c.signed_return) * 100).toFixed(2);
    const sign = pct.startsWith("-") ? "" : "+";
    return `${sign}${pct}%`;
  }
  return c.outcome ?? "—";
}

function formatOutcome(c: AgentCallRow): string {
  if (!c.outcome) return "PEND";
  if (c.outcome === "win" && c.call_score !== null && c.call_score !== undefined) {
    return `+${c.call_score.toFixed(2)}`;
  }
  if (c.outcome === "loss" && c.call_score !== null && c.call_score !== undefined) {
    return c.call_score < 0 ? c.call_score.toFixed(2) : `−${c.call_score.toFixed(2)}`;
  }
  return c.outcome.toUpperCase().slice(0, 4);
}

function synth(seed: number): number[] {
  const out: number[] = [];
  let v = seed * 1000;
  for (let i = 0; i < 12; i++) {
    v += Math.sin((seed + i) * 1.7) * 5;
    out.push(v);
  }
  return out;
}
