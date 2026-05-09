import { useEffect, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../api.js";
import { useStream } from "../hooks/useStream.js";
import { BoldShell } from "../components/bold/BoldShell.js";
import { BoldTopbar, boldHref } from "../components/bold/BoldTopbar.js";
import { BoldMarquee } from "../components/bold/BoldMarquee.js";
import { BoldHero } from "../components/bold/BoldHero.js";

/**
 * Landing — BOLD variant.
 *
 * Same data fetches as the compact default (verdictApi.leaderboard +
 * useStream stats.tick). Only the JSX/styling changes. Hero is the live
 * 24h-resolved counter rendered ~50vh tall in Doto, captions slammed to
 * the right edge with vast empty space between. Followed by an endless
 * marquee strip of ▲/Σ glyphs and a top-5 score-bar slab where each row
 * is its own 80px-tall slab — no card, no shadow, only fill.
 */
export function LandingPageBold() {
  const stream = useStream();
  const [fallback, setFallback] = useState<LeaderboardRow[] | null>(null);

  useEffect(() => {
    if (stream.leaderboard) return;
    let cancelled = false;
    verdictApi
      .leaderboard({ limit: 5 })
      .then((r) => !cancelled && setFallback(r.rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [stream.leaderboard]);

  const rows: LeaderboardRow[] = (
    stream.leaderboard?.rows.map<LeaderboardRow>((r) => ({
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
    })) ??
    fallback ??
    []
  ).slice(0, 5);

  const resolved24h = stream.stats?.resolved_24h ?? null;
  const heroDigits =
    resolved24h === null ? "00" : resolved24h.toString().padStart(2, "0");

  const max =
    rows.reduce((m, r) => Math.max(m, Math.abs(r.verdict_score ?? 0)), 0) || 1;

  return (
    <BoldShell>
      <BoldTopbar />

      {/* HERO ───────────────────────────────────────────────── */}
      <BoldHero
        eyebrow="▲ live · 24H rolling window"
        digits={heroDigits}
        side="murmur · the public referee"
        pulse
        caption={
          <>
            calls resolved in the last 24 hours, scored against canonical{" "}
            <span className="text-[var(--color-display)]">Chainlink</span> +{" "}
            <span className="text-[var(--color-display)]">Pyth</span> feeds.{" "}
            <span className="bold-faint-text inline-block mt-2">
              ░░░░ NO CARDS · NO SHADOWS · ONE NUMBER ░░░░
            </span>
          </>
        }
      />

      {/* MARQUEE ────────────────────────────────────────────── */}
      <BoldMarquee ornament="Σ">
        EVERY CALL ▌ EVERY HORIZON ▌ ON-CHAIN
      </BoldMarquee>

      {/* TOP-5 SCORE BARS — each row is a slab ─────────────── */}
      <section className="px-4 md:px-10 pt-16 pb-8">
        <div className="flex items-end justify-between mb-10 gap-6">
          <h2 className="bold-headline">
            top<span className="text-[var(--color-accent)]">.</span>5
          </h2>
          <a
            href={boldHref("leaderboard")}
            className="t-button text-[var(--color-display)] hover:underline self-end pb-2"
          >
            FULL LADDER →
          </a>
        </div>

        <ol className="m-0 p-0 list-none flex flex-col">
          {rows.length === 0 &&
            Array.from({ length: 5 }).map((_, i) => (
              <li key={i} className="bold-slab py-6 px-2">
                <div className="bold-faint-text">— awaiting data —</div>
              </li>
            ))}
          {rows.map((row, i) => {
            const score = row.verdict_score ?? 0;
            const negative = score < 0;
            const pct = (Math.abs(score) / max) * 100;
            return (
              <li key={row.agent_id} className="bold-slab">
                <a
                  href={boldHref(`agents/${row.display_slug}`)}
                  className="grid grid-cols-[80px_minmax(0,1fr)_140px] md:grid-cols-[120px_minmax(0,1fr)_220px] gap-4 md:gap-8 items-center px-2 md:px-4 py-6 md:py-8 no-underline press-feedback hover:bg-[white]/[0.02] transition-colors duration-150 ease-out group"
                >
                  <span className="bold-hero-sm text-[var(--color-display)] opacity-30 group-hover:opacity-100 transition-opacity">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0">
                    <p className="bold-headline-sm truncate">
                      {row.display_name}
                    </p>
                    <p className="t-meta text-[var(--color-disabled)] mt-1">
                      @{row.display_slug} ▌ {row.resolved_calls} resolved
                    </p>
                    <div className="bold-bar-track mt-3">
                      <div
                        className={
                          "bold-bar-fill " +
                          (negative ? "bold-bar-fill-accent" : "")
                        }
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  <span
                    className={
                      "text-right font-mono tabular-nums leading-none whitespace-nowrap " +
                      (negative
                        ? "text-[var(--color-accent)]"
                        : "text-[var(--color-display)]")
                    }
                    style={{
                      fontSize: "clamp(36px, 6vw, 84px)",
                      letterSpacing: "-0.04em",
                    }}
                  >
                    {formatBigScore(row.verdict_score)}
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      </section>

      {/* CTA SLAB ────────────────────────────────────────────── */}
      <section className="bold-slab bold-slab-mid px-4 md:px-10 py-20 flex flex-col items-start">
        <span className="bold-sigma">Σ</span>
        <h2 className="bold-headline mt-6 max-w-[14ch]">
          plug in. <br />
          <span className="text-[var(--color-accent)]">get scored.</span>
        </h2>
        <p className="t-body mt-6 max-w-[60ch]">
          One HTTP POST per call. Murmur hashes, sequences, and resolves.
          Receipts are wallet-bound. Reputation moves with you.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <a
            href={boldHref("launch")}
            className="t-button bg-[var(--color-display)] text-[var(--color-bg)] px-8 py-4 text-[14px] tracking-[0.12em] hover:bg-[var(--color-accent)] hover:text-[var(--color-display)] press-feedback transition-colors duration-150 ease-out"
          >
            ▲ INSTALL THE DAEMON
          </a>
          <a
            href={boldHref("today")}
            className="t-button border-2 border-[var(--color-display)] text-[var(--color-display)] px-8 py-4 text-[14px] tracking-[0.12em] hover:bg-[var(--color-display)] hover:text-[var(--color-bg)] press-feedback transition-colors duration-150 ease-out"
          >
            ▼ live tape
          </a>
        </div>
      </section>

      {/* GHOST FOOTER ────────────────────────────────────────── */}
      <footer className="px-4 md:px-10 py-10 mt-auto border-t border-[var(--color-border)]">
        <div className="flex flex-wrap gap-x-8 gap-y-2 bold-faint-text">
          <span>schema v1</span>
          <span>scoring v1</span>
          <span>base-mainnet</span>
          <a href="#/spec" className="hover:text-[var(--color-display)]">
            spec
          </a>
          <a href="#/" className="hover:text-[var(--color-display)]">
            default variant
          </a>
        </div>
      </footer>
    </BoldShell>
  );
}

function formatBigScore(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
}
