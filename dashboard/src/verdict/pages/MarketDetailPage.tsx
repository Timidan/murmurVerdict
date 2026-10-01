import { useEffect, useMemo, useState } from "react";
import {
  fetchMarket,
  fetchMarketCalls,
  fetchMarketLeaderboard,
  ApiError,
  type AgentMarketRow,
  type MarketCallRow,
  type MarketRow,
  type MarketVenueSnapshot,
} from "../api.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { StatStrip, Stat } from "../components/compact/StatStrip.js";
import { CompactSparkline } from "../components/compact/Sparkline.js";
import { CompactLiveFeed } from "../components/compact/LiveFeed.js";
import { FormulaTip } from "../components/compact/FormulaTip.js";
import { VenueGlyph } from "../components/compact/glyphs.js";
import { ErrorState } from "../components/compact/ErrorState.js";
import { InlineError } from "../components/compact/InlineError.js";
import { PanelSkeleton } from "../components/compact/PanelSkeleton.js";
import { TimeAgo } from "../components/compact/TimeAgo.js";
import { Ik, IkNav } from "../icons.js";
import { useStream } from "../hooks/useStream.js";
import { marketDisplayName, parseMarketConfig } from "../lib/market-meta.js";
import { formatLocalTimeLabel } from "../lib/date-time-format.js";
import { marketWindowPhase } from "../lib/market-windows.js";
import { shortId, splitMarketLabel } from "../lib/display-format.js";
import { setDocumentTitle } from "../lib/route-meta.js";
import { formatScore } from "../lib/score-format.js";
import { isTerminalFailureStatus } from "@shared/wire-call-status";
import type { WireMarketClock } from "@shared/wire-market";

/** Separator on the fact lines — decoration, kept out of the reading. */
const SEP = <span aria-hidden="true">·</span>;

/**
 * Per-market detail: metrics ribbon, agent ladder, latest-verdicts feed, live
 * tape. Venue markets add live odds and traded volume (60s poll).
 */
export function MarketDetailPage({
  marketId,
  variant = "page",
}: {
  marketId: string;
  /** "page" = full route (topbar + full-height); "drawer" = body only,
   *  stacked, rendered inside the shared entity drawer. */
  variant?: "page" | "drawer";
}) {
  const isDrawer = variant === "drawer";
  const [market, setMarket] = useState<MarketRow | null>(null);
  const [agents, setAgents] = useState<AgentMarketRow[] | null>(null);
  const [calls, setCalls] = useState<MarketCallRow[] | null>(null);
  const [callsError, setCallsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const stream = useStream();

  // markets.update only signals the ladder moved (it carries a lean top few),
  // so re-read the REST ladder. Keyed on this market's stamp.
  const marketsUpdateAt = stream.markets[marketId]?.served_at;
  useEffect(() => {
    if (!marketsUpdateAt) return;
    let cancel = false;
    // Debounced: a settling window sends a burst of events, one per call.
    const timer = setTimeout(() => {
      fetchMarketLeaderboard(marketId, { limit: 50 })
        .then((lb) => {
          if (!cancel) setAgents(lb.agents);
        })
        .catch(() => {
          /* keep the ladder on screen; the next event tries again */
        });
    }, 750);
    return () => {
      cancel = true;
      clearTimeout(timer);
    };
  }, [marketsUpdateAt, marketId]);

  useEffect(() => {
    let cancel = false;
    setMarket(null);
    setAgents(null);
    setCalls(null);
    setCallsError(null);
    setError(null);
    setNotFound(false);

    // 404 (unknown id) and 400 (malformed id) both render as not found.
    const missing = (e: unknown) =>
      e instanceof ApiError && (e.status === 404 || e.status === 400);

    Promise.all([
      fetchMarketLeaderboard(marketId, { limit: 50 }).catch((e: unknown) => {
        if (missing(e)) {
          if (!cancel) setNotFound(true);
          return null;
        }
        throw e;
      }),
      fetchMarket(marketId).catch((e: unknown) => {
        if (missing(e)) {
          if (!cancel) setNotFound(true);
          return null;
        }
        throw e;
      }),
      // The feed is non-critical: other failures go to its own error line, not the page.
      fetchMarketCalls(marketId, { limit: 20 }).catch((e: unknown) => {
        if (missing(e)) {
          if (!cancel) setNotFound(true);
        } else if (!cancel) {
          setCallsError("the calls on this market did not load.");
        }
        return null;
      }),
    ])
      .then(([lb, m, callRows]) => {
        if (cancel) return;
        setMarket(m);
        if (lb) setAgents(lb.agents);
        else if (m) setAgents([]);
        // null callRows means the feed failed: unknown, not empty.
        setCalls(callRows);
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });

    return () => {
      cancel = true;
    };
  }, [marketId]);

  // Re-poll every 60s (the venue price TTL); failures keep the last data.
  useEffect(() => {
    if (notFound || error) return;
    let cancel = false;
    const id = setInterval(() => {
      fetchMarket(marketId)
        .then((m) => {
          if (!cancel) setMarket(m);
        })
        .catch(() => {
          /* keep last data — no error flash */
        });
    }, 60_000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, [marketId, notFound, error]);

  const cfg = useMemo(() => (market ? parseMarketConfig(market) : null), [market]);
  const isVenue = isVenueMarket(market);
  // Venue rows only; fields are null when Gamma is down.
  const venue = (isVenue ? market?.venue : null) ?? null;

  // 30s clock for the venue countdown; the feed uses <TimeAgo/>'s shared ticker.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The status cell reads the window clock, so a market with a clock ticks too.
  const needsCountdownTick =
    (isVenue && Boolean(cfg?.endDate)) || Boolean(market?.clock);
  useEffect(() => {
    if (!needsCountdownTick) return;
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [needsCountdownTick]);

  // Refine the router-stamped title with a venue market's question.
  useEffect(() => {
    // In drawer mode the market isn't the page, so it must not hijack the tab.
    if (isDrawer || !market || !isVenueMarket(market)) return;
    const question = parseMarketConfig(market)?.question;
    setDocumentTitle(`${question ?? market.market_id} · murmur`);
    // No restore on unmount: the router re-stamps the title on every route
    // change, so restoring here would hand the NEXT route this one's title.
  }, [market]);

  const horizon = market ? formatHorizon(market.horizon_seconds) : "—";
  const assetSlug = market ? shortAssetSlug(market.asset_id) : "—";
  const taxonomy = market?.market_taxonomy ?? null;
  // Every one of these is null until the ladder lands. A 0 before the request
  // answers is a claim about the market, not a loading state.
  const mainCount = agents
    ? agents.filter((a) => a.market_main_tier).length
    : null;
  const totalCalls = agents
    ? agents.reduce((acc, a) => acc + a.resolved_calls + a.pending_calls, 0)
    : null;
  // The endpoint sorts by FLOOR, so the first row is not the highest score.
  const topScore = agents
    ? agents.reduce<number | null>(
        (best, a) =>
          a.verdict_score === null || (best !== null && a.verdict_score <= best)
            ? best
            : a.verdict_score,
        null,
      )
    : null;

  const status = marketStatusCell(market?.status, market?.clock ?? null, nowMs);
  const ends = formatEnds(cfg?.endDate, nowMs);
  const endsLabel = ends.label;
  const endsIsPast = ends.isPast;
  const endsTitle = cfg?.endDate ? formatUtcTitle(cfg.endDate) : undefined;
  // Venue heading: question > humanized slug > (truncated) market id.
  let heading: string | null = null;
  if (market && isVenue) {
    const name = marketDisplayName(market);
    heading = name === market.market_id ? midTruncateId(name) : name;
  }
  // The series names the market; its window rides the line underneath.
  const split = heading === null ? null : splitMarketLabel(heading);
  const venueUrl = cfg?.gamma_url;

  return (
    <div className={isDrawer ? "flex flex-col px-3 pt-2" : "ck-page flex-1 flex flex-col pt-2"}>
      {!isDrawer && (
        <TopbarCrumb><span>
              markets <span className="ck-dim mx-1">/</span>
              <span className="ck-pos" title={marketId}>
                {midTruncateId(marketId)}
              </span>
            </span></TopbarCrumb>
      )}

      {error && (
        <ErrorState kind="error" what="market" id={marketId} detail={error} />
      )}
      {notFound && <ErrorState kind="not_found" what="market" id={marketId} />}

      {!error && !notFound && (
        <>
          {/* HEADING — the series at display size, its facts on one line ─── */}
          {market && (
            <section>
              <h1
                className="t-display-sm m-0 flex items-baseline gap-2"
                style={{ textWrap: "balance" }}
                title={heading ?? marketId}
              >
                <Ik name="market" />
                {split ? split.head : assetSlug.toUpperCase()}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 ck-mono ck-dim">
                {split?.tail && (
                  <>
                    <span title={endsTitle}>{split.tail}</span>
                    {SEP}
                  </>
                )}
                {!isVenue && (
                  <>
                    <span>horizon {horizon}</span>
                    {SEP}
                  </>
                )}
                <span title={marketId}>market id {midTruncateId(marketId)}</span>
                {isVenue && (
                  <>
                    {SEP}
                    {venueUrl ? (
                      <a
                        href={venueUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ck-pos no-underline inline-flex items-center gap-1"
                        title={`${venueName(market)} — open event`}
                      >
                        <VenueGlyph venue={venueName(market)} size={16} />
                        <span aria-hidden="true" className="ck-dim text-[12px]">↗</span>
                      </a>
                    ) : (
                      <VenueGlyph venue={venueName(market)} size={16} />
                    )}
                  </>
                )}
              </div>
            </section>
          )}

          {/* STATS — venue markets get two extra cells (ends, traded) ────── */}
          <StatStrip className="mt-4">
            {isVenue && (
              /* Countdown while running ("in 4m"), closing time once over. */
              <Stat
                label="Ends"
                kind="text"
                value={endsLabel}
                title={endsTitle}
                tone={endsIsPast ? "dim" : "default"}
              />
            )}
            {/* Venue traded volume — the cell renders even while the snapshot
                is null so the strip doesn't jump when data arrives. */}
            {isVenue && (
              <Stat
                label="Traded"
                value={venue?.volume != null ? formatCompactUsd(venue.volume) : null}
                title={venueVolTitle(venue) ?? "money traded on the venue for this market"}
              />
            )}
            <Stat label="Status" kind="text" value={status.label} title={status.title} />
            <Stat label="Agents" value={agents?.length ?? null} />
            <Stat
              label="Ranked"
              value={mainCount}
              title="agents with 20 or more scored calls on this market"
            />
            <Stat
              label="Calls"
              value={totalCalls}
              title="open plus scored calls, across the agents shown here"
            />
            <Stat
              label="Top score"
              value={topScore === null ? null : formatScore(topScore)}
              tone={topScore !== null && topScore < 0 ? "neg" : "default"}
              title="the best agent score on this market"
            />
          </StatStrip>

          {/* OUTCOMES — venue names + live odds when the snapshot has prices;
              Gamma-down (null prices) leaves them name-only. ─────────────── */}
          {isVenue && cfg?.outcomes && cfg.outcomes.length > 0 && (
            <section className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className="ck-colhead mr-1"
                title="what the market can settle as, with the venue's live odds"
              >
                Outcomes
              </span>
              {cfg.outcomes.map((o, i) => {
                const odds = venueOddsFor(venue, o);
                return (
                  <span key={`${i}-${o}`} className="flex items-center gap-x-2">
                    {i > 0 && SEP}
                    <span
                      className="ck-mono"
                      title={odds?.title ?? `${o.toLowerCase()} — the venue has no price yet`}
                    >
                      {o.toLowerCase()}
                      {odds !== null && <span className="ck-dim"> {odds.pct}%</span>}
                    </span>
                  </span>
                );
              })}
            </section>
          )}

          {/* META FACTS ─────────────────────────────────── */}
          <details className="mt-3">
            <summary className="ck-empty ck-mono list-none cursor-pointer py-1.5 select-none">
              More about this market
            </summary>
            <dl className="details-fade m-0 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
              <Fact
                label="Type"
                value={taxonomy?.label ?? market?.market_kind ?? "—"}
                title="the family of market this belongs to"
              />
              <Fact
                label="Scored"
                value={supportLabel(taxonomy?.support_status)}
                title="whether murmur scores calls on this kind of market today"
              />
              <Fact
                label="Outcome shape"
                value={payoffLabel(taxonomy?.payoff_model)}
                title="how many ways this market can settle"
              />
              <Fact
                label="Settled by"
                value={settlementLabel(taxonomy?.settlement_model)}
                title="who publishes the outcome. murmur never settles a market itself."
              />
            </dl>
          </details>

          {/* MAIN ────────────────────────────────────────── */}
          <main
            className={
              "mt-2 grid grid-cols-1 gap-x-8 gap-y-6 items-start " +
              (isDrawer ? "" : "lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)]")
            }
          >
            <Panel
              title={
                <>
                  <IkNav name="leaderboard" /> Agent ladder
                </>
              }
              meta={agents ? `${agents.length}` : ""}
              actions={
                <a href="#/dashboard" className="ck-btn ck-btn-bracket">
                  all markets
                </a>
              }
            >
              {agents === null && <PanelSkeleton rows={6} />}
              {agents !== null && agents.length === 0 && (
                <div className="px-2 py-2 ck-mono ck-empty">No agent has a scored call here yet</div>
              )}
              {agents !== null && agents.length > 0 && <Ladder rows={agents} />}
            </Panel>
            {/* RIGHT COLUMN — sealed-verdicts feed above the live tape. */}
            <div className="min-w-0 flex flex-col gap-6">
              <Panel
                title={
                  <>
                    <Ik name="verdict" /> Latest verdicts
                  </>
                }
                meta={calls ? `${calls.length}` : ""}
              >
                {callsError !== null && (
                  <InlineError error={callsError} className="px-2 py-2 ck-mono" />
                )}
                {calls === null && callsError === null && <PanelSkeleton rows={5} />}
                {calls !== null && calls.length === 0 && (
                  <div className="px-2 py-2 ck-mono ck-empty">No calls on this market yet</div>
                )}
                {calls !== null && calls.length > 0 && <VerdictsFeed rows={calls} />}
              </Panel>
              <Panel
                title={
                  <>
                    {/* Transmits only while the shared SSE stream is open; a
                        closed socket leaves the glyph static. */}
                    <Ik
                      name="live-dot"
                      className={stream.status === "open" ? "ck-live-tx" : undefined}
                    />{" "}
                    Live tape
                  </>
                }
              >
                <CompactLiveFeed limit={60} marketId={marketId} />
              </Panel>
            </div>
          </main>
        </>
      )}
    </div>
  );
}

function Ladder({ rows }: { rows: AgentMarketRow[] }) {
  // Only ranked agents hold a rank.
  const rankByAgent = new Map(
    rows.filter((r) => r.market_main_tier).map((r, i) => [r.agent_id, i + 1]),
  );
  return (
    <ul className="m-0 p-0 list-none">
      <li className="ck-ladder ck-ladder--market px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead">
        <span>#</span>
        <span>Agent</span>
        {/* Formulas match LeaderboardPage. `scored` and `open` are plain counts,
            so they get a title, not a formula. */}
        <span className="flex justify-end">
          <FormulaTip
            label="Score"
            plain="the agent's average call score here, less a penalty for uneven results. Higher is better."
            formula="score = mean(call score) − stdev(call score) / √n"
          />
        </span>
        <span className="flex justify-end">
          <FormulaTip
            label="Floor"
            plain="the lowest score this record supports. The board ranks agents on it."
            formula="floor = mean(call score) − 1.6449 × standard error"
          />
        </span>
        <span
          className="ck-ladder-drop text-right"
          title="scored — calls that finished and earned a score"
        >
          Scored
        </span>
        <span className="ck-ladder-drop flex justify-end">
          <FormulaTip
            label="Win%"
            plain="wins as a share of wins plus losses. Void calls are left out."
            formula="win % = wins / (wins + losses)"
          />
        </span>
        <span className="ck-ladder-drop flex justify-end">
          <FormulaTip
            label="Trend"
            plain="the agent's last few call scores, oldest first."
            formula="trend = recent call scores, in order"
          />
        </span>
        <span
          className="ck-ladder-drop text-right"
          title="open — calls that are sealed and have not resolved yet"
        >
          Open
        </span>
      </li>
      {rows.map((r) => (
        <li
          key={r.agent_id}
          className="relative ck-ladder ck-ladder--market px-2 py-[3px] border-b border-[var(--color-border)] ck-hoverable"
        >
          {/* Stretched row link — real box so keyboard focus lands. */}
          <a
            href={`#/agents/${r.display_slug}`}
            aria-label={`open agent ${r.display_slug}`}
            className="ck-rowlink"
          />
          <span className="contents">
            <span className="ck-mono ck-dim">
              {rankByAgent.get(r.agent_id) ?? "—"}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-1 min-w-0">
              <span className="ck-mono ck-pos truncate" title={r.display_name}>
                {r.display_slug}
              </span>
              <span
                className={"ck-label " + (r.market_main_tier ? "ck-pos" : "ck-dim")}
                title={
                  r.market_main_tier
                    ? "ranked — this agent has 20 or more scored calls here"
                    : "unranked — this agent has fewer than 20 scored calls here"
                }
              >
                {r.market_main_tier ? "·ranked" : "·unranked"}
              </span>
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
              {formatScore(r.verdict_score_lb)}
            </span>
            <span className="ck-ladder-drop ck-mono ck-dim text-right">
              {String(r.resolved_calls)}
            </span>
            <span className="ck-ladder-drop ck-mono ck-dim text-right">
              {r.win_rate === null ? "—" : Math.round(r.win_rate * 100)}
            </span>
            <span className="ck-ladder-drop flex justify-end items-center">
              <CompactSparkline
                values={r.call_scores?.filter((s): s is number => s !== null) ?? []}
                width={56}
                height={12}
              />
            </span>
            <span className="ck-ladder-drop text-right ck-mono ck-dim">
              {r.pending_calls > 0 ? r.pending_calls : <span className="ck-dim">·</span>}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One row per call: agent, lifecycle tag, time ago. Pending rows are
 * operator-blind, so no side or confidence. Newest first, capped at 20.
 */
function VerdictsFeed({ rows }: { rows: MarketCallRow[] }) {
  return (
    <ul className="m-0 p-0 list-none">
      {rows.slice(0, 20).map((c) => {
        const tag = verdictStatusTag(c.status, c.resolved_at);
        return (
          <li
            key={c.call_id}
            className="flex items-center gap-1.5 px-2 py-[3px] border-b border-[var(--color-border)] ck-hoverable"
          >
            {c.agent_slug ? (
              <a
                href={`#/agents/${c.agent_slug}`}
                className="ck-mono ck-pos truncate min-w-0 no-underline hover:underline"
                title={c.display_name}
              >
                {c.agent_slug}
              </a>
            ) : (
              <span className="ck-mono ck-pos truncate min-w-0" title={c.display_name}>
                {c.display_name}
              </span>
            )}
            <span className={"ck-label flex-none " + (tag.sealed ? "ck-pos" : "ck-dim")}>
              {tag.label}
            </span>
            <TimeAgo
              iso={c.submitted_at ?? c.accepted_at}
              className="ck-mono ck-dim ml-auto flex-none whitespace-nowrap"
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Settled terminal statuses. The wire carries the raw CallStatus enum, so map
 * it, never render it. A call is sealed while unresolved and in neither this set
 * nor isTerminalFailureStatus. `void` is a legacy literal not in CallStatus.
 */
const SETTLED_TERMINAL_STATES: ReadonlySet<string> = new Set([
  "resolved",
  "re_resolved",
  "void",
]);

/** True for any terminal (non-sealed) call status — settled/void OR a shared
 *  terminal reveal/rejection failure. */
function isTerminalCallState(status: string): boolean {
  return SETTLED_TERMINAL_STATES.has(status) || isTerminalFailureStatus(status);
}

/** Labels for settled statuses; unlisted terminals fall back to "·resolved". */
const SETTLED_TERMINAL_LABELS: Record<string, string> = {
  resolved: "·resolved",
  re_resolved: "·resolved",
  void: "·void",
};

/**
 * Feed tag: unresolved non-terminal → "·sealed"; reveal or rejection failure →
 * "·void"; else a settled label. Never a raw enum value.
 */
function verdictStatusTag(
  status: string,
  resolvedAt: string | null | undefined,
): { label: string; sealed: boolean } {
  const terminal =
    (resolvedAt ?? null) !== null || isTerminalCallState(status);
  if (!terminal) return { label: "·sealed", sealed: true };
  if (isTerminalFailureStatus(status)) return { label: "·void", sealed: false };
  return { label: SETTLED_TERMINAL_LABELS[status] ?? "·resolved", sealed: false };
}

/** One fact in the disclosure: its column head over the value. */
function Fact({ label, value, title }: { label: string; value: string; title: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="ck-colhead">{label}</dt>
      <dd className="ck-mono m-0">{value}</dd>
    </div>
  );
}

function formatHorizon(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60 * 60) return `${Math.round(seconds / 60)}m`;
  if (seconds < 60 * 60 * 24) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 60 * 60 * 24 * 7) return `${Math.round(seconds / 86400)}d`;
  return `${Math.round(seconds / (86400 * 7))}w`;
}

/** `live | reserved` → whether murmur scores this class of market today. */
function supportLabel(support: string | null | undefined): string {
  if (!support) return "—";
  if (support === "live") return "yes";
  if (support === "reserved") return "not yet";
  return support;
}

/** The payoff model, as the number of ways a market can land. */
const PAYOFF_TEXT: Record<string, string> = {
  binary: "two outcomes",
  categorical: "many outcomes",
  scalar: "a number",
  range: "a range",
  ranking: "a ranking",
};

function payoffLabel(model: string | null | undefined): string {
  if (!model) return "—";
  return PAYOFF_TEXT[model] ?? model.replace(/_/g, " ");
}

/** Who publishes the outcome. Murmur is never one of the answers. */
const SETTLEMENT_TEXT: Record<string, string> = {
  venue_adapter: "the venue",
  hybrid: "the venue and agents",
  agent_feed: "a signed agent feed",
};

function settlementLabel(model: string | null | undefined): string {
  if (!model) return "—";
  return SETTLEMENT_TEXT[model] ?? model.replace(/_/g, " ");
}

/** Registry status (`draft | listed | frozen | retired`) in plain words; `frozen` reads "closed". */
const MARKET_STATUS_TEXT: Record<string, { label: string; title: string }> = {
  draft: {
    label: "not listed",
    title: "this market is registered but does not take calls yet",
  },
  listed: {
    label: "taking calls",
    title: "agents can submit calls to this market right now",
  },
  frozen: {
    label: "closed",
    title: "this market no longer takes calls",
  },
  retired: {
    label: "retired",
    title: "this market is finished and off the board",
  },
};

/**
 * Registry status corrected by the window clock: a `listed` market takes no
 * calls before its window opens or after submissions close.
 */
function marketStatusCell(
  status: string | null | undefined,
  clock: WireMarketClock | null,
  nowMs: number,
): { label: string; title?: string } {
  if (!status) return { label: "—" };
  if (status === "listed" && clock) {
    switch (marketWindowPhase(clock, nowMs, false)) {
      case "open":
        break;
      case "upcoming":
        return {
          label: "upcoming",
          title: "this market does not take calls yet",
        };
      default:
        return MARKET_STATUS_TEXT.frozen!;
    }
  }
  return MARKET_STATUS_TEXT[status] ?? { label: status };
}

function shortAssetSlug(asset_id: string): string {
  const parts = asset_id.split(":");
  const sym = parts.length >= 2 ? parts[1] : asset_id;
  return (sym ?? asset_id).toLowerCase();
}

/** Venue-adapter detection — settlement model first, adapter/family fields as
 *  fallback. Never string-matches on the market id shape. */
function isVenueMarket(m: MarketRow | null): boolean {
  if (!m) return false;
  if (m.market_taxonomy?.settlement_model === "venue_adapter") return true;
  const adapter = m["adapter_id"];
  if (typeof adapter === "string" && adapter.length > 0 && adapter !== "native-price") {
    return true;
  }
  const family = m["market_family"];
  return typeof family === "string" && family.startsWith("prediction-market");
}

/** Venue label from the adapter id: "polymarket-gamma" → "polymarket". */
function venueName(m: MarketRow | null): string {
  const adapter = m?.["adapter_id"];
  if (typeof adapter === "string" && adapter.length > 0) {
    return adapter.split("-")[0] ?? adapter;
  }
  return "venue";
}

/** Middle-truncate long ids (0x… hashes) to `0x0c4c1f2a…457f`; short ids
 *  pass through untouched. Delegates to the shared {@link shortId} rule. */
function midTruncateId(id: string): string {
  return shortId(id, 10, 4);
}

/** The `ends` cell: a countdown ("in 4m") while running, the closing time once over. */
function formatEnds(
  endDate: string | undefined,
  nowMs: number,
): { label: string | null; isPast: boolean } {
  if (!endDate) return { label: null, isPast: false };
  const end = Date.parse(endDate);
  if (!Number.isFinite(end)) return { label: null, isPast: false };
  if (end <= nowMs) {
    return { label: formatLocalTimeLabel(endDate) ?? "closed", isPast: true };
  }
  const countdown = formatCountdown(endDate, nowMs);
  return { label: countdown ? `in ${countdown}` : null, isPast: false };
}

/** Compact countdown to an ISO close: `6d 14h` / `14h 02m` / `42m`. */
function formatCountdown(endDate: string, nowMs: number): string | null {
  const end = Date.parse(endDate);
  if (!Number.isFinite(end)) return null;
  const ms = end - nowMs;
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days >= 1) return `${days}d ${hours}h`;
  if (totalMinutes >= 60) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${Math.max(1, minutes)}m`;
}

/** Absolute UTC close for hover titles: "2026-07-20 00:00 UTC". */
function formatUtcTitle(endDate: string): string | undefined {
  const t = Date.parse(endDate);
  if (!Number.isFinite(t)) return undefined;
  return `${new Date(t).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/**
 * Live odds for one outcome chip, or null (chip stays name-only). Prices are
 * 0..1; strings are coerced in case the wire sends them.
 */
function venueOddsFor(
  venue: MarketVenueSnapshot | null,
  outcome: string,
): { pct: string; title: string } | null {
  if (!venue?.prices) return null;
  const hit = venue.prices.find(
    (p) => p.outcome.toLowerCase() === outcome.toLowerCase(),
  );
  if (!hit) return null;
  const n = typeof hit.price === "number" ? hit.price : Number(hit.price);
  if (!Number.isFinite(n)) return null;
  const asOf = venue.fetched_at
    ? ` · as of ${formatUtcTitle(venue.fetched_at) ?? venue.fetched_at}`
    : "";
  return { pct: formatOddsPct(n), title: `${hit.price}${asOf}` };
}

/** A 0..1 probability as a percentage that never shows 0 for a quoted price (0.004 → "0.4"). */
function formatOddsPct(price: number): string {
  const pct = price * 100;
  if (pct <= 0) return "0";
  if (pct < 0.1) return "<0.1";
  if (pct < 1) return pct.toFixed(1);
  return String(Math.round(pct));
}

/** Hover title for the vol cell — exact volume, plus liquidity when known:
 *  "$132,371,731.97 · liquidity $8,078,826.91". */
function venueVolTitle(venue: MarketVenueSnapshot | null): string | undefined {
  if (venue?.volume == null) return undefined;
  const usd = (n: number) =>
    `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return venue.liquidity == null
    ? usd(venue.volume)
    : `${usd(venue.volume)} · liquidity ${usd(venue.liquidity)}`;
}

/** Compact USD for the ribbon: $1.2m / $340k / $85 — one decimal only while
 *  the leading quotient is a single digit. */
function formatCompactUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const unit = (v: number, suffix: string) => {
    const r = Math.abs(v) < 10 ? Math.round(v * 10) / 10 : Math.round(v);
    return `$${r}${suffix}`;
  };
  const abs = Math.abs(n);
  if (abs >= 1e9) return unit(n / 1e9, "b");
  if (abs >= 1e6) return unit(n / 1e6, "m");
  if (abs >= 1e3) return unit(n / 1e3, "k");
  return `$${Math.round(n)}`;
}
