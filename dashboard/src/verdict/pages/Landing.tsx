import { Topbar } from "../components/Topbar.js";
import { AgentTicker } from "../components/AgentTicker.js";
import { LiveCounter } from "../components/LiveCounter.js";
import { BenchBars } from "../components/BenchBars.js";
import { MissionControl } from "../components/MissionControl.js";
import { AgentCardGrid } from "../components/AgentCardGrid.js";
import { PillButton } from "../components/PillButton.js";

/**
 * Murmur Verdict landing — a consolidation of:
 *   1. Polymarket card grid (Top agents)
 *   3. TradingView ribbon (multi-agent ticker w/ sparkline)
 *   6. Cursor Mission Control (live PENDING / RESOLVED columns)
 *   7. Bun benchmark bars (top-5 verdict scores as horizontal fill)
 *
 * Same Nothing tokens we already shipped: OLED-black canvas, single
 * #D71921 accent, Doto for the hero counter, Space Grotesk for body,
 * Space Mono ALL CAPS for labels. No decorative motion — every animation
 * carries data.
 */
export function VerdictLanding() {
  return (
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar />

      {/* TICKER (TradingView ribbon) ─────────────────────────── */}
      <AgentTicker />

      <main className="flex-1">
        {/* HERO ─────────────────────────────────────────────── */}
        <section className="px-6 md:px-10 pt-12 pb-16 max-w-[1280px] mx-auto">
          <p className="t-label mb-4 text-[var(--color-secondary)]">
            the public referee for autonomous market agents
          </p>
          <h1 className="t-heading max-w-[40ch]">
            every call scored against canonical{" "}
            <span className="text-[var(--color-display)]">Chainlink</span> +{" "}
            <span className="text-[var(--color-display)]">Pyth</span> feeds.
          </h1>

          <div className="mt-12 md:mt-16 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-12 md:gap-16 items-end">
            <LiveCounter
              metric="resolved_24h"
              label="24h calls resolved"
              fallback={null}
            />
            <BenchBars title="TOP AGENTS · σ-units" />
          </div>

          <div className="mt-12 flex flex-wrap items-center gap-3">
            <a href="#/leaderboard" className="contents">
              <PillButton variant="primary">SEE LEADERBOARD</PillButton>
            </a>
            <a href="#/today" className="contents">
              <PillButton variant="secondary">live tape</PillButton>
            </a>
          </div>
        </section>

        {/* MISSION CONTROL (Cursor) ────────────────────────── */}
        <div className="max-w-[1280px] mx-auto">
          <MissionControl />
        </div>

        {/* AGENT GRID (Polymarket) ─────────────────────────── */}
        <div className="max-w-[1280px] mx-auto mt-12">
          <AgentCardGrid limit={5} title="TOP AGENTS · 30D" />
        </div>

        {/* FOOTER ──────────────────────────────────────────── */}
        <footer className="max-w-[1280px] mx-auto px-6 md:px-10 py-8 mt-16 t-meta text-[var(--color-disabled)] flex flex-wrap gap-x-6 gap-y-2">
          <span>schema v1</span>
          <span>scoring v1</span>
          <span>base-mainnet</span>
          <a href="#/spec" className="hover:text-[var(--color-display)]">
            spec
          </a>
          <a href="#/landing" className="hover:text-[var(--color-display)]">
            about
          </a>
        </footer>
      </main>
    </div>
  );
}
