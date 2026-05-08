import { useEffect, useMemo, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { CompactSparkline } from "../components/compact/Sparkline.js";
import { CompactLiveFeed } from "../components/compact/LiveFeed.js";
import { useStream } from "../hooks/useStream.js";

type Tier = "all" | "main" | "provisional";
type SortKey = "rank" | "score" | "wr" | "res" | "pend";

/**
 * COMPACT leaderboard — single-screen ladder with side panel for live tape.
 * Click headers to sort; tier filter is a row of pill-less ALL CAPS toggles.
 * Multi-row table includes a sub-row spacer for the eventual "recent calls"
 * expansion (data-only, no animation).
 */
export function LeaderboardPageCompact() {
  const stream = useStream();
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [tier, setTier] = useState<Tier>("all");
  const [sort, setSort] = useState<SortKey>("rank");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    verdictApi
      .leaderboard({ tier: tier === "all" ? undefined : tier, limit: 200 })
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

  // Fold SSE deltas in for the "all" tier (mirrors default page).
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

  const sorted = useMemo(() => {
    if (!rows) return null;
    const copy = [...rows];
    copy.sort((a, b) => {
      const cmp = (() => {
        switch (sort) {
          case "score":
            return (b.verdict_score ?? -Infinity) - (a.verdict_score ?? -Infinity);
          case "wr":
            return (b.win_rate ?? -Infinity) - (a.win_rate ?? -Infinity);
          case "res":
            return b.resolved_calls - a.resolved_calls;
          case "pend":
            return b.pending_calls - a.pending_calls;
          case "rank":
          default:
            return (a.rank ?? 9999) - (b.rank ?? 9999);
        }
      })();
      return cmp;
    });
    return copy;
  }, [rows, sort]);

  const summary = useMemo(() => {
    if (!sorted) return null;
    const main = sorted.filter((r) => r.tier === "main").length;
    const prov = sorted.filter((r) => r.tier === "provisional").length;
    const pend = sorted.reduce((acc, r) => acc + r.pending_calls, 0);
    const avgWR =
      sorted.filter((r) => r.win_rate !== null).reduce((a, r) => a + (r.win_rate ?? 0), 0) /
      Math.max(1, sorted.filter((r) => r.win_rate !== null).length);
    return { main, prov, pend, avgWR };
  }, [sorted]);

  return (
    <div className="compact-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span>
            LEADERBOARD <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{tier.toUpperCase()}</span>
            <span className="ck-dim mx-1">·</span>SORT:
            <span className="ck-pos ml-1">{sort.toUpperCase()}</span>
          </span>
        }
      />

      {/* RIBBON ─────────────────────────────────────── */}
      <section className="grid grid-cols-2 md:grid-cols-6 border-b border-[var(--color-border)]">
        <RibbonCell label="TOTAL" value={sorted?.length ?? "—"} />
        <RibbonCell label="MAIN" value={summary?.main ?? "—"} />
        <RibbonCell label="PROV" value={summary?.prov ?? "—"} tone="dim" />
        <RibbonCell label="PEND" value={summary?.pend ?? "—"} tone="neg" />
        <RibbonCell
          label="AVG·WR"
          value={summary && Number.isFinite(summary.avgWR) ? `${Math.round(summary.avgWR * 100)}%` : "—"}
        />
        <RibbonCell label="WINDOW" value="30D" tone="dim" />
      </section>

      {/* CONTROL BAR ─────────────────────────────────── */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--color-border)]">
        <span className="ck-label mr-2">TIER</span>
        {(["all", "main", "provisional"] as Tier[]).map((t) => (
          <button
            key={t}
            onClick={() => setTier(t)}
            className={"ck-btn " + (tier === t ? "ck-btn-active" : "")}
          >
            {t}
          </button>
        ))}
        <span className="ck-label mx-2 ml-4">SORT</span>
        {(["rank", "score", "wr", "res", "pend"] as SortKey[]).map((k) => (
          <button
            key={k}
            onClick={() => setSort(k)}
            className={"ck-btn " + (sort === k ? "ck-btn-active" : "")}
          >
            {k}
          </button>
        ))}
        <span className="ml-auto ck-mono ck-dim">
          {sorted ? `${sorted.length} ROWS` : ""}
        </span>
      </div>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,2.5fr)_minmax(0,1fr)] min-h-0">
        <Panel
          title="AGENT LADDER"
          meta={sorted ? `${sorted.length}` : ""}
          className="lg:border-r-0"
        >
          {error && <div className="px-2 py-2 ck-mono ck-neg">[ERR] {error}</div>}
          {!error && sorted === null && (
            <div className="px-2 py-2 ck-mono ck-dim">[loading...]</div>
          )}
          {!error && sorted && sorted.length === 0 && (
            <div className="px-2 py-2 ck-mono ck-dim">[no rows]</div>
          )}
          {!error && sorted && sorted.length > 0 && <Ladder rows={sorted} />}
        </Panel>
        <Panel title="LIVE TAPE" meta="REALTIME">
          <CompactLiveFeed limit={60} />
        </Panel>
      </main>
    </div>
  );
}

function Ladder({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[28px_1fr_70px_50px_44px_50px_60px_24px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-label">
        <span>#</span>
        <span>AGENT</span>
        <span>KIND</span>
        <span className="text-right">VS</span>
        <span className="text-right">WR</span>
        <span className="text-right">RES</span>
        <span className="text-right">TREND</span>
        <span className="text-right">P</span>
      </li>
      {rows.map((r) => (
        <li
          key={r.agent_id}
          className="grid grid-cols-[28px_1fr_70px_50px_44px_50px_60px_24px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] hover:bg-[white]/[0.03]"
        >
          <a href={`#/agents/${r.display_slug}`} className="contents no-underline">
            <span className="ck-mono ck-dim">
              {r.rank ? String(r.rank).padStart(2, "0") : "—"}
            </span>
            <span className="ck-mono ck-pos truncate" title={r.display_name}>
              {r.display_slug}
            </span>
            <span className="ck-mono ck-dim truncate" title={r.kind}>
              {r.kind.slice(0, 6).toUpperCase()}
            </span>
            <span
              className={
                "ck-mono text-right " +
                ((r.verdict_score ?? 0) >= 0 ? "ck-pos" : "ck-neg")
              }
            >
              {formatScore(r.verdict_score)}
            </span>
            <span className="ck-mono ck-dim text-right">
              {r.win_rate === null ? "—" : Math.round(r.win_rate * 100)}
            </span>
            <span className="ck-mono ck-dim text-right">
              {String(r.resolved_calls).padStart(3, "0")}
            </span>
            <span className="flex justify-end items-center">
              <CompactSparkline values={synth(r.verdict_score ?? 0)} width={56} height={12} />
            </span>
            <span className="text-right ck-mono ck-neg">
              {r.pending_calls > 0 ? r.pending_calls : <span className="ck-dim">·</span>}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function RibbonCell({
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

function formatScore(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}`;
}

function synth(seed: number): number[] {
  const out: number[] = [];
  let v = seed * 1000;
  for (let i = 0; i < 12; i++) {
    v += Math.sin((seed + i) * 1.7) * 5;
    out.push(v);
  }
  return out;
}
