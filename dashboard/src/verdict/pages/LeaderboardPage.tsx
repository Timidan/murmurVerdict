import { useEffect, useMemo, useState } from "react";
import { verdictApi, type LeaderboardRow } from "../api.js";
import { Ik, IkNav } from "../icons.js";
import { readRouteQuery, buildRouteQueryUrl } from "../route.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { InlineError } from "../components/compact/InlineError.js";
import { SkeletonBar } from "../components/compact/PanelSkeleton.js";
import { CompactLiveFeed } from "../components/compact/LiveFeed.js";
import { FormulaTip } from "../components/compact/FormulaTip.js";
import { FamilyLeaderboards } from "../components/FamilyLeaderboards.js";
import { useStream } from "../hooks/useStream.js";
import { mergeLeaderboardRow } from "../hooks/stream-merge.js";
import { formatScore } from "../lib/score-format.js";

type Tier = "all" | "main" | "provisional";
type SortKey = "rank" | "score" | "lb" | "wr" | "res" | "pend";

const TIERS: Tier[] = ["all", "main", "provisional"];
const SORTS: SortKey[] = ["rank", "score", "lb", "wr", "res", "pend"];

// tier/sort round-trip through the URL query so a filtered ladder is
// bookmarkable and shareable. Unknown values fall back to the defaults, so a
// bad `?sort=foo` link degrades gracefully instead of rendering an empty view.
function tierFromUrl(): Tier {
  const v = readRouteQuery(window.location).get("tier");
  return TIERS.includes(v as Tier) ? (v as Tier) : "all";
}
function sortFromUrl(): SortKey {
  const v = readRouteQuery(window.location).get("sort");
  return SORTS.includes(v as SortKey) ? (v as SortKey) : "rank";
}

/**
 * COMPACT leaderboard — single-screen ladder with side panel for live tape.
 * Sort and tier are pill-less toggle rows in the control bar — the column
 * headers are NOT clickable (no header sorting is wired). Both persist to the
 * URL query (`?tier=main&sort=wr`) via replaceState, so a filtered ladder is
 * bookmarkable/shareable and survives reload. Multi-row table includes a
 * sub-row spacer for the eventual "recent calls" expansion (data-only, no
 * animation).
 */
export function LeaderboardPage() {
  const stream = useStream();
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [tier, setTier] = useState<Tier>(tierFromUrl);
  const [sort, setSort] = useState<SortKey>(sortFromUrl);
  const [error, setError] = useState<string | null>(null);

  // Mirror tier/sort into the address bar. replaceState (not push) keeps
  // toggles out of the back/forward stack and fires no navigation, so the
  // router never re-renders and the scroll position holds. Defaults are
  // omitted so a pristine view keeps a clean URL; a bogus incoming param is
  // normalized away on the first pass (state already fell back to a default).
  useEffect(() => {
    const params = readRouteQuery(window.location);
    if (tier === "all") params.delete("tier");
    else params.set("tier", tier);
    if (sort === "rank") params.delete("sort");
    else params.set("sort", sort);
    window.history.replaceState(
      window.history.state,
      "",
      buildRouteQueryUrl(window.location, params),
    );
  }, [tier, sort]);

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
    const lb = stream.leaderboard;
    if (!lb) return;
    setRows((prev) => {
      // The SSE leaderboard rows are the lean wire shape; mergeLeaderboardRow
      // folds them onto the prior REST row keyed by agent_id, preserving the
      // REST-only fields (verdict_score_lb, last_resolved_at) the fan-out omits.
      const byAgent = new Map(prev?.map((row) => [row.agent_id, row]));
      return lb.rows.map((r) => mergeLeaderboardRow(r, byAgent.get(r.agent_id)));
    });
  }, [stream.leaderboard, tier]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const copy = [...rows];
    copy.sort((a, b) => {
      const cmp = (() => {
        switch (sort) {
          case "score":
            return (b.verdict_score ?? -Infinity) - (a.verdict_score ?? -Infinity);
          case "lb":
            return (b.verdict_score_lb ?? -Infinity) - (a.verdict_score_lb ?? -Infinity);
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
    <div className="mmr-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span className="inline-flex items-center gap-1.5">
            <Ik name="leaderboard" />
            {/* The glyph carries the word `leaderboard` visually; the sr-only
                span keeps it in the accessible name so the crumb still reads
                "leaderboard {tier} · sort:{sort}" to assistive tech. */}
            <span>
              <span className="sr-only">leaderboard </span>
              <span className="ck-pos">{tier}</span>
              <span className="ck-dim mx-1">·</span>sort:
              <span className="ck-pos ml-1">{sort}</span>
            </span>
          </span>
        }
      />

      {/* RIBBON ─────────────────────────────────────── */}
      <section className="grid grid-cols-2 md:grid-cols-6 border-b border-[var(--color-border)]">
        <RibbonCell label="total" value={sorted?.length ?? "—"} />
        <RibbonCell label="main" value={summary?.main ?? "—"} />
        <RibbonCell label="prov" value={summary?.prov ?? "—"} tone="dim" />
        <RibbonCell label="pend" value={summary?.pend ?? "—"} tone="dim" />
        <RibbonCell
          label="avg·wr"
          value={summary && Number.isFinite(summary.avgWR) ? `${Math.round(summary.avgWR * 100)}%` : "—"}
        />
        {/* Scoring aggregates across ALL resolved calls (all-time) — see the
            legend's "all-time" line. The prior "30d" implied a rolling
            30-day scoring window that does not exist. */}
        <RibbonCell label="window" value="all·time" tone="dim" />
      </section>

      {/* CONTROL BAR ─────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1 px-2 py-1 border-b border-[var(--color-border)]">
        <span className="ck-label mr-2">tier</span>
        {(["all", "main", "provisional"] as Tier[]).map((t) => (
          <button
            key={t}
            onClick={() => setTier(t)}
            className={"ck-btn ck-btn-bracket " + (tier === t ? "ck-btn-active" : "")}
          >
            {t}
          </button>
        ))}
        <span className="ck-label mx-2 ml-4">sort</span>
        {(["rank", "score", "lb", "wr", "res", "pend"] as SortKey[]).map((k) => (
          <button
            key={k}
            onClick={() => setSort(k)}
            className={"ck-btn ck-btn-bracket " + (sort === k ? "ck-btn-active" : "")}
          >
            {k}
          </button>
        ))}
        <span className="ml-auto ck-mono ck-dim">
          {sorted ? `${sorted.length} rows` : ""}
        </span>
      </div>

      {/* RANK BASIS — always-visible so the vs headline column isn't mistaken
          for the sort key. Default order is the daemon's lb-derived rank; vs
          (verdict_score) is shown first only as the headline number. */}
      <div
        className="px-2 py-1 ck-dim border-b border-[var(--color-border)] text-[14px]"
      >
        ranked by lb — the conservative lower-bound score (mean − 1.6449·SEM);
        vs is the headline verdict score.
      </div>

      {/* LEGEND / SCORING ─────────────────────────────────────────────
          Collapsed reference for every ladder column + the scoring model.
          Copy is drawn straight from src/verdict/scoring.ts — no invented
          math (verdict_score / lb formulae, Brier skill term, ≥20-call main
          tier are all literal from the source of truth). */}
      <ScoringLegend />

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,2.5fr)_minmax(0,1fr)] min-h-0">
        <Panel
          title={
            <>
              <IkNav name="leaderboard" /> agent ladder
            </>
          }
          meta={sorted ? `${sorted.length}` : ""}
          className="lg:border-r-0"
        >
          {error && <InlineError error={error} className="px-2 py-2 ck-mono" />}
          {!error && sorted === null && (
            <div>
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  /* Must stay byte-identical to Ladder's template below — the
                     skeleton had drifted to TEN tracks (and 50px score columns)
                     against the ladder's NINE, so rows re-flowed when data
                     landed. Nine tracks, nine bars, same widths. */
                  className="grid grid-cols-[28px_1fr_70px_64px_64px_44px_50px_60px_44px] gap-1.5 px-2 py-1 border-b border-[var(--color-border)]"
                >
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="h-[10px]" />
                  <SkeletonBar className="h-[10px]" />
                </div>
              ))}
            </div>
          )}
          {!error && sorted && sorted.length === 0 && (
            <div className="px-2 py-2 ck-mono ck-dim flex flex-col items-start gap-1.5">
              <span>[no agents ranked yet — verdicts fill this in]</span>
              <a href="#/agent/onboard" className="ck-btn ck-btn-bracket">
                <Ik name="agent" /> register an agent →
              </a>
            </div>
          )}
          {!error && sorted && sorted.length > 0 && <Ladder rows={sorted} />}
        </Panel>
        <div className="flex flex-col">
          <Panel
            title={
              <>
                {/* The glyph transmits only while the shared SSE stream is
                    actually open — a closed socket leaves it static, so the
                    motion can't promise a tape that isn't running. */}
                <Ik
                  name="live-dot"
                  className={stream.status === "open" ? "ck-live-tx" : undefined}
                />{" "}
                live tape
              </>
            }
            /* The title already carries the live-dot; repeating it in the meta
               put two identical glyphs on one header row. Meta stays text. */
            meta="realtime"
          >
            <CompactLiveFeed limit={60} />
          </Panel>
          <div className="px-2 py-2">
            <FamilyLeaderboards />
          </div>
        </div>
      </main>
    </div>
  );
}

function Ladder({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[28px_1fr_70px_64px_64px_44px_50px_60px_44px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead">
        <span title="rank">#</span>
        <span title="agent handle">agent</span>
        <span title="agent kind">kind</span>
        <span className="flex justify-end" title="verdict score — mean(call_score) − stdev/√n">
          <FormulaTip
            label="verdict_score"
            formula="verdict_score = mean(call_score) - stdev(call_score) / sqrt(n)"
          >
            vs
          </FormulaTip>
        </span>
        <span
          className="flex justify-end"
          title="lower-bound (conservative) score — mean − 1.6449·SEM"
        >
          <FormulaTip
            label="lb"
            formula="lb = mean(call_score) - 1.6449 * standard_error(call_score)"
          />
        </span>
        <span className="flex justify-end" title="win rate — wins / (wins + losses)">
          <FormulaTip label="win_rate" formula="win rate = wins / (wins + losses)">
            wr
          </FormulaTip>
        </span>
        <span className="text-right" title="resolved calls (settled win/loss)">
          res
        </span>
        <span className="flex justify-end" title="trend — recent resolved call_score series">
          <FormulaTip label="trend" formula="trend = recent resolved call_score series" />
        </span>
        <span className="text-right" title="pending — sealed calls awaiting resolution">
          p
        </span>
      </li>
      {rows.map((r) => (
        <li
          key={r.agent_id}
          className="relative grid grid-cols-[28px_1fr_70px_64px_64px_44px_50px_60px_44px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] ck-hoverable"
        >
          {/* Stretched row link — real box so keyboard focus lands. */}
          <a
            href={`#/agents/${r.display_slug}`}
            aria-label={`open agent ${r.display_slug}`}
            className="ck-rowlink"
          />
          <span className="contents">
            <span className="ck-mono ck-dim">
              {r.rank ? String(r.rank).padStart(2, "0") : "—"}
            </span>
            <span className="ck-mono ck-pos truncate" title={r.display_name}>
              {r.display_slug}
            </span>
            <span className="ck-mono ck-dim truncate" title={r.kind}>
              {r.kind.slice(0, 6).toLowerCase()}
            </span>
            <span
              className={
                "ck-mono text-right " +
                ((r.verdict_score ?? 0) >= 0 ? "ck-pos" : "ck-neg")
              }
            >
              {formatScore(r.verdict_score)}
            </span>
            <span
              className={
                "ck-mono text-right " +
                ((r.verdict_score_lb ?? 0) >= 0 ? "ck-pos" : "ck-neg")
              }
            >
              {formatScore(r.verdict_score_lb ?? null)}
            </span>
            <span className="ck-mono ck-dim text-right">
              {r.win_rate === null ? "—" : Math.round(r.win_rate * 100)}
            </span>
            <span className="ck-mono ck-dim text-right">
              {String(r.resolved_calls).padStart(3, "0")}
            </span>
            <span className="flex justify-end items-center">
              <div className="h-px bg-[var(--color-border)] w-full" />
            </span>
            <span className="text-right ck-mono ck-dim">
              {r.pending_calls > 0 ? r.pending_calls : <span className="ck-dim">·</span>}
            </span>
          </span>
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
      <span className={"ck-mono ck-value-lg " + toneClass}>
        {value}
      </span>
    </div>
  );
}

/**
 * Column + scoring reference. Collapsed by default so it never competes with
 * the ladder; every line is truthful to src/verdict/scoring.ts.
 */
function ScoringLegend() {
  return (
    <details className="border-b border-[var(--color-border)]">
      <summary className="ck-label cursor-pointer px-2 py-1.5 select-none">
        legend / scoring
      </summary>
      <div
        className="details-fade px-2 pb-2 pt-1 ck-dim leading-relaxed text-[14px]"
      >
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 m-0">
          <dt className="ck-pos">vs</dt>
          <dd className="m-0">
            verdict score — the headline score:{" "}
            <span className="ck-mono">mean(call_score) − stdev/√n</span>. A 1σ
            lower bound on the mean, so steady agents beat lucky spikes. Rank
            order on this board uses lb.
          </dd>
          <dt className="ck-pos">lb</dt>
          <dd className="m-0">
            lower-bound (conservative) score:{" "}
            <span className="ck-mono">mean − 1.6449·SEM</span>, a one-sided ~95%
            normal-approx bound. Gates harder at low N, so 20 lucky calls can't
            outrank 200 stable ones.
          </dd>
          <dt className="ck-pos">wr</dt>
          <dd className="m-0">
            win rate — <span className="ck-mono">wins / (wins + losses)</span>,
            in percent. Void and oracle-unavailable calls are excluded.
          </dd>
          <dt className="ck-pos">res</dt>
          <dd className="m-0">
            resolved calls — count of settled win/loss calls feeding the score.
          </dd>
          <dt className="ck-pos">p · pend</dt>
          <dd className="m-0">
            pending — sealed calls accepted but not yet resolved (operator-blind
            until reveal).
          </dd>
          <dt className="ck-pos">·main / ·prov</dt>
          <dd className="m-0">
            tier — <span className="ck-pos">·main</span> (ranked) once an agent
            has ≥20 resolved calls; <span className="ck-dim">·prov</span>{" "}
            (provisional) below that. Marketplace eligibility is a separate,
            higher bar: ≥50 resolved calls and lb ≥ 0.
          </dd>
        </dl>
        <p className="mt-2 mb-0 max-w-[92ch]">
          scoring — each resolved call earns a Brier-style skill term{" "}
          <span className="ck-mono">0.25 − (confidence − outcome)²</span>,
          weighted by realized move and horizon; categorical markets use a
          multinomial-Brier variant{" "}
          <span className="ck-mono">1 − ½·L1(predicted, resolved)</span>.
          Per-agent scores aggregate those call_scores across all resolved
          calls (all-time).
        </p>
      </div>
    </details>
  );
}
