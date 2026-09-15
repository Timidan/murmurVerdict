import { useEffect, useMemo, useRef, useState } from "react";
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
import { InlineError } from "../components/compact/InlineError.js";
import { useStream } from "../hooks/useStream.js";
import { formatScore } from "../lib/score-format.js";
import { shortId, splitMarketLabel } from "../lib/display-format.js";
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
/** How many of an agent's newest calls this page reads. Every statistic and
 *  every tab below is computed from that batch, so the number is quoted in the
 *  copy rather than left implied. */
const CALL_LIMIT = 100;

/** Said once, appended everywhere a statistic on this page is defined. */
const SCOPE_NOTE = `Counted from the agent's newest ${CALL_LIMIT} calls.`;

/** The win% definition, stated identically in the ribbon and in the summary. */
const WIN_RATE_PLAIN = `wins as a share of wins plus losses. Void calls are left out. ${SCOPE_NOTE}`;

export function AgentPage({ slug }: { slug: string }) {
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [calls, setCalls] = useState<AgentCallRow[] | null>(null);
  const [grid, setGrid] = useState<AgentMarketRow[] | null>(null);
  // Every market the agent ever called. The grid holds the top 100 of them.
  const [gridTotal, setGridTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  // A failed dependent read is NOT an empty one. Both used to land on `[]`, so
  // a call log that failed to load said "[no calls yet]" and a market grid that
  // failed said "[no market results yet]" — murmur reporting a fact it did not
  // have. Loading stays `null`, failure raises its own flag, and only a real
  // empty array is an empty state.
  const [callsFailed, setCallsFailed] = useState(false);
  const [gridFailed, setGridFailed] = useState(false);

  // The profile, its call log and its market grid are REST reads, and the
  // topbar says "live" — so a call by THIS agent on the shared stream re-reads
  // them. Streamed rows are the lean wire shape and carry none of the fields
  // below, so REST stays the source of truth. `live` is a dependency for the
  // same reason: an event that fires while the socket is down never arrives,
  // so a reconnect re-reads rather than trusting a snapshot with a hole in it.
  const { recentCalls, status } = useStream();
  const live = status === "open";
  const event = recentCalls.find((e) => e.agent_slug === slug);
  const streamKey = event ? `${event.type}:${event.call_id}` : null;
  const shown = useRef<string | null>(null);

  useEffect(() => {
    let cancel = false;
    // Only a NEW agent blanks the page; a live refresh repaints in place.
    if (shown.current !== slug) {
      shown.current = slug;
      setAgent(null);
      setCalls(null);
      setGrid(null);
      setError(null);
      setNotFound(false);
      setCallsFailed(false);
      setGridFailed(false);
    }
    // The primary agent fetch GATES the dependents. Previously agent + calls
    // + grid fanned out in parallel, so an unknown slug fired three requests
    // and painted three 404s. Now the calls/grid reads fire only after the
    // agent resolves — an unknown agent costs a single request and lands on
    // the shared not-found state. Each dependent also degrades to its own
    // failed panel rather than collapsing the whole page.
    verdictApi
      .agent(slug)
      .then((a) => {
        if (cancel) return;
        setAgent(a);
        setError(null);
        setNotFound(false);
        verdictApi
          .agentCalls(slug, CALL_LIMIT)
          .then((c) => {
            if (cancel) return;
            setCalls(c.calls);
            setCallsFailed(false);
          })
          .catch(() => {
            if (!cancel) setCallsFailed(true);
          });
        fetchAgentGrid(slug)
          .then((g) => {
            if (cancel) return;
            setGrid(g?.grid ?? []);
            setGridTotal(g?.total ?? 0);
            setGridFailed(false);
          })
          .catch(() => {
            if (!cancel) setGridFailed(true);
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
  }, [slug, streamKey, live]);

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
          {/* Identity first, stats after. Eight EQUAL columns gave `handle` 180px at
              1440 for a value that needs 218, so the agent's own name was the one
              thing on its profile that truncated. The two identity cells now take
              a wider share and the six numeric cells split the rest; each of those
              needs ~121px for its widest label ("recent score"). */}
          <section className="grid grid-cols-2 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_repeat(6,minmax(0,1fr))] border-b border-[var(--color-border)]">
            <RCell label="handle" value={`@${agent.display_slug}`} />
            <RCell label="name" value={agent.display_name} />
            <RCell label="kind" value={<KindGlyph kind={agent.kind} />} tone={kindTone(agent.kind)} />
            <RCell
              label={
                /* Not a 30-day window: the fetch batch is the newest CALL_LIMIT
                   CALLS and the value averages the scored rows within it. The
                   plain line states that actual window, no date predicate. */
                <FormulaTip
                  label="recent score"
                  plain={`the average score across this agent's scored calls. ${SCOPE_NOTE}`}
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
                  plain={WIN_RATE_PLAIN}
                  formula="win % = wins / (wins + losses)"
                />
              }
              value={stats ? formatWR(stats.winRate) : "—"}
            />
            <RCell
              label="scored"
              value={stats ? String(stats.resolved) : "—"}
              title={`calls that finished and earned a score. ${SCOPE_NOTE}`}
            />
            <RCell
              label="open"
              value={stats ? String(stats.pending) : "—"}
              tone="dim"
              title={`calls that are sealed and have not resolved yet. ${SCOPE_NOTE}`}
            />
            <RCell
              label={
                <FormulaTip
                  label="win streak"
                  plain={`wins in a row, counting back from the newest call. ${SCOPE_NOTE}`}
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
            {/* The explorer follows the agent's own chain. This link was pinned
                to mainnet Basescan under a tooltip that said Base Sepolia. */}
            {agent.wallet_address && ownerExplorerUrl && (
              <a
                href={ownerExplorerUrl}
                target="_blank"
                rel="noreferrer"
                className="ck-mono ck-pos no-underline"
                title={`${agent.wallet_address} on ${humanChain(agent.chain_id)}`}
              >
                {shortId(agent.wallet_address, 8, 6)}
              </a>
            )}
            {agent.wallet_address && !ownerExplorerUrl && (
              <span
                className="ck-mono ck-pos"
                title={`${agent.wallet_address} on ${humanChain(agent.chain_id)}`}
              >
                {shortId(agent.wallet_address, 8, 6)}
              </span>
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
              meta={
                calls ? (
                  <span title={`the agent's newest calls, ${CALL_LIMIT} at most`}>
                    {calls.length}
                  </span>
                ) : (
                  ""
                )
              }
              className="lg:border-r-0"
            >
              {calls === null && !callsFailed && <PanelSkeleton rows={6} />}
              {callsFailed && (
                <InlineError
                  error="the call log did not load. reload the page to try again."
                  className="px-2 py-2 ck-mono"
                />
              )}
              {calls !== null && calls.length === 0 && (
                <div className="px-2 py-2 ck-mono ck-dim">[no calls yet]</div>
              )}
              {calls !== null && calls.length > 0 && <CallHistory calls={calls} />}
            </Panel>

            <Panel
              title={<><IkNav name="market" /> markets</>}
              meta={grid ? (gridTotal > grid.length ? `${grid.length} of ${gridTotal}` : `${grid.length}`) : ""}
              className="lg:border-r-0"
            >
              {grid === null && !gridFailed && <PanelSkeleton rows={5} />}
              {gridFailed && (
                <InlineError
                  error="the market results did not load. reload the page to try again."
                  className="px-2 py-2 ck-mono"
                />
              )}
              {grid !== null && grid.length === 0 && (
                <div className="px-2 py-2 ck-mono ck-dim">[no market results yet]</div>
              )}
              {grid !== null && grid.length > 0 && <GridTable rows={grid} />}
              {/* The venue mints a market every window, so this list had no
                  bound anywhere. It ends where the cap does, and says so. */}
              {grid !== null && gridTotal > grid.length && (
                <p className="px-2 py-1.5 m-0 ck-mono ck-dim border-t border-[var(--color-border)]">
                  showing the top {grid.length} of {gridTotal} markets by floor
                </p>
              )}
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
            aria-label={`open market ${r.market_label ?? r.market_id}`}
            onClick={(e) => {
              if (isPlainLeftClick(e)) {
                e.preventDefault();
                open("market", r.market_id);
              }
            }}
            className="ck-rowlink"
          />
          {/* The market's own question, not its 66-character condition id.
              This column used to read `0x09bcdba…94513` forty-seven rows deep,
              which named nothing a reader could recognise or compare. The id
              is still here — as the row's tooltip, and in the link — for
              anyone who needs to match it against a receipt. Markets with no
              config_json (native price markets) still fall back to it.

              Split, because every row of a per-agent list is a five-minute
              window of the same handful of series: as one truncating string
              they all read "Ethereum Up or Do…", which is a different name for
              the same problem the hex id had. The series truncates; the window
              never does. */}
          <MarketCell label={r.market_label} marketId={r.market_id} />
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
 * ladder — colour is still an event, and the label beside it is what actually
 * carries the meaning. The tone rides the VALUE only: the mark stays dim at
 * every size, so the colour budget goes to the data.
 */
const TILE_TONE = {
  win: "text-[var(--color-success)]",
  neg: "ck-neg",
  ink: "ck-pos",
  dim: "ck-dim",
} as const;

type TileTone = keyof typeof TILE_TONE;

/**
 * The summary panel. Win rate leads at display size with the win/loss split
 * drawn beneath it, three supporting stats share one row, and the
 * housekeeping counts and identity recede into strips.
 *
 * This replaces an eleven-tile icon grid that failed twice over: nine of the
 * eleven marks could only be named by hovering them, and at 48px the mark ran
 * twice the height of the value it annotated (owner flag, 2026-08-27). Every
 * stat now carries a visible label. The `title` definitions and the two
 * FormulaTips stay exactly where they were.
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

  const wins = stats?.wins ?? 0;
  const losses = stats?.losses ?? 0;
  const scored = wins + losses;
  // void = settled-but-unscored; failed = terminal reveal/rejection failures;
  // other = non-outcome rows outside the canonical pending set. All three are
  // excluded from win rate, average score AND the open count.
  const unscored = (stats?.voids ?? 0) + (stats?.failed ?? 0) + (stats?.other ?? 0);

  return (
    <div className="flex flex-col @container">
      {/* HERO — the one display-tier number on the profile. */}
      <div className="px-2 py-3 @[340px]:px-4 @[340px]:py-5">
        <FormulaTip
          label="win rate"
          // Word for word the ribbon's win% tip: one definition, stated
          // identically everywhere the number appears.
          plain={WIN_RATE_PLAIN}
          formula="win % = wins / (wins + losses)"
          /* The tip box has to hang from the left edge or it walks off the
             side of a 256px sidecar. */
          className="[&_.formula-tip]:right-auto [&_.formula-tip]:left-0"
        />
        <span className="ck-stat-hero mt-1">{stats ? formatWR(stats.winRate) : "—"}</span>

        {/* The split says what the percentage is made of, so the formula is
            no longer the only way to read the number. */}
        <div
          className="ck-splitbar mt-3"
          role="img"
          aria-label={
            stats === null
              ? "the call log has not loaded"
              : scored
                ? `${wins} wins, ${losses} losses`
                : "no scored calls yet"
          }
        >
          {scored > 0 && (
            <>
              <i
                style={{
                  width: `${(wins / scored) * 100}%`,
                  background: "var(--color-success)",
                }}
              />
              <i
                style={{
                  width: `${(losses / scored) * 100}%`,
                  background: "var(--color-accent)",
                }}
              />
            </>
          )}
        </div>
        {scored > 0 ? (
          /* `wins` / `losses`, not `won` / `lost`: the call log below this
              panel says the same thing, and so does the ladder one click away
              (COPY.md rule 5 — one word, one meaning, everywhere). */
          <div className="mt-1.5 flex justify-between ck-colhead">
            <span className="text-[var(--color-success)]">
              {wins === 1 ? "1 win" : `${wins} wins`}
            </span>
            <span className="ck-neg">
              {losses === 1 ? "1 loss" : `${losses} losses`}
            </span>
          </div>
        ) : (
          /* `stats` is null while the call log is loading or after it failed —
             claiming "no scored calls yet" there states a fact murmur does not
             have. */
          <div className="mt-1.5 ck-colhead">
            {stats === null ? "[the call log has not loaded]" : "[no scored calls yet]"}
          </div>
        )}
      </div>

      {/* SUPPORTING — three tiles, one row, on the house gap-px hairline grid.
          Labels are short because a 256px panel gives each cell ~85px; the
          full wording lives in the tip and the title. */}
      <div className="grid grid-cols-3 gap-px bg-[var(--color-border)] border-t border-[var(--color-border)]">
        <StatTile
          icon="avg-score"
          label="avg"
          value={stats ? formatScore(stats.avgScore) : "—"}
          tone={(stats?.avgScore ?? 0) >= 0 ? "ink" : "neg"}
          tip={{
            plain: `the average score across this agent's scored calls. ${SCOPE_NOTE}`,
            formula: "avg score = sum(call score) / scored calls",
          }}
          tipAlign="start"
        />
        <StatTile
          icon="win-streak"
          label="streak"
          value={n(stats?.streak)}
          tone={countTone(stats?.streak, "ink")}
          title={`wins in a row, counting back from the newest call. ${SCOPE_NOTE}`}
        />
        <StatTile
          icon="all-calls"
          label="calls"
          value={n(stats?.total)}
          tone="ink"
          title={`the agent's newest calls, ${CALL_LIMIT} at most. Older calls are not read here.`}
        />
      </div>

      {/* UNSCORED — one strip while all three are zero, three tiles the moment
          any of them isn't. Absence of a problem is one fact, not three. */}
      {unscored === 0 ? (
        <div
          className="flex justify-between gap-2 px-2 py-1.5 @[340px]:px-4 border-t border-[var(--color-border)] ck-colhead"
          title="calls that earned no score: void, rejected or missed reveal, or under dispute"
        >
          <span>unscored</span>
          {/* All three are zero in this branch — unless there is no call log to
              count, in which case the tally is unknown, not zero. The narrow
              sidecar has no room for the tally, and "none" says the same. */}
          <span className="@[340px]:hidden">{stats === null ? "—" : "none"}</span>
          <span className="hidden @[340px]:inline">
            {stats === null ? "—" : "0 void · 0 failed · 0 other"}
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-px bg-[var(--color-border)] border-t border-[var(--color-border)]">
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
        </div>
      )}

      {/* IDENTITY — the kind mark IS the datum and brings its own accessible
          name (role="img" + aria-label "kind <kind>"), so it needs no label. */}
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 @[340px]:px-4 border-t border-[var(--color-border)]">
        <span
          className="flex items-center gap-1.5 ck-colhead"
          title={KIND_EXPLAINER[agent.kind] ?? "what sort of agent this is"}
        >
          <KindGlyph kind={agent.kind} size={16} />
          {agent.kind.replace("_", " ")}
        </span>
        <span className="ck-colhead" title="the chain this agent's calls settle on">
          {humanChain(agent.chain_id).toLowerCase()}
        </span>
      </div>
    </div>
  );
}

/** What each kind means — lives in the kind strip's tooltip, not a paragraph
 *  under the grid: the strip already names the kind, so a line restating it
 *  in prose was the label creeping back in (owner flag, 2026-08-12). */
const KIND_EXPLAINER: Record<string, string> = {
  agent: "agent — a person owns it through their sign-in. It can hold a rank.",
  benchmark: "benchmark — murmur runs this one so you have something to compare against.",
  attested: "attested — an Olas bond backs this agent.",
  internal_test: "internal — a test agent. Operators only.",
};

/**
 * One summary tile: a 12px label over its value, with the stat's mark to the
 * left once the panel can afford it.
 *
 * The label is on SCREEN now. It went missing on the theory that a glyph could
 * carry a stat name, which held for `wins` and for nothing else — a gauge, a
 * rotated percent square and an ellipsis name nothing without a hover, and a
 * hover is not available on touch. The sr-only stand-in is gone with it: the
 * visible label is the accessible name.
 *
 * The mark hides below a 440px panel. Three cells in a 360px sidecar leave
 * ~120px each, which a glyph, a label and a six-character value cannot share.
 * It also stays dim at every width: colour belongs to the value, where it
 * encodes win, loss and sign.
 */
function StatTile({
  icon,
  label,
  value,
  tone = "ink",
  title,
  tip,
  tipAlign = "end",
}: {
  /** Glyph naming the stat — an annotation now, not the tile's subject. */
  icon?: HeroIconName;
  label: string;
  value: ReactNode;
  tone?: TileTone;
  /** Plain-language definition, shown on hover. */
  title?: string;
  /** Hangs a FormulaTip off the label — plain sentence first, formula second. */
  tip?: { plain: string; formula: string };
  /** Which edge the tip box hangs from. `start` for tiles in column 1. */
  tipAlign?: "start" | "end";
}) {
  return (
    <div
      className="flex items-center gap-2 min-w-0 px-2 py-1.5 @[340px]:px-4 @[340px]:py-3 bg-[var(--color-bg)]"
      /* A tip tile takes no native title: the FormulaTip already answers the
         hover, and two tooltips over one label is one too many. */
      title={tip ? undefined : title}
    >
      {/* 440, not 340: at 340 the mark and its 8px gap take 28px out of a
          ~120px cell, and `+0.574` set at 20px needs 69 of the 88 that leaves
          — so the value truncated to `+0.…` at every width the sidecar
          actually ships at. The mark is an annotation; the number is the
          point, so the mark waits until the panel can seat both. */}
      {icon && (
        <span className="hidden @[440px]:block">
          <IkHero name={icon} size={24} className="ck-dim block" />
        </span>
      )}
      <span className="min-w-0">
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
          />
        ) : (
          <span className="ck-colhead block">{label}</span>
        )}
        {/* ck-tile-value scales with the panel (container query in compact.css)
            and sits after .ck-mono in the cascade, which utilities cannot. */}
        <span className={"ck-mono ck-tile-value block truncate " + TILE_TONE[tone]}>
          {value}
        </span>
      </span>
    </div>
  );
}


/** The market column: series name that truncates, window that does not. */
function MarketCell({
  label,
  marketId,
}: {
  label: string | null | undefined;
  marketId: string;
}) {
  const title = label ? `${label}\n${marketId}` : marketId;
  if (!label) {
    return (
      <span className="ck-mono ck-pos truncate" title={title}>
        {shortId(marketId, 9, 5)}
      </span>
    );
  }
  const { head, tail } = splitMarketLabel(label);
  if (tail === null) {
    return (
      <span className="ck-mono ck-pos truncate" title={title}>
        {head}
      </span>
    );
  }
  return (
    <span
      className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 min-w-0"
      title={title}
    >
      <span className="ck-mono ck-pos truncate">{head}</span>
      <span className="ck-colhead whitespace-nowrap">{tail}</span>
    </span>
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
