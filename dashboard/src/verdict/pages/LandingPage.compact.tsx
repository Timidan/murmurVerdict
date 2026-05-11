import { useEffect, useState } from "react";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { CompactMiniLB } from "../components/compact/MiniLB.js";
import { CompactLiveFeed } from "../components/compact/LiveFeed.js";
import { CompactMarketsGrid } from "../components/compact/MarketsGrid.js";
import { useStream } from "../hooks/useStream.js";
import { useFunnelEmit } from "../hooks/useFunnelEmit.js";
import { verdictApi } from "../api.js";

/**
 * COMPACT landing — cockpit mode. Three panels visible at once on desktop:
 *   ┌─ STATS RIBBON ────────────────────────────────────────────────┐
 *   │  ACC24  RES24  WINS  LOSS  VOID  AGENTS  SCHEMA  SCORING       │
 *   ├─ LEADERBOARD ──── LIVE FEED ──── MARKETS MATRIX ───────────────┤
 *   │  top-12 (mono)   recent N evts   per-(asset,hzn) ladder         │
 *   └────────────────────────────────────────────────────────────────┘
 * No hero, no marketing copy, no rounded corners.
 */
export function LandingPageCompact() {
  const { stats } = useStream();
  const emitFunnel = useFunnelEmit();
  const [meta, setMeta] = useState<{ schema: number; scoring: number; agents: number } | null>(
    null,
  );

  useEffect(() => {
    let cancel = false;
    Promise.all([verdictApi.meta(), verdictApi.leaderboard({ limit: 100 })])
      .then(([m, lb]) => {
        if (cancel) return;
        setMeta({
          schema: m.schema_version,
          scoring: m.scoring_version,
          agents: lb.rows.length,
        });
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, []);

  // Phase 7d — funnel pageview. Best-effort: only fires when Privy is
  // configured + the user has a session. Anonymous visitors are dropped
  // on the floor by useFunnelEmit until a future buffer-on-signin pass.
  useEffect(() => {
    void emitFunnel("landing.viewed");
  }, [emitFunnel]);

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar crumb="HOME / OVERVIEW" />

      {/* STATS RIBBON ─────────────────────────────────────────── */}
      <section className="grid grid-cols-4 md:grid-cols-8 border-b border-[var(--color-border)]">
        <Stat label="ACC·24H" value={stats?.accepted_24h ?? "—"} />
        <Stat label="RES·24H" value={stats?.resolved_24h ?? "—"} />
        <Stat label="WIN·24H" value={stats?.wins_24h ?? "—"} tone="pos" />
        <Stat label="LOSS·24H" value={stats?.losses_24h ?? "—"} tone="neg" />
        <Stat label="VOID·24H" value={stats?.void_24h ?? "—"} tone="dim" />
        <Stat label="AGENTS" value={meta?.agents ?? "—"} />
        <Stat label="SCHEMA" value={meta ? `v${meta.schema}` : "—"} tone="dim" />
        <Stat label="SCORING" value={meta ? `v${meta.scoring}` : "—"} tone="dim" />
      </section>

      {/* MAIN GRID ────────────────────────────────────────────── */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)] min-h-0">
        <Panel
          title="LEADERBOARD · 30D"
          meta="TOP 12"
          actions={
            <a href="#/leaderboard" className="ck-btn">
              FULL
            </a>
          }
          className="lg:border-r-0"
        >
          <CompactMiniLB limit={12} />
        </Panel>
        <Panel
          title="LIVE TAPE"
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
          title="MARKETS MATRIX"
          actions={
            <span className="flex items-center gap-1">
              <a href="#/launch" className="ck-btn">
                INSTL
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
                className="ck-btn ck-btn-accent"
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
                COMPETE
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
          ORACLE · <span className="ck-pos">CHAINLINK</span> +{" "}
          <span className="ck-pos">PYTH</span>
        </span>
        <span className="ck-dim">·</span>
        <span>NETWORK · BASE-MAINNET</span>
        <span className="ck-dim">·</span>
        <a href="#/spec" className="ck-mono ck-dim hover:ck-pos no-underline">
          SPEC
        </a>
        <span className="ck-dim">·</span>
        <a
          href="https://github.com/Timidan/synth-x"
          target="_blank"
          rel="noreferrer"
          className="ck-mono ck-dim hover:ck-pos no-underline"
        >
          GITHUB
        </a>
        <span className="ml-auto ck-mono ck-dim">v0.1 · COMPACT</span>
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
