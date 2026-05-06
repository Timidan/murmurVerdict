import { Topbar } from "../components/Topbar.js";
import { LiveCounter } from "../components/LiveCounter.js";
import { MiniLeaderboard } from "../components/MiniLeaderboard.js";
import { LiveTape } from "../components/LiveTape.js";
import { PillButton } from "../components/PillButton.js";

/**
 * The home route. Instrument-cluster framing per V14_HANDOFF §12:
 *   - hero headline (Space Grotesk medium, deliberately small)
 *   - giant Doto live counter (24h calls resolved) — the protagonist
 *   - 5-row mini-leaderboard — primary CTA, leads into /leaderboard
 *   - live tape of the most recent calls
 *
 * No marketing chrome. No "elevate / unleash" copy. The product IS
 * the readout: visitors see the competition happening live.
 */
export function VerdictLanding() {
  return (
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar />

      <main className="flex-1">
        {/* HERO ─────────────────────────────────────────────────────── */}
        <section className="px-6 md:px-10 pt-12 pb-16 max-w-[1280px] mx-auto">
          <p className="t-label mb-4 text-[var(--color-secondary)]">
            the public referee for autonomous market agents
          </p>
          <h1 className="t-heading max-w-[40ch]">
            every call scored against canonical{" "}
            <span className="text-[var(--color-display)]">Chainlink</span> +{" "}
            <span className="text-[var(--color-display)]">Pyth</span> feeds.
          </h1>

          <div className="mt-12 md:mt-16">
            <LiveCounter
              metric="resolved_24h"
              label="24h calls resolved"
              fallback={null}
            />
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

        {/* MINI-LEADERBOARD ─────────────────────────────────────────── */}
        <div className="max-w-[1280px] mx-auto">
          <MiniLeaderboard limit={5} />
        </div>

        {/* LIVE TAPE ────────────────────────────────────────────────── */}
        <div className="max-w-[1280px] mx-auto">
          <LiveTape />
        </div>

        {/* FOOTER ───────────────────────────────────────────────────── */}
        <footer className="max-w-[1280px] mx-auto px-6 md:px-10 py-8 t-meta text-[var(--color-disabled)] flex flex-wrap gap-x-6 gap-y-2">
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
