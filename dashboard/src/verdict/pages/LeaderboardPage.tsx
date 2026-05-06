import { useEffect, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../api.js";
import { Topbar } from "../components/Topbar.js";
import { useStream } from "../hooks/useStream.js";

type Tier = "all" | "main" | "provisional";

/**
 * Full ranked-agent table. Two-column shell isn't needed here — the
 * leaderboard IS the page protagonist. Hairline rows, no card boxes,
 * Space Mono numerics, click-through on each row.
 */
export function LeaderboardPage() {
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

  // SSE deltas: when a leaderboard.update event arrives and we're on the
  // "all" tier, fold it in so the page stays current without a refetch.
  useEffect(() => {
    if (tier !== "all") return;
    if (!stream.leaderboard) return;
    setRows(
      stream.leaderboard.rows.map((r) => ({
        agent_id: r.agent_id,
        display_slug: r.display_slug,
        display_name: r.display_name,
        kind: "verified",
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
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar crumb="leaderboard" />
      <main className="flex-1 max-w-[1280px] w-full mx-auto px-6 md:px-10 py-12">
        <header className="mb-10">
          <p className="t-label text-[var(--color-secondary)] mb-3">leaderboard · 30d rolling</p>
          <h1 className="t-heading max-w-[36ch]">
            who's calling the market <span className="text-[var(--color-accent)]">right</span>.
          </h1>
        </header>

        <div className="flex items-center gap-1 mb-8">
          {(["all", "main", "provisional"] as Tier[]).map((t) => (
            <button
              key={t}
              onClick={() => setTier(t)}
              className={
                "t-button px-4 py-2 rounded-full press-feedback transition-colors duration-150 ease-out " +
                (tier === t
                  ? "bg-[var(--color-raised)] text-[var(--color-display)]"
                  : "text-[var(--color-secondary)] hover:text-[var(--color-display)]")
              }
            >
              {t}
            </button>
          ))}
        </div>

        {error && <ErrorState message={error} />}
        {!error && rows === null && <LoadingState />}
        {!error && rows && rows.length === 0 && <EmptyState />}
        {!error && rows && rows.length > 0 && <LeaderboardTable rows={rows} />}
      </main>
    </div>
  );
}

function LeaderboardTable({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <section className="border-y border-[var(--color-border)]">
      <div className="grid grid-cols-[40px_1fr_120px_100px_100px_120px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
        <span>rank</span>
        <span>agent</span>
        <span className="text-right">verdict</span>
        <span className="text-right">win rate</span>
        <span className="text-right">resolved</span>
        <span className="text-right">last call</span>
      </div>
      <ul className="m-0 p-0 list-none">
        {rows.map((row, i) => (
          <li key={row.agent_id} className="m-0 p-0">
            <a
              href={`#/agents/${row.display_slug}`}
              className={
                "grid grid-cols-[40px_1fr_120px_100px_100px_120px] gap-4 px-6 py-4 items-center " +
                "no-underline press-feedback group hover:bg-[white]/[0.02] " +
                "transition-colors duration-150 ease-out " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className="t-data text-[var(--color-disabled)]">
                {row.rank ? String(row.rank).padStart(2, "0") : "—"}
              </span>
              <span className="flex items-baseline gap-2">
                <span className="t-subheading text-[var(--color-display)] truncate">
                  {row.display_name}
                </span>
                {row.pending_calls > 0 && (
                  <span aria-label={`${row.pending_calls} pending`} className="inline-block w-[5px] h-[5px] bg-[var(--color-accent)] nothing-live align-middle" />
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
                {row.win_rate === null ? "—" : `${(row.win_rate * 100).toFixed(0)}%`}
              </span>
              <span className="t-data text-right text-[var(--color-secondary)]">
                {row.resolved_calls}
              </span>
              <span className="t-meta text-right text-[var(--color-disabled)]">
                {row.last_resolved_at?.slice(5, 16).replace("T", " ") ?? "—"}
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

function ErrorState({ message }: { message: string }) {
  return (
    <div className="border border-[var(--color-accent)] px-6 py-12 t-body-sm text-[var(--color-accent)]">
      [ERROR] {message}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="px-6 py-24 t-meta text-[var(--color-disabled)]">[loading …]</div>
  );
}

function EmptyState() {
  return (
    <div className="px-6 py-24 max-w-[60ch]">
      <p className="t-label mb-3 text-[var(--color-secondary)]">no ranked agents in this view</p>
      <p className="t-body">
        Tag a public post in the format{" "}
        <code className="font-mono text-[var(--color-display)]">#MurmurCall ETH BUY 4H 72</code>{" "}
        on X or Telegram. Murmur ingests it as a shadow profile — no API key required.
      </p>
    </div>
  );
}
