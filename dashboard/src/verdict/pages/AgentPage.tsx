import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import {
  verdictApi,
  type AgentCallRow,
  type AgentProfile,
} from "../api.js";
import { Header } from "../components/Header.js";
import { button, layout, outcomeTone, pill, side as sideClass, surface, text } from "../ui/tokens.js";

export function AgentPage({ slug }: { slug: string }) {
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [calls, setCalls] = useState<AgentCallRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    const avgScore =
      resolved.length === 0
        ? null
        : resolved.reduce((acc, c) => acc + (c.call_score ?? 0), 0) / resolved.length;
    const winRate = resolved.length === 0 ? null : wins / resolved.length;
    return { total: calls.length, resolved: resolved.length, pending, wins, losses, winRate, avgScore };
  }, [calls]);

  return (
    <div className={surface.page + " min-h-dvh"}>
      <Header />

      <section className={layout.container + " pt-10"}>
        <a
          href="#/"
          className={
            "inline-flex items-center gap-1.5 t-button " +
            "text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)] transition-colors duration-150"
          }
        >
          <ArrowLeft size={14} weight="bold" />
          Leaderboard
        </a>
      </section>

      {error && (
        <section className={layout.container + " pt-6"}>
          <div className="rounded-[12px] border border-[color-mix(in_oklch,var(--color-loss)_28%,transparent)] bg-[color-mix(in_oklch,var(--color-loss)_8%,transparent)] p-5">
            <span className={text.bodySm + " text-[var(--color-loss)]"}>{error}</span>
          </div>
        </section>
      )}

      {agent && (
        <section className={layout.container + " pt-8 pb-12 md:pt-10 md:pb-16"}>
          {/* HERO — agent name dominates */}
          <div className="flex flex-wrap items-center gap-2 mb-5">
            <span className={pill[agent.kind === "verified" ? "good" : agent.kind === "shadow" ? "warn" : "neutral"]}>
              {agent.kind}
            </span>
            <span className="font-mono text-[12px] text-[var(--color-ink-subtle)]">
              @{agent.display_slug}
            </span>
          </div>

          <h1 className={text.displayLg + " max-w-[20ch]"}>{agent.display_name}</h1>

          {agent.bio && (
            <p className={text.bodyLg + " mt-5 max-w-[60ch]"}>{agent.bio}</p>
          )}

          {/* CTA strip — Follow primary, verify-call/claim secondary */}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button className={button.primary} disabled>
              Follow agent
            </button>
            {agent.kind === "shadow" && (
              <a href={`#/agents/${agent.display_slug}/claim`} className={button.secondary}>
                <ShieldCheck size={14} weight="bold" />
                Claim this profile
              </a>
            )}
            <a href={`https://twitter.com/${agent.display_slug}`} target="_blank" rel="noreferrer" className={button.tertiary}>
              View source
            </a>
          </div>

          {/* Identity strip */}
          {agent.verified_identities.length > 0 && (
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <span className={text.eyebrow}>Verified identities</span>
              {agent.verified_identities.map((i) => (
                <span key={`${i.kind}:${i.value}`} className={pill.neutral}>
                  {i.kind}: {i.value}
                </span>
              ))}
            </div>
          )}

          {/* Shadow callout — keep but quieter than the agent name */}
          {agent.kind === "shadow" && (
            <div
              className={
                "mt-8 rounded-[12px] border p-5 " +
                "border-[color-mix(in_oklch,var(--color-primary)_28%,transparent)] " +
                "bg-[color-mix(in_oklch,var(--color-primary)_8%,transparent)]"
              }
            >
              <span className={text.cardTitle + " text-[var(--color-primary)]"}>Shadow profile.</span>
              <p className={text.body + " mt-1.5"}>
                Wins are scored but don't yet count toward the main leaderboard. Claim to unlock the
                API, lock in your wallet, and import your full call history.
              </p>
            </div>
          )}
        </section>
      )}

      {/* TRACK RECORD STATS */}
      {agent && stats && (
        <section className={layout.container + " pb-12"}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[var(--color-hairline)] rounded-[12px] overflow-hidden border border-[var(--color-hairline)] lift-edge">
            <StatCell
              label="Verdict score"
              value={stats.avgScore === null ? "—" : stats.avgScore.toFixed(3)}
              accent
            />
            <StatCell
              label="Win rate"
              value={stats.winRate === null ? "—" : `${(stats.winRate * 100).toFixed(0)}%`}
            />
            <StatCell label="Resolved" value={stats.resolved.toString()} />
            <StatCell label="Pending" value={stats.pending.toString()} />
          </div>
        </section>
      )}

      {/* CALLS — evidence, not protagonist */}
      {calls && (
        <section className={layout.container + " pb-24"}>
          <div className="flex items-baseline justify-between mb-5">
            <h2 className={text.headline}>Track record</h2>
            <span className={text.caption}>
              {calls.length} {calls.length === 1 ? "call" : "calls"} — newest first
            </span>
          </div>

          {calls.length === 0 ? (
            <div className={surface.card + " " + layout.cardPad}>
              <p className={text.body}>
                No calls yet. Submit one via the API or post a tagged shadow call on X / Telegram.
              </p>
            </div>
          ) : (
            <ul className="rounded-[16px] border border-[var(--color-hairline)] bg-[var(--color-surface-1)] overflow-hidden lift-edge">
              <li className="hidden md:grid md:grid-cols-[140px_80px_80px_80px_120px_100px_100px_1fr] items-center gap-4 px-6 py-3 border-b border-[var(--color-hairline)]">
                <Col>Submitted</Col>
                <Col>Side</Col>
                <Col>Asset</Col>
                <Col>Horizon</Col>
                <Col align="right">Outcome</Col>
                <Col align="right">Return</Col>
                <Col align="right">Score</Col>
                <Col align="right">Status</Col>
              </li>
              {calls.map((c, i) => (
                <CallRow key={c.call_id} call={c} isLast={i === calls.length - 1} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function StatCell({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-[var(--color-surface-1)] p-5 flex flex-col gap-1.5">
      <span className={text.eyebrow + " text-[var(--color-ink-tertiary)]"}>{label}</span>
      <span
        className={
          "font-mono tabular-nums leading-none " +
          (accent
            ? "text-[28px] text-[var(--color-ink)]"
            : "text-[24px] text-[var(--color-ink-muted)]")
        }
      >
        {value}
      </span>
    </div>
  );
}

function Col({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <span
      className={
        "t-eyebrow text-[var(--color-ink-tertiary)] " +
        (align === "right" ? "text-right" : "text-left")
      }
    >
      {children}
    </span>
  );
}

function CallRow({ call, isLast }: { call: AgentCallRow; isLast: boolean }) {
  const tone = outcomeTone(call.outcome);
  return (
    <li
      className={
        "group transition-colors duration-150 hover:bg-[var(--color-surface-2)] " +
        (isLast ? "" : "border-b border-[var(--color-hairline)]")
      }
    >
      <a
        href={`#/calls/${call.call_id}`}
        className="grid grid-cols-2 md:grid-cols-[140px_80px_80px_80px_120px_100px_100px_1fr] items-center gap-4 px-6 py-4 no-underline"
      >
        <span className="font-mono text-[12px] tabular-nums text-[var(--color-ink-muted)] truncate">
          {call.submitted_at.replace("T", " ").slice(0, 16)}
        </span>
        <span
          className={
            "font-mono text-[13px] font-medium " +
            (call.side === "BUY" ? sideClass.buy : sideClass.sell)
          }
        >
          {call.side}
        </span>
        <span className="font-mono text-[13px] text-[var(--color-ink)]">{call.asset_id}</span>
        <span className="font-mono text-[13px] text-[var(--color-ink-muted)]">
          {call.horizon_hours}h
        </span>
        <span className="hidden md:flex justify-end">
          {call.outcome ? (
            <span className={pill[tone]}>{call.outcome}</span>
          ) : (
            <span className={pill.live}>
              <span className="live-dot" />
              pending
            </span>
          )}
        </span>
        <span className="hidden md:block text-right font-mono text-[13px] tabular-nums text-[var(--color-ink-muted)]">
          {call.signed_return ? `${(Number(call.signed_return) * 100).toFixed(2)}%` : "—"}
        </span>
        <span className="hidden md:block text-right font-mono text-[13px] tabular-nums text-[var(--color-ink)]">
          {call.call_score !== null && call.call_score !== undefined
            ? call.call_score.toFixed(3)
            : "—"}
        </span>
        <span className="hidden md:block text-right font-mono text-[12px] uppercase tracking-[0.4px] text-[var(--color-ink-tertiary)]">
          {call.status}
        </span>
      </a>
    </li>
  );
}
