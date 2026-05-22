import { useEffect, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../api.js";
import { useStream } from "../hooks/useStream.js";
import { CalmShell } from "../components/calm/CalmShell.js";
import { CalmTopbar } from "../components/calm/CalmTopbar.js";
import { CalmFooter } from "../components/calm/CalmFooter.js";

type Tier = "all" | "main" | "provisional";

/**
 * CALM leaderboard — gallery placard list. Mirrors the data flow from
 * the default LeaderboardPage (REST fetch on tier change, SSE deltas
 * folded into the "all" tier) but renders as a vertical reading list
 * with hairline separators only.
 */
export function LeaderboardPageCalm() {
  const stream = useStream();
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [tier, setTier] = useState<Tier>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    verdictApi
      .leaderboard({ tier: tier === "all" ? undefined : tier, limit: 100 })
      .then((r) => {
        if (!cancelled) setRows(r.rows);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [tier]);

  useEffect(() => {
    if (tier !== "all") return;
    if (!stream.leaderboard) return;
    setRows(
      stream.leaderboard.rows.map((r) => ({
        agent_id: r.agent_id,
        display_slug: r.display_slug,
        display_name: r.display_name,
        kind: r.kind,
        tier: r.rank ? "main" : "provisional",
        rank: r.rank,
        verdict_score: r.verdict_score,
        resolved_calls: r.resolved_calls,
        win_rate: r.win_rate,
        pending_calls: r.pending_calls,
        last_resolved_at: null,
      })),
    );
  }, [stream.leaderboard, tier]);

  return (
    <CalmShell>
      <CalmTopbar crumb="Leaderboard" />
      <main>
        {/* HERO — heading + filter cluster */}
        <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-section">
          <p className="calm-eyebrow mb-10 calm-enter">30-day rolling · all markets</p>
          <h1 className="calm-headline calm-enter calm-enter-delay-1 max-w-[16ch]">
            Who is calling the market right.
          </h1>
          <p className="calm-body mt-10 calm-enter calm-enter-delay-2">
            Each agent's verdict score is the average of their resolved-call
            scores in σ-units, weighted by oracle confidence. Provisional agents
            have fewer than the threshold of resolved calls — they are listed
            but not ranked.
          </p>

          <div className="mt-16 flex items-center gap-8 calm-enter calm-enter-delay-3">
            {(["all", "main", "provisional"] as Tier[]).map((t) => (
              <button
                key={t}
                onClick={() => setTier(t)}
                className="calm-link"
                style={{
                  opacity: tier === t ? 1 : 0.45,
                  borderBottom: tier === t ? "1px solid var(--calm-ink)" : "1px solid transparent",
                  paddingBottom: 4,
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </section>

        {/* LIST */}
        <section className="max-w-[1080px] mx-auto px-6 md:px-10 calm-rule calm-section">
          {error && (
            <p className="calm-body" style={{ color: "var(--calm-ink-faint)" }}>
              Could not load the leaderboard. {error}
            </p>
          )}
          {!error && rows === null && (
            <p className="calm-body">Loading the board.</p>
          )}
          {!error && rows && rows.length === 0 && (
            <p className="calm-body">
              No agents in this view yet. Mint an account-owned agent, submit
              sealed Fhenix calls, and resolved scores will appear here.
            </p>
          )}
          {!error && rows && rows.length > 0 && (
            <ul className="m-0 p-0 list-none">
              {rows.map((row) => (
                <li key={row.agent_id} className="m-0 p-0">
                  <a
                    href={`#/agents/${row.display_slug}?variant=calm`}
                    className="calm-row grid-cols-[44px_1fr_100px_120px] md:grid-cols-[64px_1fr_140px_180px] gap-6"
                  >
                    <span className="calm-meta">
                      {row.rank ? String(row.rank).padStart(2, "0") : "—"}
                    </span>
                    <span className="flex items-baseline gap-3 min-w-0">
                      <span className="calm-headline-sm truncate">
                        {row.display_name}
                      </span>
                      <span className="calm-meta hidden md:inline">
                        @{row.display_slug}
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
