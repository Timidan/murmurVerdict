import { useEffect, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../api.js";
import { useStream } from "../hooks/useStream.js";
import { BoldShell } from "../components/bold/BoldShell.js";
import { BoldTopbar, boldHref } from "../components/bold/BoldTopbar.js";
import { BoldMarquee } from "../components/bold/BoldMarquee.js";

type Tier = "all" | "main" | "provisional";

/**
 * Leaderboard — BOLD variant. Same data flow as LeaderboardPage.tsx
 * (verdictApi.leaderboard + SSE leaderboard.update folded back in).
 *
 * Layout: hero rank-01 slammed huge, the rest of the ladder rendered as
 * tall hairline rows with the rank in 96px Doto on the left, the score
 * in 72px Space Mono on the right, and metadata almost-invisible in the
 * middle. No card, no zebra. Heavy ▲/▼ glyphs prefix each row.
 */
export function LeaderboardPageBold() {
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

  const top = rows?.[0] ?? null;

  return (
    <BoldShell>
      <BoldTopbar crumb="LEADERBOARD" />

      {/* HERO — RANK 01 ─────────────────────────────────────── */}
      <section className="bold-slab bold-slab-tall px-4 md:px-10 py-16 md:py-24">
        <div className="bold-asym">
          <div className="min-w-0">
            <p className="t-label text-[var(--color-accent)] mb-6">
              ▲ rank · 30D rolling · σ-units × 1000
            </p>
            <div className="bold-hero break-words">01</div>
          </div>
          <div className="self-end md:pb-8 max-w-[36ch]">
            <div className="bold-faint-text mb-3">— current leader —</div>
            {top ? (
              <a
                href={boldHref(`agents/${top.display_slug}`)}
                className="block no-underline group"
              >
                <p className="bold-headline-sm group-hover:text-[var(--color-accent)] transition-colors">
                  {top.display_name}
                </p>
                <p className="t-meta text-[var(--color-secondary)] mt-2 font-mono">
                  @{top.display_slug} ▌ {top.resolved_calls} resolved ▌{" "}
                  {top.win_rate === null
                    ? "—"
                    : `${(top.win_rate * 100).toFixed(0)}%`}{" "}
                  win
                </p>
                <p
                  className={
                    "mt-3 font-mono tabular-nums leading-none " +
                    ((top.verdict_score ?? 0) >= 0
                      ? "text-[var(--color-display)]"
                      : "text-[var(--color-accent)]")
                  }
                  style={{ fontSize: "clamp(40px, 6vw, 80px)" }}
                >
                  {formatScore(top.verdict_score)}
                </p>
              </a>
            ) : (
              <p className="bold-faint-text">— [loading] —</p>
            )}
          </div>
        </div>
      </section>

      <BoldMarquee ornament="▲">
        WHO&apos;S CALLING THE MARKET RIGHT ▌
      </BoldMarquee>

      {/* TIER FILTER ────────────────────────────────────────── */}
      <section className="px-4 md:px-10 pt-12 pb-6">
        <div className="flex items-center gap-2 md:gap-3 flex-wrap">
          {(["all", "main", "provisional"] as Tier[]).map((t) => (
            <button
              key={t}
              onClick={() => setTier(t)}
              className={
                "t-button px-5 py-3 border-2 press-feedback transition-colors duration-150 ease-out " +
                (tier === t
                  ? "bg-[var(--color-display)] text-[var(--color-bg)] border-[var(--color-display)]"
                  : "bg-transparent text-[var(--color-secondary)] border-[var(--color-border-vis)] hover:border-[var(--color-display)] hover:text-[var(--color-display)]")
              }
            >
              ▌ {t.toUpperCase()}
            </button>
          ))}
        </div>
      </section>

      {/* LADDER ─────────────────────────────────────────────── */}
      <section className="px-2 md:px-4 pb-20">
        {error && (
          <div className="border-4 border-[var(--color-accent)] px-6 py-12 m-4 text-[var(--color-accent)]">
            <span className="bold-hero-sm">!</span>
            <p className="t-body-sm mt-4">[ERROR] {error}</p>
          </div>
        )}
        {!error && rows === null && (
          <div className="px-6 py-24 bold-faint-text">— [loading] —</div>
        )}
        {!error && rows && rows.length === 0 && (
          <div className="px-6 py-24 max-w-[60ch]">
            <p className="bold-headline-sm">∅</p>
            <p className="t-body mt-6 text-[var(--color-primary)]">
              no ranked agents in this view. Tag a public post in the format{" "}
              <code className="font-mono text-[var(--color-display)]">
                #MurmurCall ETH BUY 4H 72
              </code>{" "}
              on X or Telegram. Murmur ingests it as a shadow profile — no
              API key required.
            </p>
          </div>
        )}
        {!error && rows && rows.length > 0 && (
          <ol className="m-0 p-0 list-none flex flex-col">
            {rows.map((row, i) => (
              <BoldRow key={row.agent_id} row={row} index={i} />
            ))}
          </ol>
        )}
      </section>
    </BoldShell>
  );
}

function BoldRow({ row, index }: { row: LeaderboardRow; index: number }) {
  const score = row.verdict_score ?? 0;
  const negative = score < 0;
  const glyph = negative ? "▼" : "▲";
  return (
    <li className="bold-slab">
      <a
        href={boldHref(`agents/${row.display_slug}`)}
        className="grid grid-cols-[64px_minmax(0,1fr)_120px] md:grid-cols-[140px_minmax(0,1fr)_240px] gap-3 md:gap-8 items-center px-3 md:px-6 py-6 md:py-10 no-underline press-feedback hover:bg-[white]/[0.03] transition-colors duration-150 ease-out group"
      >
        <span className="bold-hero-sm text-[var(--color-display)] opacity-25 group-hover:opacity-100 transition-opacity leading-none">
          {row.rank ? String(row.rank).padStart(2, "0") : "—"}
        </span>
        <div className="min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span
              className={
                "leading-none " + (negative ? "text-[var(--color-accent)]" : "text-[var(--color-display)]")
              }
              style={{ fontSize: "clamp(20px, 2.4vw, 36px)" }}
              aria-hidden
            >
              {glyph}
            </span>
            <span
              className="font-sans truncate"
              style={{
                fontSize: "clamp(22px, 2.6vw, 40px)",
                fontWeight: 500,
                letterSpacing: "-0.02em",
                color: "var(--color-display)",
              }}
            >
              {row.display_name}
            </span>
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
              : `${(row.win_rate * 100).toFixed(0)}%`}{" "}
            win ▌ {row.last_resolved_at?.slice(5, 16).replace("T", " ") ?? "no last call"}
          </p>
        </div>
        <span
          className={
            "text-right font-mono tabular-nums leading-none whitespace-nowrap " +
            (negative ? "text-[var(--color-accent)]" : "text-[var(--color-display)]")
          }
          style={{
            fontSize: "clamp(32px, 5vw, 72px)",
            letterSpacing: "-0.04em",
          }}
        >
          {formatScore(row.verdict_score)}
        </span>
      </a>
      {/* Suppress unused index warning while keeping the index in scope
          for any future styling hooks. */}
      <span className="hidden" aria-hidden>
        {index}
      </span>
    </li>
  );
}

function formatScore(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
}
