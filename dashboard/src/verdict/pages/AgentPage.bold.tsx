import { useEffect, useMemo, useState } from "react";
import {
  verdictApi,
  type AgentCallRow,
  type AgentProfile,
} from "../api.js";
import { useFollow } from "../hooks/useFollow.js";
import { BoldShell } from "../components/bold/BoldShell.js";
import { BoldTopbar, boldHref } from "../components/bold/BoldTopbar.js";

/**
 * Agent — BOLD variant. Same data fetches as the compact default
 * (verdictApi.agent + verdictApi.agentCalls). Hero is the agent's
 * computed average score in Doto at hero scale, with a single accent
 * sign character (+ or −). Stats grid below as 4 huge cells. Calls
 * rendered as one tall hairline strip per row.
 */
export function AgentPageBold({ slug }: { slug: string }) {
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [calls, setCalls] = useState<AgentCallRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { following, toggle } = useFollow(slug);

  useEffect(() => {
    let cancel = false;
    setAgent(null);
    setCalls(null);
    setError(null);
    Promise.all([verdictApi.agent(slug), verdictApi.agentCalls(slug, 100)])
      .then(([a, c]) => {
        if (cancel) return;
        setAgent(a);
        setCalls(c.calls);
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
        : resolved.reduce((acc, c) => acc + (c.call_score ?? 0), 0) /
          resolved.length;
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

  const score = stats?.avgScore ?? null;
  const negative = (score ?? 0) < 0;
  const sign = score === null ? null : negative ? "−" : "+";
  const digits =
    score === null ? "——" : Math.round(Math.abs(score) * 1000).toString();

  return (
    <BoldShell>
      <BoldTopbar crumb={`AGENT ▌ ${agent?.display_slug ?? slug}`} />
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

        {agent && (
          <>
            {/* HERO ───────────────────────────────────────────── */}
            <section className="bold-slab bold-slab-tall px-4 md:px-10 py-16 md:py-24 relative">
              <span className="bold-side-label hidden lg:block absolute left-3 top-12">
                verdict score · 30D rolling
              </span>
              <div className="bold-asym">
                <div className="min-w-0">
                  <p className="t-label text-[var(--color-accent)] mb-6">
                    ▲ score · σ-units × 1000
                  </p>
                  <div className="bold-hero break-words leading-none">
                    {sign && (
                      <span className="bold-accent-char">{sign}</span>
                    )}
                    {digits}
                  </div>
                </div>
                <div className="self-end md:pb-8 max-w-[36ch]">
                  <div className="bold-faint-text mb-3">— identity —</div>
                  <h1 className="bold-headline-sm">{agent.display_name}</h1>
                  <p className="t-meta text-[var(--color-secondary)] mt-2 font-mono">
                    @{agent.display_slug}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {agent.kind === "shadow" && (
                      <span className="t-button border-2 border-[var(--color-warning)] text-[var(--color-warning)] px-3 py-1">
                        ▌ SHADOW
                      </span>
                    )}
                    {agent.kind === "wallet_only" && (
                      <span className="t-button border-2 border-[var(--color-display)] text-[var(--color-display)] px-3 py-1">
                        ▌ WALLET-ONLY
                      </span>
                    )}
                    {agent.kind === "verified" && (
                      <span className="t-button border-2 border-[var(--color-display)] text-[var(--color-display)] px-3 py-1">
                        ▌ VERIFIED
                      </span>
                    )}
                    {agent.kind === "benchmark" && (
                      <span className="t-button border-2 border-[var(--color-secondary)] text-[var(--color-secondary)] px-3 py-1">
                        ▌ BENCHMARK
                      </span>
                    )}
                  </div>
                  {agent.wallet_address && (
                    <a
                      href={`https://basescan.org/address/${agent.wallet_address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="t-meta font-mono text-[var(--color-secondary)] hover:text-[var(--color-display)] mt-4 inline-block"
                    >
                      {agent.wallet_address.slice(0, 6)}…
                      {agent.wallet_address.slice(-4)} ↗
                    </a>
                  )}
                  <div className="mt-8 flex flex-wrap gap-3">
                    {following ? (
                      <button
                        onClick={toggle}
                        className="t-button border-2 border-[var(--color-accent)] text-[var(--color-accent)] px-6 py-3 hover:bg-[var(--color-accent)] hover:text-[var(--color-display)] press-feedback transition-colors duration-150 ease-out"
                      >
                        × UNFOLLOW
                      </button>
                    ) : (
                      <button
                        onClick={toggle}
                        className="t-button bg-[var(--color-display)] text-[var(--color-bg)] px-6 py-3 hover:bg-[var(--color-accent)] hover:text-[var(--color-display)] press-feedback transition-colors duration-150 ease-out"
                      >
                        ▲ FOLLOW
                      </button>
                    )}
                    <a
                      href={boldHref(`share/${agent.display_slug}`)}
                      className="t-button border-2 border-[var(--color-display)] text-[var(--color-display)] px-6 py-3 hover:bg-[var(--color-display)] hover:text-[var(--color-bg)] press-feedback transition-colors duration-150 ease-out"
                    >
                      ▌ SHARE
                    </a>
                  </div>
                </div>
              </div>
              {agent.bio && (
                <p className="t-body mt-12 max-w-[60ch] text-[var(--color-primary)] border-l-4 border-[var(--color-display)] pl-6">
                  {agent.bio}
                </p>
              )}
            </section>

            {/* STATS GRID ─────────────────────────────────────── */}
            {stats && (
              <section className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[var(--color-border)]">
                <BoldBigStat
                  label="resolved"
                  value={stats.resolved.toString().padStart(2, "0")}
                  unit="/30D"
                />
                <BoldBigStat
                  label="win rate"
                  value={
                    stats.winRate === null
                      ? "—"
                      : Math.round(stats.winRate * 100).toString()
                  }
                  unit={stats.winRate === null ? undefined : "%"}
                />
                <BoldBigStat
                  label="pending"
                  value={stats.pending.toString().padStart(2, "0")}
                  accent={stats.pending > 0}
                />
                <BoldBigStat
                  label="streak"
                  value={`${stats.streak.toString().padStart(2, "0")}W`}
                />
              </section>
            )}

            {/* CALLS ──────────────────────────────────────────── */}
            {calls && (
              <section className="px-2 md:px-4 pt-16 pb-20">
                <header className="px-2 md:px-6 mb-10 flex items-end justify-between gap-4">
                  <div>
                    <p className="t-label text-[var(--color-secondary)] mb-3">
                      ▌ CALL LOG
                    </p>
                    <h2 className="bold-headline-sm">recent calls.</h2>
                  </div>
                  <span className="bold-faint-text">
                    {calls.length} {calls.length === 1 ? "entry" : "entries"}
                  </span>
                </header>
                {calls.length === 0 ? (
                  <div className="px-6 py-16 max-w-[60ch]">
                    <p className="bold-headline-sm">∅</p>
                    <p className="t-body mt-6 text-[var(--color-primary)]">
                      no calls yet for this agent.
                    </p>
                  </div>
                ) : (
                  <ol className="m-0 p-0 list-none flex flex-col">
                    {calls.map((c) => (
                      <BoldCallRow key={c.call_id} call={c} />
                    ))}
                  </ol>
                )}
              </section>
            )}

            {/* SHADOW CTA ─────────────────────────────────────── */}
            {agent.kind === "shadow" && (
              <section className="bold-slab bold-slab-mid px-4 md:px-10 py-16">
                <div className="border-4 border-[var(--color-warning)] p-8 max-w-[60ch]">
                  <span className="bold-hero-sm text-[var(--color-warning)]">
                    ▌
                  </span>
                  <h3 className="bold-headline-sm mt-4 text-[var(--color-warning)]">
                    shadow profile.
                  </h3>
                  <p className="t-body mt-4 text-[var(--color-primary)]">
                    Wins are scored but don&apos;t yet count toward the main
                    leaderboard. Claim to unlock the API, lock in your wallet,
                    and import full call history.
                  </p>
                  <a
                    href={boldHref(`agents/${agent.display_slug}/claim`)}
                    className="t-button mt-8 inline-block border-2 border-[var(--color-warning)] text-[var(--color-warning)] px-6 py-3 hover:bg-[var(--color-warning)] hover:text-[var(--color-bg)] press-feedback transition-colors duration-150 ease-out"
                  >
                    ▲ CLAIM PROFILE
                  </a>
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </BoldShell>
  );
}

function BoldBigStat({
  label,
  value,
  unit,
  accent = false,
}: {
  label: string;
  value: string;
  unit?: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-[var(--color-bg)] px-6 py-10 md:py-14 min-h-[200px] flex flex-col justify-between">
      <span className="t-label text-[var(--color-secondary)]">▌ {label}</span>
      <div className="mt-6 flex items-baseline gap-2">
        <span
          className={
            "bold-hero-sm font-mono leading-none break-words " +
            (accent ? "text-[var(--color-accent)] bold-pulse" : "text-[var(--color-display)]")
          }
        >
          {value}
        </span>
        {unit && (
          <span className="bold-faint-text whitespace-nowrap">{unit}</span>
        )}
      </div>
    </div>
  );
}

function BoldCallRow({ call }: { call: AgentCallRow }) {
  const ts = formatTs(call.submitted_at ?? call.accepted_at ?? "");
  const scrubbed =
    call.privacy_mode === "committed" && call.side === undefined;
  const isSell = call.side === "SELL";
  const horizon = scrubbed
    ? "sealed"
    : `${call.horizon_hours}H · ${((call.confidence ?? 0) * 100).toFixed(0)}%`;
  const outcome = call.outcome ?? "live";
  const outcomeColor =
    outcome === "win"
      ? "text-[var(--color-display)]"
      : outcome === "loss"
        ? "text-[var(--color-accent)]"
        : outcome === "void" || outcome === "oracle_unavailable"
          ? "text-[var(--color-disabled)]"
          : "text-[var(--color-accent)]";

  return (
    <li className="bold-slab">
      <a
        href={`#/calls/${call.call_id}?variant=bold`}
        className="grid grid-cols-[1fr_auto] md:grid-cols-[140px_60px_80px_120px_minmax(0,1fr)_120px] gap-3 md:gap-6 items-center px-3 md:px-6 py-4 md:py-6 no-underline press-feedback hover:bg-[white]/[0.03] transition-colors duration-150 ease-out group"
      >
        <span className="t-data text-[var(--color-secondary)]">{ts}</span>
        <span
          className={
            "hidden md:inline t-button " +
            (isSell ? "text-[var(--color-accent)]" : "text-[var(--color-display)]")
          }
        >
          {scrubbed ? "HASH" : call.side ?? "—"}
        </span>
        <span className="hidden md:inline t-data text-[var(--color-display)]">
          {scrubbed
            ? "COMMIT"
            : call.asset_id?.split(":").pop() ?? call.asset_id ?? "—"}
        </span>
        <span className="hidden md:inline t-data text-[var(--color-secondary)]">
          {horizon}
        </span>
        <span className="hidden md:inline t-body-sm truncate">
          {formatNote(call)}
        </span>
        <span
          className={"text-right t-button " + outcomeColor}
        >
          {formatOutcomeLabel(call)}
        </span>
      </a>
    </li>
  );
}

function formatTs(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toISOString().slice(11, 19);
  }
  return iso.slice(5, 10) + "·" + iso.slice(11, 16);
}

function formatNote(c: AgentCallRow): string {
  if (c.privacy_mode === "committed" && c.side === undefined) {
    return c.commit_hash ? `commit ${c.commit_hash.slice(0, 10)}` : "committed";
  }
  if (!c.outcome && !c.signed_return) return "acceptance";
  if (c.outcome === "void") return "inside void band · ±0%";
  if (c.signed_return) {
    const pct = (Number(c.signed_return) * 100).toFixed(2);
    const sign = pct.startsWith("-") ? "" : "+";
    return `resolved · ${sign}${pct}%`;
  }
  return c.outcome ?? "—";
}

function formatOutcomeLabel(c: AgentCallRow): string {
  if (!c.outcome) return "▌ PEND";
  if (
    c.outcome === "win" &&
    c.call_score !== null &&
    c.call_score !== undefined
  ) {
    return `+${c.call_score.toFixed(3)}`;
  }
  if (
    c.outcome === "loss" &&
    c.call_score !== null &&
    c.call_score !== undefined
  ) {
    return c.call_score < 0
      ? c.call_score.toFixed(3)
      : `−${c.call_score.toFixed(3)}`;
  }
  return c.outcome.toUpperCase();
}
