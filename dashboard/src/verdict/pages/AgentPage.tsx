import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  verdictApi,
  fetchAgentGrid,
  ApiError,
  type AgentCallRow,
  type AgentMarketRow,
  type AgentProfile,
} from "../api.js";
import { Ik, IkNav, IkHero, type HeroIconName } from "../icons.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { CompactSparkline } from "../components/compact/Sparkline.js";
import { FormulaTip } from "../components/compact/FormulaTip.js";
import { ErrorState } from "../components/compact/ErrorState.js";
import { PanelSkeleton } from "../components/compact/PanelSkeleton.js";
import { useDetailDrawer, isPlainLeftClick } from "../components/compact/DetailDrawer.js";
import { KindGlyph } from "../components/compact/glyphs.js";
import { CallHistory } from "../components/compact/CallHistory.js";
import { formatScore } from "../lib/score-format.js";
import { shortId } from "../lib/display-format.js";
import {
  classifyCallOutcome,
  isPendingCallStatus,
  isTerminalFailureStatus,
} from "@shared/wire-call-status";

/**
 * COMPACT per-agent dashboard. Single screen splits:
 *   ribbon → identity / score / kind / wallet / actions
 *   3-col main → call log · market heat · sticky sidecar (stats + actions)
 * No hero number, no oversized Doto. The large readout is mono.
 */
export function AgentPage({ slug }: { slug: string }) {
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [calls, setCalls] = useState<AgentCallRow[] | null>(null);
  const [grid, setGrid] = useState<AgentMarketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  useEffect(() => {
    let cancel = false;
    setAgent(null);
    setCalls(null);
    setGrid(null);
    setError(null);
    setNotFound(false);
    // The primary agent fetch GATES the dependents. Previously agent + calls
    // + grid fanned out in parallel, so an unknown slug fired three requests
    // and painted three 404s. Now the calls/grid reads fire only after the
    // agent resolves — an unknown agent costs a single request and lands on
    // the shared not-found state. Each dependent also degrades to an empty
    // panel on its own failure rather than collapsing the whole page.
    verdictApi
      .agent(slug)
      .then((a) => {
        if (cancel) return;
        setAgent(a);
        verdictApi
          .agentCalls(slug, 100)
          .then((c) => {
            if (!cancel) setCalls(c.calls);
          })
          .catch(() => {
            if (!cancel) setCalls([]);
          });
        fetchAgentGrid(slug)
          .then((g) => {
            if (!cancel) setGrid(g?.grid ?? []);
          })
          .catch(() => {
            if (!cancel) setGrid([]);
          });
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setError(e instanceof Error ? e.message : String(e));
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  const stats = useMemo(() => {
    if (!calls) return null;
    // Classify by lifecycle/scoring state, mirroring
    // src/verdict/leaderboard-call-summary.ts. win/loss are the only scored
    // outcomes; void / oracle_unavailable are EXCLUDED from win-rate and the
    // average (their null scores are never zeroed into it); pending counts
    // EXACTLY the canonical accepted/pending_t0/pending_t1 set from
    // isPendingLeaderboardStatus, so this page's pend can never disagree
    // with the leaderboard's pending_calls; terminal reveal/rejection
    // failures (rejected, invalid_reveal, missed_reveal) are neither pending
    // nor scored; any other non-outcome row (submitted, preflighted,
    // unresolved disputed, defensive unknowns) lands in a dim `other` tally.
    let wins = 0;
    let losses = 0;
    let voids = 0;
    let pending = 0;
    let failed = 0;
    let other = 0;
    const scores: number[] = [];
    for (const c of calls) {
      // Classification vocabulary is shared with the daemon
      // (@shared/wire-call-status): win/loss are the only scored outcomes;
      // void folds void + oracle_unavailable; pending / terminal-failure are
      // status-derived; everything else lands in `other`.
      const outcomeClass = classifyCallOutcome(c.outcome);
      if (outcomeClass === "win") {
        wins++;
        if (c.call_score !== null && c.call_score !== undefined) scores.push(c.call_score);
      } else if (outcomeClass === "loss") {
        losses++;
        if (c.call_score !== null && c.call_score !== undefined) scores.push(c.call_score);
      } else if (outcomeClass === "void") {
        voids++;
      } else if (isPendingCallStatus(c.status)) {
        pending++;
      } else if (isTerminalFailureStatus(c.status)) {
        failed++;
      } else {
        other++;
      }
    }
    const winRate = wins + losses === 0 ? null : wins / (wins + losses);
    const avgScore =
      scores.length === 0
        ? null
        : scores.reduce((acc, s) => acc + s, 0) / scores.length;
    let streak = 0;
    for (const c of calls) {
      const outcomeClass = classifyCallOutcome(c.outcome);
      if (outcomeClass === "win") streak++;
      else if (outcomeClass === "loss") break;
    }
    return {
      total: calls.length,
      // "resolved" = scored resolved calls (win/loss with a real score);
      // voids are settled but unscored, so they sit in their own bucket.
      resolved: scores.length,
      wins,
      losses,
      voids,
      pending,
      failed,
      other,
      winRate,
      avgScore,
      streak,
    };
  }, [calls]);

  const ownerExplorerUrl =
    agent?.wallet_address && agent.chain_id
      ? blockExplorerAddressUrl(agent.wallet_address, agent.chain_id)
      : null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span>
            agents <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">{agent?.display_slug ?? slug}</span>
          </span></TopbarCrumb>

      <h1 className="sr-only">agent {agent?.display_name ?? `@${slug}`}</h1>

      {notFound && (
        <ErrorState kind="not_found" what="agent" id={slug} detail={error ?? undefined} />
      )}
      {!notFound && error && (
        <ErrorState kind="error" what="agent" id={slug} detail={error} />
      )}

      {agent && (
        <>
          {/* IDENTITY RIBBON ─────────────────────────────────── */}
          <section className="grid grid-cols-2 md:grid-cols-8 border-b border-[var(--color-border)]">
            <RCell label="handle" value={`@${agent.display_slug}`} />
            <RCell label="name" value={agent.display_name} />
            <RCell label="kind" value={<KindGlyph kind={agent.kind} />} tone={kindTone(agent.kind)} />
            <RCell
              label={
                /* Not a 30-day window: the fetch batch is the newest ≤100
                   CALLS and the value averages the scored rows within it. The
                   plain line states that actual window, no date predicate. */
                <FormulaTip
                  label="recent score"
                  plain="the average score across this agent's scored calls, within its latest 100 calls."
                  formula="recent score = sum(call score) / scored calls"
                />
              }
              value={stats ? formatScore(stats.avgScore) : "—"}
              tone={(stats?.avgScore ?? 0) >= 0 ? "pos" : "neg"}
            />
            <RCell
              label={
                <FormulaTip
                  label="win%"
                  plain="wins as a share of wins plus losses. Void calls are left out."
                  formula="win % = wins / (wins + losses)"
                />
              }
              value={stats ? formatWR(stats.winRate) : "—"}
            />
            <RCell
              label="scored"
              value={stats ? String(stats.resolved) : "—"}
              title="calls that finished and earned a score"
            />
            <RCell
              label="open"
              value={stats ? String(stats.pending) : "—"}
              tone="dim"
              title="calls that are sealed and have not resolved yet"
            />
            <RCell
              label={
                <FormulaTip
                  label="win streak"
                  plain="wins in a row, counting back from the newest call."
                  formula="win streak = wins from the newest call until the first loss"
                />
              }
              value={stats ? String(stats.streak) : "—"}
            />
          </section>

          {/* IDENTITY META + ACTIONS ─────────────────────────── */}
          <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--color-border)] flex-wrap">
            {agent.wallet_address && (
              <OwnerAuthorizedPill explorerUrl={ownerExplorerUrl} />
            )}
            {agent.wallet_address && (
              <a
                href={`https://basescan.org/address/${agent.wallet_address}`}
                target="_blank"
                rel="noreferrer"
                className="ck-mono ck-pos no-underline"
                title={`${agent.wallet_address} on ${humanChain(agent.chain_id)}`}
              >
                {shortId(agent.wallet_address, 8, 6)}
              </a>
            )}
            <span className="ck-label ck-dim">
              since {agent.created_at.slice(0, 10)}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <a href={`#/share/${agent.display_slug}`} className="ck-btn ck-btn-bracket">
                share
              </a>
              {/* Wave 1 — shadow CLAIM CTA removed alongside the
                  deleted /agents/:slug/claim route. Shadow agents are
                  no longer self-claimable; contact an operator (admin
                  claim CLI lands in Wave 5). */}
            </span>
          </div>

          {agent.bio && (
            <div className="px-2 py-1 border-b border-[var(--color-border)] ck-mono ck-dim leading-tight">
              {agent.bio}
            </div>
          )}

          {/* MAIN GRID ───────────────────────────────────────── */}
          <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)] min-h-0">
            <Panel
              title={<><IkNav name="feed" /> call log</>}
              meta={calls ? `${calls.length}` : ""}
              className="lg:border-r-0"
            >
              {calls === null && <PanelSkeleton rows={6} />}
              {calls !== null && calls.length === 0 && (
                <div className="px-2 py-2 ck-mono ck-dim">[no calls yet]</div>
              )}
              {calls !== null && calls.length > 0 && <CallHistory calls={calls} />}
            </Panel>

            <Panel
              title={<><IkNav name="market" /> markets</>}
              meta={grid ? `${grid.length}` : ""}
              className="lg:border-r-0"
            >
              {grid === null && <PanelSkeleton rows={5} />}
              {grid !== null && grid.length === 0 && (
                <div className="px-2 py-2 ck-mono ck-dim">[no market results yet]</div>
              )}
              {grid !== null && grid.length > 0 && <GridTable rows={grid} />}
            </Panel>

            <Panel title={<><Ik name="verdict" /> summary</>}>
              <SidebarStats stats={stats} agent={agent} />
            </Panel>
          </main>
        </>
      )}
    </div>
  );
}

/* The call log lives in components/compact/CallHistory.tsx — the flat 100-row
   list it replaced said the same thing a hundred times over. */

function GridTable({ rows }: { rows: AgentMarketRow[] }) {
  const { open } = useDetailDrawer();
  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[1fr_64px_44px_56px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead">
        <span>market</span>
        <span className="text-right" title="the agent's score on this market">score</span>
        <span className="text-right" title="wins as a share of wins plus losses">win %</span>
        <span className="text-right" title="the last few call scores, oldest first">trend</span>
      </li>
      {rows.map((r) => (
        <li
          key={r.market_id}
          className="relative grid grid-cols-[1fr_64px_44px_56px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] ck-hoverable"
        >
          <a
            href={`#/markets/${encodeURIComponent(r.market_id)}`}
            aria-label={`open market ${r.market_id}`}
            onClick={(e) => {
              if (isPlainLeftClick(e)) {
                e.preventDefault();
                open("market", r.market_id);
              }
            }}
            className="ck-rowlink"
          />
          <span className="ck-mono ck-pos truncate" title={r.market_id}>
            {shortId(r.market_id, 9, 5)}
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
          <span className="flex justify-end">
            <CompactSparkline
              values={
                r.call_scores?.filter((s): s is number => s !== null) ?? []
              }
              width={56}
              height={12}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

interface AgentStats {
  total: number;
  resolved: number;
  wins: number;
  losses: number;
  voids: number;
  pending: number;
  failed: number;
  other: number;
  winRate: number | null;
  avgScore: number | null;
  streak: number;
}

function OwnerAuthorizedPill({ explorerUrl }: { explorerUrl: string | null }) {
  const className =
    "inline-flex items-center gap-1 border border-[var(--color-border-vis)] " +
    "px-1.5 py-[1px] text-[12px] leading-tight lowercase text-[var(--color-secondary)] " +
    "no-underline hover:bg-[var(--color-display)] hover:text-[var(--color-bg)] " +
    "hover:border-[var(--color-display)]";

  const content = <span>owner verified</span>;
  const explain =
    "a controller wallet signed for this profile, so a real owner stands behind it";

  if (!explorerUrl) {
    return (
      <span className={className} title={explain}>
        {content}
      </span>
    );
  }

  return (
    <a
      href={explorerUrl}
      target="_blank"
      rel="noreferrer"
      className={className}
      title={explain}
    >
      {content}
    </a>
  );
}

/**
 * Tile ink. Wins take the palette's one green; losses the accent the cockpit
 * already reads as "against you". Everything else stays on the monochrome
 * ladder — colour is still an event, and the word in the tooltip is what
 * actually carries the meaning. The tone rides the tile, so glyph and value
 * are always the same colour.
 */
const TILE_TONE = {
  win: "text-[var(--color-success)]",
  neg: "ck-neg",
  ink: "ck-pos",
  dim: "ck-dim",
} as const;

type TileTone = keyof typeof TILE_TONE;

/**
 * The summary panel — a 3-column grid of icon tiles (owner-approved
 * 2026-08-10), not the 11-row key/value stack it replaced. Each of those rows
 * spent a 92px track on a word the tile's own glyph can say, and eleven small
 * facts ran ~300px tall — taller than the sidecar, so the last of them sat
 * below the fold. The same eleven facts now fit in ~190px.
 *
 * The label left the SCREEN, not the accessible tree. Every tile carries the
 * stat name twice over: an sr-only span ahead of its value, so a screen reader
 * still hears "wins 26", and a native `title` with the plain-language
 * definition for a hovering mouse. `win %` and `avg score` keep the FormulaTip
 * they have always had, its trigger now the tile's glyph — the definition
 * still opens on hover AND on keyboard focus.
 */
function SidebarStats({
  stats,
  agent,
}: {
  stats: AgentStats | null;
  agent: AgentProfile;
}) {
  /** A tally, or an em-dash while the call log is still loading. */
  const n = (v: number | undefined) => (v === undefined ? "—" : String(v));
  /** A zero rests at dim — a green 0 or a red 0 shouts about nothing. */
  const countTone = (v: number | undefined, on: TileTone): TileTone => (v ? on : "dim");

  return (
    <div className="flex flex-col @container">
      {/* gap-px over a border-coloured backdrop draws every interior hairline
          in one declaration — the house grid idiom (AdminOverviewPage).
          Container-queried columns, because the panel's own width is what
          matters: the lg sidecar is 256px while the same panel spans the page
          on mobile. Two columns until the PANEL clears 300px, three after —
          a glyph-beside-value row needs ~110px per tile. */}
      <div className="grid grid-cols-2 @[560px]:grid-cols-3 gap-px bg-[var(--color-border)]">
        <StatTile
          icon="outcome-win"
          label="wins"
          value={n(stats?.wins)}
          tone={countTone(stats?.wins, "win")}
          title="calls that resolved as a win"
        />
        <StatTile
          icon="outcome-loss"
          label="losses"
          value={n(stats?.losses)}
          tone={countTone(stats?.losses, "neg")}
          title="calls that resolved as a loss"
        />
        <StatTile
          icon="win-rate"
          label="win %"
          value={stats ? formatWR(stats.winRate) : "—"}
          tip={{
            // Word for word the ribbon's win% tip: one definition, stated
            // identically everywhere the number appears.
            plain: "wins as a share of wins plus losses. Void calls are left out.",
            formula: "win % = wins / (wins + losses)",
          }}
        />

        <StatTile
          icon="avg-score"
          label="avg score"
          value={stats ? formatScore(stats.avgScore) : "—"}
          tone={(stats?.avgScore ?? 0) >= 0 ? "ink" : "neg"}
          tip={{
            plain: "the average score across this agent's scored calls.",
            formula: "avg score = sum(call score) / scored calls",
          }}
          /* Column 1 — the tip box has to hang from the left edge or it walks
             straight off the side of a ~105px tile. */
          tipAlign="start"
        />
        <StatTile
          icon="win-streak"
          label="win streak"
          value={n(stats?.streak)}
          tone={countTone(stats?.streak, "ink")}
          title="wins in a row, counting back from the newest call"
        />
        <StatTile
          icon="all-calls"
          label="all calls"
          value={n(stats?.total)}
          tone="dim"
          title="every call this agent has made"
        />

        {/* void = settled-but-unscored (void / oracle_unavailable); failed =
            terminal reveal/rejection failures; other = non-outcome rows outside
            the canonical pending set (submitted, preflighted, unresolved
            disputed). All three are excluded from the average score, win rate
            AND the open count, so each keeps its own dim tally. */}
        <StatTile
          icon="outcome-void"
          label="void"
          value={n(stats?.voids)}
          tone="dim"
          title="calls that settled with no winner, so they earn no score"
        />
        <StatTile
          icon="outcome-failed"
          label="failed"
          value={n(stats?.failed)}
          tone="dim"
          title="calls murmur rejected, or that missed their reveal"
        />
        <StatTile
          icon="outcome-other"
          label="other"
          value={n(stats?.other)}
          tone="dim"
          title="calls in any other state — sent, checked, or under dispute"
        />

        {/* The kind mark IS the datum, so it stands in for the stat glyph and
            brings its own accessible name (role="img" + aria-label "kind
            <kind>") — the one tile that needs no sr-only stand-in. `chain`
            then takes the row's spare cell rather than leaving it blank:
            BASE SEPOLIA is twelve characters and will not fit one track. */}
        <StatTile
          mark={(size) => <KindGlyph kind={agent.kind} size={size} />}
          label="kind"
          value={agent.kind.replace("_", " ")}
          tone="dim"
          title={KIND_EXPLAINER[agent.kind] ?? "what sort of agent this is"}
        />
        <StatTile
          icon="chain"
          label="chain"
          value={humanChain(agent.chain_id)}
          tone="dim"
          title="the chain this agent's calls settle on"
          span2
        />
      </div>
    </div>
  );
}

/** What each kind means — lives in the kind tile's tooltip, not a paragraph
 *  under the grid: the tile already names the kind, so a strip restating it
 *  in prose was the label creeping back in (owner flag, 2026-08-12). */
const KIND_EXPLAINER: Record<string, string> = {
  agent: "agent — a person owns it through their sign-in. It can hold a rank.",
  benchmark: "benchmark — murmur runs this one so you have something to compare against.",
  attested: "attested — an Olas bond backs this agent.",
  internal_test: "internal — a test agent. Operators only.",
};

/**
 * One summary tile: the stat's glyph beside its value, centered on one line.
 * The glyph IS the label, so the name has to arrive by other means — and it
 * does, twice: an sr-only span ahead of the value for assistive tech, `title`
 * for a hovering mouse. That pairing is the rule for any icon-only cell; a
 * tile that drops either one is unnamed, not minimal.
 *
 * Beside, not stacked: hero glyphs carry different internal masses (a gauge
 * sits high, an ellipsis is a 3px band), so a stacked value never lands the
 * same optical distance from its mark twice — the pair reads misaligned tile
 * to tile (owner flag, 2026-08-12). Centering both on one row pins them to a
 * shared axis. The width this needs comes from the grid, which drops to two
 * container-queried columns when the panel is narrow.
 */
function StatTile({
  icon,
  mark,
  label,
  value,
  tone = "ink",
  title,
  tip,
  tipAlign = "end",
  span2 = false,
}: {
  /** Hero-tier glyph naming the stat — the tile's subject. */
  icon?: HeroIconName;
  /** A glyph that IS the datum (the kind mark), drawn instead of `icon`.
   *  Size-aware for the same reason the icon renders twice below. */
  mark?: (size: 24 | 48) => ReactNode;
  label: string;
  value: ReactNode;
  tone?: TileTone;
  /** Plain-language definition, shown on hover. */
  title?: string;
  /** Hangs a FormulaTip off the glyph — plain sentence first, formula second. */
  tip?: { plain: string; formula: string };
  /** Which edge the tip box hangs from. `start` for tiles in column 1. */
  tipAlign?: "start" | "end";
  /** Takes two tracks — for a value no single track can hold. */
  span2?: boolean;
}) {
  const toneCls = TILE_TONE[tone];
  // `block` kills the inline SVG's baseline gap, so a tip tile and a plain one
  // come out the same height. The tone rides the glyph directly as well as the
  // tile: inside a FormulaTip the glyph sits in a `ck-label` span, which sets
  // its own colour and would otherwise repaint the mark secondary.
  //
  // TWO fixed-size renders, CSS-toggled by the PANEL's width — never one svg
  // scaled (the grey-soup rule). Wide panels get the 48 hero and a display-
  // size value so the tiles own their space; the narrow sidecar keeps the
  // compact 24 row.
  const at = (size: 24 | 48): ReactNode =>
    mark ? mark(size) : icon ? <IkHero name={icon} size={size} className={toneCls + " block"} /> : null;
  const glyph = (
    <>
      <span className="block @[340px]:hidden">{at(24)}</span>
      <span className="hidden @[340px]:block">{at(48)}</span>
    </>
  );
  return (
    <div
      className={
        "flex items-center gap-2 @[340px]:gap-3 min-w-0 px-2 py-2 @[340px]:py-3 @[560px]:px-4 @[560px]:py-5 bg-[var(--color-bg)] " +
        toneCls +
        (span2 ? " col-span-2" : "")
      }
      /* A tip tile takes no native title: the FormulaTip already answers the
         hover, and two tooltips over one glyph is one too many. */
      title={tip ? undefined : title}
    >
      {tip ? (
        <FormulaTip
          label={label}
          plain={tip.plain}
          formula={tip.formula}
          className={
            tipAlign === "start"
              ? "[&_.formula-tip]:right-auto [&_.formula-tip]:left-0"
              : ""
          }
        >
          {glyph}
        </FormulaTip>
      ) : (
        glyph
      )}
      {!mark && <span className="sr-only">{label} </span>}
      {/* ck-tile-value scales with the panel (container query in compact.css)
          and sits after .ck-mono in the cascade, which utilities cannot. */}
      <span className="ck-mono ck-tile-value leading-none truncate">{value}</span>
    </div>
  );
}

function RCell({
  label,
  value,
  tone = "default",
  title: titleOverride,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "pos" | "neg" | "dim" | "default";
  /** Plain-language definition for a bare label that has no FormulaTip. */
  title?: string;
}) {
  const toneClass =
    tone === "pos" ? "ck-pos" : tone === "neg" ? "ck-neg" : tone === "dim" ? "ck-dim" : "ck-pos";
  // Only string/number values get a native hover title — a glyph value carries
  // its own tooltip and would stringify to "[object Object]".
  const title =
    titleOverride ??
    (typeof value === "string" || typeof value === "number" ? String(value) : undefined);
  return (
    <div className="px-2 py-1.5 border-r border-[var(--color-border)] flex flex-col gap-0.5 min-w-0">
      <span className="ck-label">{label}</span>
      <span
        className={"ck-mono ck-value truncate " + toneClass}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

function kindTone(kind: AgentProfile["kind"]): "pos" | "neg" | "dim" | "default" {
  // `agent` is the canonical Privy-owned default and reads as
  // the positive tone; `attested` is the sentinel (red) tier; everything
  // else (benchmark, internal_test, stale legacy values) reads dim.
  if (kind === "agent") return "pos";
  if (kind === "attested") return "neg";
  return "dim";
}

function humanChain(chainId: string | null | undefined): string {
  // CAIP-2 → human label. Base is the canonical deploy target.
  const id = chainId ?? "eip155:8453";
  if (id === "eip155:8453") return "BASE";
  if (id === "eip155:84532") return "BASE SEPOLIA";
  return id.toUpperCase();
}

function blockExplorerAddressUrl(address: string, chainId: string): string | null {
  if (chainId === "eip155:8453") return `https://basescan.org/address/${address}`;
  if (chainId === "eip155:84532") return `https://sepolia.basescan.org/address/${address}`;
  return null;
}

function formatWR(wr: number | null): string {
  return wr === null ? "—" : `${Math.round(wr * 100)}%`;
}

/* The call log's own wording (outcome words, the score line) moved with it to
   components/compact/CallHistory.tsx. The row used to negate a losing call's
   score — on the venue scale a score runs 0…1, so "−0.30" named a number that
   cannot exist; the history prints what the daemon stored. */
