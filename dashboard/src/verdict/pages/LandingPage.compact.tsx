import { useEffect } from "react";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { CompactMiniLB } from "../components/compact/MiniLB.js";
import { CompactLiveFeed } from "../components/compact/LiveFeed.js";
import { CompactMarketsGrid } from "../components/compact/MarketsGrid.js";
import { useStream } from "../hooks/useStream.js";
import { useFunnelEmit } from "../hooks/useFunnelEmit.js";

/**
 * COMPACT landing — cockpit mode. Three panels visible at once on desktop:
 *   ┌─ STATS RIBBON ────────────────────────────────────────────────┐
 *   │  ACC24  RES24  WINS  LOSS  VOID                                │
 *   ├─ LEADERBOARD ──── LIVE FEED ──── MARKETS MATRIX ───────────────┤
 *   │  top-12 (mono)   recent N evts   per-(asset,hzn) ladder         │
 *   └────────────────────────────────────────────────────────────────┘
 * No hero, no marketing copy, no rounded corners.
 */
export function LandingPageCompact() {
  const { stats } = useStream();
  const emitFunnel = useFunnelEmit();

  // Phase 7d — funnel pageview. Best-effort: only fires when Privy is
  // configured + the user has a session. Anonymous visitors are dropped
  // on the floor by useFunnelEmit until a future buffer-on-signin pass.
  useEffect(() => {
    void emitFunnel("landing.viewed");
  }, [emitFunnel]);

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar crumb="home / overview" />

      {/* STATS RIBBON ─────────────────────────────────────────── */}
      <section className="grid grid-cols-5 border-b border-[var(--color-border)]">
        <Stat label="acc·24h" value={stats?.accepted_24h ?? "—"} />
        <Stat label="res·24h" value={stats?.resolved_24h ?? "—"} />
        <Stat label="win·24h" value={stats?.wins_24h ?? "—"} tone="pos" />
        <Stat label="loss·24h" value={stats?.losses_24h ?? "—"} tone="neg" />
        <Stat label="void·24h" value={stats?.void_24h ?? "—"} tone="dim" />
      </section>

      {/* MAIN GRID ────────────────────────────────────────────── */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)] min-h-0">
        <Panel
          title="leaderboard · 30d"
          meta="top 12"
          actions={
            <a href="#/leaderboard" className="ck-btn">
              full
            </a>
          }
          className="lg:border-r-0"
        >
          <CompactMiniLB limit={12} />
        </Panel>
        <Panel
          title="live tape"
          meta={
            stats
              ? `${stats.accepted_24h + stats.resolved_24h} evt/24h`
              : ""
          }
          className="lg:border-r-0"
        >
          <CompactLiveFeed limit={50} />
        </Panel>
        <Panel
          title="markets matrix"
          actions={
            <span className="flex items-center gap-1">
              <a href="#/launch" className="ck-btn">
                install
              </a>
              {/* Phase 7d — primary "compete" CTA. The ?ref=landing-cta
                  param is the attribution tag AccountPage reads to fire
                  the compete.clicked funnel event. The button label
                  matches the LoginPage breadcrumb idiom (COMPETE).

                  Codex P2 fix — unauth users get bounced to the login
                  page which strips the ref query before AccountPage
                  ever sees it. Persist a small latch in localStorage at
                  click time so the post-login AccountPage can emit
                  compete.clicked regardless of how the URL mutated
                  through the login flow. */}
              <a
                href="#/account?ref=landing-cta"
                className="ck-btn ck-pos"
                onClick={() => {
                  try {
                    window.localStorage.setItem(
                      "murmur_funnel_compete_pending",
                      JSON.stringify({ ref: "landing-cta", ts: Date.now() }),
                    );
                  } catch {
                    // localStorage unavailable (private mode etc.) — the
                    // direct AccountPage authed-effect still catches the
                    // already-signed-in case via the ?ref= query.
                  }
                }}
              >
                compete
              </a>
            </span>
          }
        >
          <CompactMarketsGrid />
        </Panel>
      </main>

      {/* FOOTER STATUS ────────────────────────────────────────── */}
      <footer className="flex items-center gap-3 px-2 py-1 border-t border-[var(--color-border)] ck-mono ck-dim">
        <span>
          <span className="ck-pos">chainlink</span> +{" "}
          <span className="ck-pos">pyth</span>
        </span>
        <span className="ck-dim">·</span>
        <span>base</span>
        <span className="ck-dim">·</span>
        <a href="#/spec" className="ck-mono ck-dim hover:ck-pos no-underline">
          spec
        </a>
        <span className="ck-dim">·</span>
        <a
          href="https://github.com/Timidan/synth-x"
          target="_blank"
          rel="noreferrer"
          className="ck-mono ck-dim hover:ck-pos no-underline"
        >
          github
        </a>
      </footer>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | string;
  tone?: "pos" | "neg" | "dim" | "default";
}) {
  const toneClass =
    tone === "pos" ? "ck-pos" : tone === "neg" ? "ck-neg" : tone === "dim" ? "ck-dim" : "ck-pos";
  return (
    <div className="px-2 py-1.5 border-r border-[var(--color-border)] flex flex-col gap-0.5">
      <span className="ck-label">{label}</span>
      <span className={"ck-mono " + toneClass} style={{ fontSize: 14, fontWeight: 700 }}>
        {value}
      </span>
    </div>
  );
}
