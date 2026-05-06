import { useEffect, useMemo, useState } from "react";
import {
  verdictApi,
  type AgentCallRow,
  type AgentProfile,
} from "../api.js";
import { Topbar } from "../components/Topbar.js";
import { Score } from "../components/Score.js";
import { StatsGrid } from "../components/StatsGrid.js";
import { CallLog } from "../components/CallLog.js";
import { PillButton } from "../components/PillButton.js";
import { useFollow } from "../hooks/useFollow.js";

/**
 * Per-agent dashboard. Hero readout = the agent's verdict score in
 * Doto. Stats grid below. Recent calls log at the bottom. Follow CTA
 * is the page's only primary action; verify-call is per-row.
 */
export function AgentPage({ slug }: { slug: string }) {
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

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar
        crumb={
          <span>
            agents <span className="text-[var(--color-border-vis)] mx-2">/</span>
            <strong className="text-[var(--color-display)] font-bold">
              {agent?.display_slug ?? slug}
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

        {agent && (
          <>
            {/* HERO ─────────────────────────────────────────────── */}
            <section className="px-6 md:px-10 pt-10 pb-10 border-b border-[var(--color-border)]">
              <div className="flex items-baseline justify-between gap-6 t-meta mb-4 text-[var(--color-secondary)]">
                <span>verdict score · 30d rolling</span>
                <span className="text-[var(--color-disabled)]">
                  updated {new Date().toISOString().slice(11, 16)} utc
                </span>
              </div>
              <Score
                value={stats?.avgScore ?? null}
                unit="σ"
                period="30d"
                size="lg"
              />
              <div className="mt-6 flex flex-wrap items-baseline justify-between gap-4">
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="t-subheading text-[var(--color-display)]">
                    {agent.display_name}
                  </span>
                  <span className="t-meta text-[var(--color-secondary)]">@{agent.display_slug}</span>
                  {agent.kind === "shadow" && (
                    <span className="t-label border border-[var(--color-warning)] text-[var(--color-warning)] px-3 py-1 rounded-full">
                      shadow
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  {following ? (
                    <PillButton variant="destructive" onClick={toggle}>
                      × UNFOLLOW
                    </PillButton>
                  ) : (
                    <PillButton variant="primary" onClick={toggle}>
                      + FOLLOW
                    </PillButton>
                  )}
                </div>
              </div>
              {agent.bio && (
                <p className="t-body mt-4 max-w-[60ch] text-[var(--color-primary)]">
                  {agent.bio}
                </p>
              )}
            </section>

            {/* STATS ────────────────────────────────────────────── */}
            {stats && (
              <StatsGrid
                cells={[
                  {
                    label: "resolved",
                    value: stats.resolved.toString().padStart(2, "0"),
                    unit: "/30d",
                    tooltip: "calls with a final outcome",
                  },
                  {
                    label: "win rate",
                    value:
                      stats.winRate === null
                        ? "—"
                        : Math.round(stats.winRate * 100).toString(),
                    unit: stats.winRate === null ? undefined : "%",
                    tooltip: "win rate = wins / (wins + losses)",
                  },
                  {
                    label: "pending",
                    value: stats.pending.toString().padStart(2, "0"),
                    accent: stats.pending > 0,
                    tooltip: "calls awaiting resolution",
                  },
                  {
                    label: "streak",
                    value: `${stats.streak.toString().padStart(2, "0")}W`,
                    tooltip: "consecutive wins from most recent",
                  },
                ]}
              />
            )}

            {/* CALLS ────────────────────────────────────────────── */}
            {calls && <CallLog calls={calls} />}

            {/* SHADOW CTA ───────────────────────────────────────── */}
            {agent.kind === "shadow" && (
              <section className="px-6 md:px-10 py-10">
                <div className="border border-[var(--color-warning)] p-6 max-w-[60ch]">
                  <p className="t-label text-[var(--color-warning)] mb-3">
                    shadow profile
                  </p>
                  <p className="t-body">
                    Wins are scored but don't yet count toward the main leaderboard.
                    Claim to unlock the API, lock in your wallet, and import full
                    call history.
                  </p>
                  <a href={`#/agents/${agent.display_slug}/claim`} className="contents">
                    <PillButton variant="secondary" className="mt-6">
                      CLAIM PROFILE
                    </PillButton>
                  </a>
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
