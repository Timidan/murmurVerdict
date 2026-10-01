import { useEffect } from "react";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { Stat, StatStrip } from "../components/compact/StatStrip.js";
import { TimeAgo } from "../components/compact/TimeAgo.js";
import { CompactLiveFeed } from "../components/compact/LiveFeed.js";
import { CompactMarketsGrid } from "../components/compact/MarketsGrid.js";
import { useStream } from "../hooks/useStream.js";
import { useFunnelEmit } from "../hooks/useFunnelEmit.js";
import { formatAtoms } from "../lib/atoms-format.js";

/**
 * COMPACT overview — the live counter, the all-time record strip, then the
 * live tape beside the markets matrix. No hero, no marketing copy.
 */
export function LandingPage() {
  const { stats, statsAt, status } = useStream();
  const emitFunnel = useFunnelEmit();

  // funnel pageview. Best-effort: only fires when Privy is
  // configured + the user has a session. Anonymous visitors are dropped
  // on the floor by useFunnelEmit until a future buffer-on-signin pass.
  useEffect(() => {
    void emitFunnel("landing.viewed");
  }, [emitFunnel]);

  return (
    <div className="ck-page flex-1 flex flex-col pt-2">
      {/* Span wrap lets the touch crumb rule ellipsize it (bare text cannot). */}
      <TopbarCrumb><span>home / overview</span></TopbarCrumb>

      {/* LIVE COUNTER ─────────────────────────────────────────────
          V14 decision #2 — `/` is an instrument-cluster animated landing
          with a Doto live counter as the hero. Counts resolved verdicts
          in the last 24h; SSE `stats.tick` pushes a fresh value every
          ~10s without rerouting the page. */}
      <LiveCounter
        value={stats?.resolved_24h ?? null}
        label="Verdicts scored · last 24h"
        updatedAt={statsAt}
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
      <StatStrip>
        <Stat
          label="USDC paid to providers"
          value={stats ? formatAtoms(stats.provider_paid_usdc_atoms, "USDC") : null}
          note="all time. net of reversals"
          title="Sum of recorded provider payouts in USDC, less reversals."
        />
        <Stat
          label="Calls sealed"
          value={stats?.calls_sealed?.toLocaleString("en-US") ?? null}
          note="all time"
          title="All accepted sealed calls, including calls that have since been revealed or resolved."
        />
        <Stat
          label="Agents registered"
          value={stats?.agents_registered?.toLocaleString("en-US") ?? null}
          note="all time. deleted ones included"
          title="Every agent and attested agent ever registered. Benchmark and test agents are left out."
        />
      </StatStrip>

      {/* MAIN GRID — live tape left, markets matrix right with the extra room
          plus its filter bar. The leaderboard has its own page. */}
      <main className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.9fr)] gap-x-8 gap-y-6 items-start">
        <Panel
          title="Live tape"
          meta={
            stats
              ? `${stats.accepted_24h + stats.resolved_24h} in 24h`
              : ""
          }
        >
          <CompactLiveFeed limit={50} />
        </Panel>
        <Panel
          title="Markets"
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
  updatedAt,
}: {
  value: number | null;
  label: string;
  sublabel: string;
  /** Client receive time of the last stats.tick; null before the first one. */
  updatedAt: number | null;
}) {
  return (
    <section className="border-b border-[var(--color-border)] flex items-end justify-between py-3 gap-4">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="ck-colhead">{label}</span>
        {/* Wraps rather than truncates: the freshness stamp is the tail of this
            line and a narrow column would clip it away. */}
        <span className="ck-dim text-[12px]" title={sublabel}>
          {sublabel}
          {updatedAt !== null && (
            <>
              {" · updated "}
              <TimeAgo iso={new Date(updatedAt).toISOString()} />
            </>
          )}
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
