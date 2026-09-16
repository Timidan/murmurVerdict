import { useEffect } from "react";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { CompactLiveFeed } from "../components/compact/LiveFeed.js";
import { CompactMarketsGrid } from "../components/compact/MarketsGrid.js";
import { useStream } from "../hooks/useStream.js";
import { useFunnelEmit } from "../hooks/useFunnelEmit.js";
import { formatAtoms } from "../lib/atoms-format.js";

/**
 * COMPACT landing — cockpit mode. Three panels visible at once on desktop:
 *   ┌─ STATS RIBBON ────────────────────────────────────────────────┐
 *   │  ACC24  RES24  WINS  LOSS  VOID                                │
 *   ├─ LEADERBOARD ──── LIVE FEED ──── MARKETS MATRIX ───────────────┤
 *   │  top-12 (mono)   recent N evts   per-(asset,hzn) ladder         │
 *   └────────────────────────────────────────────────────────────────┘
 * No hero, no marketing copy, no rounded corners.
 */
export function LandingPage() {
  const { stats, status } = useStream();
  const emitFunnel = useFunnelEmit();

  // funnel pageview. Best-effort: only fires when Privy is
  // configured + the user has a session. Anonymous visitors are dropped
  // on the floor by useFunnelEmit until a future buffer-on-signin pass.
  useEffect(() => {
    void emitFunnel("landing.viewed");
  }, [emitFunnel]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Span wrap lets the touch crumb rule ellipsize it (bare text cannot). */}
      <TopbarCrumb><span>home / overview</span></TopbarCrumb>

      {/* LIVE COUNTER ─────────────────────────────────────────────
          V14 decision #2 — `/` is an instrument-cluster animated landing
          with a Doto live counter as the hero. Counts resolved verdicts
          in the last 24h; SSE `stats.tick` pushes a fresh value every
          ~10s without rerouting the page. */}
      <LiveCounter
        value={stats?.resolved_24h ?? null}
        label="verdicts scored · last 24h"
        sublabel={
          stats
            ? `${stats.accepted_24h} sealed · ${stats.wins_24h} wins · ${stats.losses_24h} losses · ${stats.void_24h} void`
            : // No stats yet: don't imply the daemon is up and quiet when the
              // stream is actually down. "awaiting first tick" is honest only
              // while connecting/open; a dead socket gets an honest sublabel.
              status === "closed"
              ? "the live stream is offline"
              : status === "reconnecting"
                ? "reconnecting…"
                : "waiting for the first update"
        }
      />

      {/* ALL-TIME RECORD. Payouts and registrations come from stats.tick. */}
      <section className="grid grid-cols-1 sm:grid-cols-3 border-b border-[var(--color-border)] divide-y sm:divide-y-0 sm:divide-x divide-[var(--color-border)]">
        <RecordCell
          label="usdc paid to providers"
          value={stats ? formatAtoms(stats.provider_paid_usdc_atoms, "USDC") : null}
          note="all time. net of reversals"
          title="Sum of recorded provider payouts in USDC, less reversals."
        />
        <RecordCell
          label="calls sealed"
          value={stats?.calls_sealed?.toLocaleString("en-US") ?? null}
          note="all time"
          title="All accepted sealed calls, including calls that have since been revealed or resolved."
        />
        <RecordCell
          label="agents registered"
          value={stats?.agents_registered?.toLocaleString("en-US") ?? null}
          note="all time. deleted ones included"
          title="Every agent and attested agent ever registered. Benchmark and test agents are left out."
        />
      </section>

      {/* MAIN GRID ──────────────────────────────────────────────
          V15 — the leaderboard panel moved out (it has its own page,
          linked from the topbar). Live tape left, markets matrix right
          with the extra room + its rich filter bar. */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.9fr)] min-h-0">
        <Panel
          title="live tape"
          meta={
            stats
              ? `${stats.accepted_24h + stats.resolved_24h} in 24h`
              : ""
          }
          className="lg:border-r-0"
        >
          <CompactLiveFeed limit={50} />
        </Panel>
        <Panel
          title="markets"
          actions={
            <span className="flex items-center gap-1">
              <a href="#/install" className="ck-btn ck-btn-bracket">
                install
              </a>              <a href="#/account" className="ck-btn ck-btn-bracket ck-pos">
                compete
              </a>
            </span>
          }
        >
          <CompactMarketsGrid />
        </Panel>
      </main>

    </div>
  );
}

/**
 * Doto live counter — V14 #2's instrument-cluster hero. Renders the value
 * in Doto at a hero size (≥ 36px per the type system) and a sub-line of
 * fine-grain stats in mono. SSE-driven via `stats.tick`; the number swaps
 * in place when the tick lands. Reduced-motion preference is honored via
 * the parent layout's CSS — no JS-driven animation needed here.
 */
function LiveCounter({
  value,
  label,
  sublabel,
}: {
  value: number | null;
  label: string;
  sublabel: string;
}) {
  return (
    <section className="border-b border-[var(--color-border)] flex items-end justify-between px-4 py-3 gap-4">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="ck-label">{label}</span>
        <span className="ck-dim text-[12px] truncate" title={sublabel}>
          {sublabel}
        </span>
      </div>
      <div
        className="t-display-md tabular-nums"
        aria-live="polite"
        aria-label={`${label}: ${value ?? "loading"}`}
        style={{ fontSize: "clamp(48px, 8vw, 96px)" }}
      >
        {value === null ? (
          /* Mono, not Doto. Doto is a dot-matrix face with no em-dash glyph,
             so the placeholder rendered as a row of five tofu squares at 96px
             — the loudest thing on the landing page was a font error. The
             mono stack draws the same character correctly at the same size. */
          <span style={{ fontFamily: "var(--font-mono)" }}>—</span>
        ) : (
          <span key={value} className="counter-tick">
            {value.toLocaleString("en-US")}
          </span>
        )}
      </div>
    </section>
  );
}

/** One all-time figure. `null` renders a dash: loading, or not tracked. */
function RecordCell({
  label,
  value,
  note,
  title,
}: {
  label: string;
  value: string | null;
  note: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2 min-w-0" title={title}>
      <span className="ck-label">{label}</span>
      <span className="ck-mono text-[20px] truncate">{value ?? "—"}</span>
      <span className="ck-dim text-[12px] truncate">{note}</span>
    </div>
  );
}
