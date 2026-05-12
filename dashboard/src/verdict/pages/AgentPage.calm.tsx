import { useEffect, useMemo, useState } from "react";
import {
  verdictApi,
  type AgentCallRow,
  type AgentProfile,
} from "../api.js";
import { useFollow } from "../hooks/useFollow.js";
import { CalmShell } from "../components/calm/CalmShell.js";
import { CalmTopbar } from "../components/calm/CalmTopbar.js";
import { CalmFooter } from "../components/calm/CalmFooter.js";
import { CalmStatRow } from "../components/calm/CalmStatRow.js";
import { CalmCallList } from "../components/calm/CalmCallList.js";
import { CalmScore } from "../components/calm/CalmScore.js";

/**
 * CALM agent page — one column, four scrolls. Hero score (the artwork),
 * placard with name + kind + wallet, single-row stats, calls as a
 * vertical list, optional shadow notice. No embed snippets, no heat
 * grid (calm strips ornament — those live on the default page where
 * power-user density wins).
 *
 * Same data fetches as AgentPage.tsx — verdictApi.agent + agentCalls.
 */
export function AgentPageCalm({ slug }: { slug: string }) {
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
    <CalmShell>
      <CalmTopbar
        crumb={
          <span>
            agents <span className="mx-2">·</span>
            <span style={{ color: "var(--calm-ink)" }}>
              {agent?.display_slug ?? slug}
            </span>
          </span>
        }
      />

      <main>
        {error && (
          <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-section">
            <p className="calm-body" style={{ color: "var(--calm-ink-faint)" }}>
              Could not load this agent. {error}
            </p>
          </section>
        )}

        {!error && !agent && (
          <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-section">
            <p className="calm-body">Loading.</p>
          </section>
        )}

        {agent && (
          <>
            {/* HERO ─ score as the artwork ───────────────────────── */}
            <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-section">
              <p className="calm-eyebrow mb-10 calm-enter">Verdict score · 30-day rolling</p>
              <CalmScore
                value={stats?.avgScore ?? null}
                caption="σ-units, mean of resolved-call scores"
              />

              {/* PLACARD: name + kind + wallet + actions */}
              <div className="mt-24 flex flex-wrap items-end justify-between gap-x-12 gap-y-8">
                <div>
                  <h1 className="calm-headline">{agent.display_name}</h1>
                  <div className="mt-4 flex flex-wrap items-baseline gap-4 calm-meta">
                    <span>@{agent.display_slug}</span>
                    <span className="calm-kind">{agent.kind.replace("_", " ")}</span>
                    {agent.wallet_address && (
                      <a
                        href={`https://basescan.org/address/${agent.wallet_address}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-[var(--calm-ink)] transition-colors"
                      >
                        {agent.wallet_address.slice(0, 6)}…{agent.wallet_address.slice(-4)}
                      </a>
                    )}
                  </div>
                  {agent.bio && (
                    <p className="calm-body mt-8">{agent.bio}</p>
                  )}
                </div>
                <div className="flex items-center gap-6">
                  {following ? (
                    <button onClick={toggle} className="calm-button-ghost">
                      Following · unfollow
                    </button>
                  ) : (
                    <button onClick={toggle} className="calm-button">
                      Follow
                    </button>
                  )}
                  <a href={`#/share/${agent.display_slug}`} className="calm-link">
                    Share
                  </a>
                </div>
              </div>
            </section>

            {/* STATS ROW */}
            {stats && (
              <section className="max-w-[1080px] mx-auto px-6 md:px-10">
                <CalmStatRow
                  stats={[
                    {
                      label: "Resolved",
                      value: stats.resolved.toString().padStart(2, "0"),
                      unit: "/30d",
                    },
                    {
                      label: "Win rate",
                      value:
                        stats.winRate === null
                          ? "—"
                          : Math.round(stats.winRate * 100).toString(),
                      unit: stats.winRate === null ? undefined : "%",
                    },
                    {
                      label: "Pending",
                      value: stats.pending.toString().padStart(2, "0"),
                    },
                    {
                      label: "Streak",
                      value: stats.streak.toString().padStart(2, "0"),
                      unit: "wins",
                    },
                  ]}
                />
              </section>
            )}

            {/* CALLS */}
            {calls && (
              <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-section">
                <CalmCallList calls={calls} title="Recent calls" />
              </section>
            )}

            {/* Wave 1 — shadow profile notice + CLAIM CTA removed.
                Self-serve claim flow deleted; shadow agents from the
                v0.1 era are now decorative leaderboard entries until
                an operator manually flips them via the admin CLI
                (Wave 5). */}
          </>
        )}
      </main>

      <CalmFooter />
    </CalmShell>
  );
}
