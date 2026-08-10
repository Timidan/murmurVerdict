import { useEffect, useMemo, useState } from "react";
import {
  fetchMarket,
  fetchMarketCalls,
  fetchMarketLeaderboard,
  ApiError,
  type AgentMarketRow,
  type MarketCallRow,
  type MarketRow,
  type MarketOracleRef,
  type MarketOracleSummary,
  type MarketVenueSnapshot,
} from "../api.js";
import { CompactTopbar } from "../components/compact/Topbar.js";
import { Panel } from "../components/compact/Panel.js";
import { CompactSparkline } from "../components/compact/Sparkline.js";
import { CompactLiveFeed } from "../components/compact/LiveFeed.js";
import { FormulaTip } from "../components/compact/FormulaTip.js";
import { VenueGlyph } from "../components/compact/glyphs.js";
import { ErrorState } from "../components/compact/ErrorState.js";
import { PanelSkeleton } from "../components/compact/PanelSkeleton.js";
import { TimeAgo } from "../components/compact/TimeAgo.js";
import { Ik, IkNav } from "../icons.js";
import { useStream } from "../hooks/useStream.js";
import { mergeMarketAgentRow } from "../hooks/stream-merge.js";
import { marketDisplayName, parseMarketConfig } from "../lib/market-meta.js";
import { shortId } from "../lib/display-format.js";
import { formatScore } from "../lib/score-format.js";
import { isTerminalFailureStatus } from "@shared/wire-call-status";

/**
 * COMPACT per-market detail. Single-screen ladder with a live sidecar tape,
 * a sealed-verdicts feed, and a metrics ribbon. Venue markets add live
 * odds on the outcome chips + a vol cell from the venue snapshot (60s
 * poll). All numbers mono, no card chrome, sub-row shows verdict_lb under
 * the headline verdict score.
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
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const stream = useStream();

  // Fold SSE markets.update for this specific market_id. The markets.update
  // rows are the lean wire shape (MarketLeaderboardEventAgentRow) — no REST-only
  // fields. MERGE the streamed wire fields onto the REST-hydrated row keyed by
  // agent_id so REST-only state survives a live tick instead of blanking,
  // mirroring LeaderboardPage's leaderboard.update merge. The RENDERED
  // REST-only fields — verdict_score_lb (lb score column) and call_scores (the
  // trend sparkline) — are preserved from the prior REST row so a live tick
  // doesn't blank them; last_resolved_at is preserved because AgentMarketRow
  // requires it. Functional updater reads prev without adding `agents` to the
  // effect deps.
  useEffect(() => {
    const evt = stream.markets[marketId];
    if (!evt) return;
    setAgents((prev) => {
      const byAgent = new Map((prev ?? []).map((r) => [r.agent_id, r]));
      return evt.agents.map((a) => mergeMarketAgentRow(a, byAgent.get(a.agent_id)));
    });
  }, [stream.markets, marketId]);

  useEffect(() => {
    let cancel = false;
    setMarket(null);
    setAgents(null);
    setCalls(null);
    setError(null);
    setNotFound(false);

    // "No such market" from the read surfaces: 404 market_not_found for
    // well-formed unknown ids, 400 schema_invalid for malformed ones
    // (e.g. a truncated 0x hash). Both mean the same thing to a viewer,
    // so both route to the NotFound render instead of the error line.
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
      // The verdicts feed is NON-CRITICAL chrome. A 404/400 still means "no
      // such market" (handled alongside the sibling reads), but any OTHER
      // failure — 500, aborted request, network blip — must not throw out of
      // Promise.all and collapse the whole page into the error state. Swallow
      // it to null so market + ladder still render and the feed panel falls
      // back to its own empty state.
      fetchMarketCalls(marketId, { limit: 20 }).catch((e: unknown) => {
        if (missing(e) && !cancel) setNotFound(true);
        return null;
      }),
    ])
      .then(([lb, m, callRows]) => {
        if (cancel) return;
        setMarket(m);
        if (lb) setAgents(lb.agents);
        else if (m) setAgents([]);
        // null callRows = feed fetch failed (or missing market): show the
        // feed's empty state, not a perpetual [loading…].
        setCalls(callRows ?? []);
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });

    return () => {
      cancel = true;
    };
  }, [marketId]);

  // Venue prices carry a 60s server-side TTL — re-poll the single market
  // while mounted so odds/volume stay fresh without a reload. Failures
  // (and late responses after unmount / market change) silently keep the
  // last-rendered data; the interval is torn down on unmount, marketId
  // change, or once the page has fallen into notFound/error.
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
  // Live venue odds/volume snapshot — venue-adapter rows only. Gamma-down
  // still delivers the skeleton with null prices/volume/liquidity.
  const venue = (isVenue ? market?.venue : null) ?? null;

  // 30s clock for the venue countdown only — the verdicts feed renders its
  // timestamps through <TimeAgo/>, which lives off the shared module-level
  // ticker. Gated on (venue + endDate) so a market with no countdown carries
  // no interval at all.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const needsCountdownTick = isVenue && Boolean(cfg?.endDate);
  useEffect(() => {
    if (!needsCountdownTick) return;
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [needsCountdownTick]);

  // Venue markets title the tab with the human question (fallback: market id);
  // restore whatever title was there before on unmount / market change.
  useEffect(() => {
    // In drawer mode the market isn't the page, so it must not hijack the tab.
    if (isDrawer || !market || !isVenueMarket(market)) return;
    const prev = document.title;
    const question = parseMarketConfig(market)?.question;
    document.title = `${question ?? market.market_id} · murmur`;
    return () => {
      document.title = prev;
    };
  }, [market]);

  const horizon = market ? formatHorizon(market.horizon_seconds) : "—";
  const assetSlug = market ? shortAssetSlug(market.asset_id) : "—";
  const taxonomy = market?.market_taxonomy ?? null;
  const mainCount = agents ? agents.filter((a) => a.market_main_tier).length : 0;
  const totalCalls = agents
    ? agents.reduce((acc, a) => acc + a.resolved_calls + a.pending_calls, 0)
    : 0;
  const leader = agents && agents.length > 0 ? agents[0] : null;

  const endsLabel = cfg?.endDate ? formatCountdown(cfg.endDate, nowMs) : null;
  const endsTitle = cfg?.endDate ? formatUtcTitle(cfg.endDate) : undefined;
  // Venue heading: question > humanized slug > (truncated) market id.
  let heading: string | null = null;
  if (market && isVenue) {
    const name = marketDisplayName(market);
    heading = name === market.market_id ? midTruncateId(name) : name;
  }

  return (
    <div className={isDrawer ? "flex flex-col min-h-0" : "mmr-shell min-h-dvh flex flex-col"}>
      {!isDrawer && (
        <CompactTopbar
          crumb={
            <span>
              markets <span className="ck-dim mx-1">/</span>
              <span className="ck-pos" title={marketId}>
                {midTruncateId(marketId)}
              </span>
            </span>
          }
        />
      )}

      {error && (
        <ErrorState kind="error" what="market" id={marketId} detail={error} />
      )}
      {notFound && <ErrorState kind="not_found" what="market" id={marketId} />}

      {!error && !notFound && (
        <>
          {/* HEADING — venue markets lead with the human question ───────── */}
          {heading !== null && (
            <section className="px-2 py-2 border-b border-[var(--color-border)]">
              {/* Title marker at heading scale: a 16px `market` glyph is the
                  region marker (P2). This h1 is a display heading, not a
                  .ck-title, so it carries no ::before square to replace —
                  one marker either way. Baseline-aligned + block flex so a
                  balanced two-line question still wraps as it does today. */}
              <h1
                className="ck-mono m-0 flex items-baseline gap-2"
                style={{
                  fontSize: 21,
                  fontWeight: 700,
                  lineHeight: 1.3,
                  color: "var(--color-display)",
                  textWrap: "balance",
                }}
                title={marketId}
              >
                <Ik name="market" />
                {heading}
              </h1>
            </section>
          )}

          {/* RIBBON — venue markets get one extra cell (vol) ─────────────── */}
          <section
            className={
              "grid grid-cols-2 border-b border-[var(--color-border)] " +
              (isDrawer ? "" : isVenue ? "md:grid-cols-9" : "md:grid-cols-8")
            }
          >
            <RCell label="market" value={midTruncateId(marketId)} title={marketId} />
            {isVenue ? (
              <VenueCell url={cfg?.gamma_url} venue={venueName(market)} />
            ) : (
              <RCell label="asset" value={assetSlug.toUpperCase()} />
            )}
            {isVenue ? (
              <RCell
                label="ends"
                value={endsLabel ?? "—"}
                title={endsTitle}
                tone={endsLabel === "ended" ? "dim" : "default"}
              />
            ) : (
              <RCell label="hzn" value={horizon} />
            )}
            {/* Venue traded volume — the cell renders even while the snapshot
                is null so the ribbon doesn't jump when data arrives. */}
            {isVenue && (
              <RCell
                label="vol"
                value={venue?.volume != null ? formatCompactUsd(venue.volume) : "—"}
                tone={venue?.volume != null ? "default" : "dim"}
                title={venueVolTitle(venue)}
              />
            )}
            <RCell label="status" value={market?.status ?? "—"} tone="dim" />
            <RCell label="agents" value={agents?.length ?? "—"} />
            <RCell label="main" value={mainCount} />
            <RCell label="vol·open" value={totalCalls} tone="dim" />
            <RCell
              label="lead·vs"
              value={leader ? formatScore(leader.verdict_score) : "—"}
              tone={leader && (leader.verdict_score ?? 0) >= 0 ? "pos" : "neg"}
            />
          </section>

          {/* OUTCOMES — venue names + live odds when the snapshot has prices;
              Gamma-down (null prices) leaves the chips name-only. ─────────── */}
          {isVenue && cfg?.outcomes && cfg.outcomes.length > 0 && (
            <section className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b border-[var(--color-border)]">
              <span className="ck-label mr-1">outcomes</span>
              {cfg.outcomes.map((o, i) => {
                const odds = venueOddsFor(venue, o);
                return (
                  <span
                    key={`${i}-${o}`}
                    className="ck-mono ck-value border border-[var(--color-border-vis)] px-2 py-[1px]"
                    title={odds?.title}
                  >
                    {o.toLowerCase()}
                    {odds !== null && <span className="ck-dim"> {odds.pct}%</span>}
                  </span>
                );
              })}
            </section>
          )}

          {/* META FACTS ─────────────────────────────────── */}
          <details className="border-b border-[var(--color-border)]">
            <summary className="ck-label cursor-pointer px-2 py-1.5 select-none">
              market config
            </summary>
            <div className={"details-fade grid grid-cols-2 border-t border-[var(--color-border)] " + (isDrawer ? "" : "md:grid-cols-8")}>
              <RCell
                label="class"
                value={taxonomy?.label ?? market?.market_kind ?? "—"}
                tone={taxonomy?.support_status === "reserved" ? "dim" : "pos"}
              />
              <RCell
                label="support"
                value={taxonomy?.support_status ?? "—"}
                tone={taxonomy?.support_status === "reserved" ? "dim" : "pos"}
              />
              <RCell
                label="payoff"
                value={taxonomy?.payoff_model ?? "—"}
                tone="dim"
              />
              <RCell
                label="settle"
                value={taxonomy?.settlement_model?.replace(/_/g, " ") ?? "—"}
                tone="dim"
              />
              <RCell
                label="oracle"
                value={oracleHealthLabel(market?.oracles)}
                tone={oracleHealthTone(market?.oracles)}
              />
              <RCell
                label="primary"
                value={oracleRefLabel(market?.oracles?.primary)}
                tone={oracleRefTone(market?.oracles?.primary)}
              />
              <RCell
                label="fallback"
                value={oracleRefLabel(market?.oracles?.fallback)}
                tone={oracleRefTone(market?.oracles?.fallback)}
              />
              <RCell label="void·band" value={market?.void_band ?? "—"} tone="dim" />
            </div>
          </details>

          {/* MAIN ────────────────────────────────────────── */}
          <main
            className={
              isDrawer
                ? "grid grid-cols-1"
                : "flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] min-h-0"
            }
          >
            <Panel
              title={
                <>
                  <IkNav name="leaderboard" /> agent ladder
                </>
              }
              meta={agents ? `${agents.length}` : ""}
              actions={
                <a href="#/dashboard" className="ck-btn ck-btn-bracket">
                  all markets
                </a>
              }
              className={isDrawer ? undefined : "lg:border-r-0"}
            >
              {agents === null && <PanelSkeleton rows={6} />}
              {agents !== null && agents.length === 0 && (
                <div className="px-2 py-2 ck-mono ck-dim">[no agents have resolved a call here yet]</div>
              )}
              {agents !== null && agents.length > 0 && <Ladder rows={agents} />}
            </Panel>
            {/* RIGHT COLUMN — sealed-verdicts feed above the live tape. */}
            <div className="flex flex-col min-h-0">
              <Panel
                title={
                  <>
                    <Ik name="verdict" /> verdicts · recent
                  </>
                }
                meta={calls ? `${calls.length}` : ""}
              >
                {calls === null && <PanelSkeleton rows={5} />}
                {calls !== null && calls.length === 0 && (
                  <div className="px-2 py-2 ck-mono ck-dim">[no calls on this market yet]</div>
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
                    live tape
                  </>
                }
                className="flex-1"
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
  return (
    <ul className="m-0 p-0 list-none">
      <li className="grid grid-cols-[28px_1fr_64px_64px_50px_44px_60px_44px] gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead">
        <span>#</span>
        <span>agent</span>
        {/* Formulas are the ladder's, copied from LeaderboardPage so the same
            column never explains itself two ways. Flex wrappers keep the cells
            right-aligned around the inline-flex tip trigger. `res` and `p` stay
            bare: they are plain counts (wire-leaderboard AgentMarketRow —
            `resolved_calls` / `pending_calls`), not derived quantities. */}
        <span className="flex justify-end">
          <FormulaTip
            label="verdict_score"
            formula="verdict_score = mean(call_score) - stdev(call_score) / sqrt(n)"
          >
            vs
          </FormulaTip>
        </span>
        <span className="flex justify-end">
          <FormulaTip
            label="lb"
            formula="lb = mean(call_score) - 1.6449 * standard_error(call_score)"
          >
            vs·lb
          </FormulaTip>
        </span>
        <span className="text-right">res</span>
        <span className="flex justify-end">
          <FormulaTip label="win_rate" formula="win rate = wins / (wins + losses)">
            wr
          </FormulaTip>
        </span>
        <span className="flex justify-end">
          <FormulaTip label="trend" formula="trend = recent resolved call_score series" />
        </span>
        <span className="text-right">p</span>
      </li>
      {rows.map((r, i) => (
        <li
          key={r.agent_id}
          className="relative grid grid-cols-[28px_1fr_64px_64px_50px_44px_60px_44px] gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] ck-hoverable"
        >
          {/* Stretched row link — real box so keyboard focus lands. */}
          <a
            href={`#/agents/${r.display_slug}`}
            aria-label={`open agent ${r.display_slug}`}
            className="ck-rowlink"
          />
          <span className="contents">
            <span className="ck-mono ck-dim">{String(i + 1).padStart(2, "0")}</span>
            <span className="flex items-baseline gap-1 min-w-0">
              <span className="ck-mono ck-pos truncate" title={r.display_name}>
                {r.display_slug}
              </span>
              <span className={"ck-label " + (r.market_main_tier ? "ck-pos" : "ck-dim")}>
                {r.market_main_tier ? "·main" : "·prov"}
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
            <span className="ck-mono ck-dim text-right">
              {String(r.resolved_calls).padStart(3, "0")}
            </span>
            <span className="ck-mono ck-dim text-right">
              {r.win_rate === null ? "—" : Math.round(r.win_rate * 100)}
            </span>
            <span className="flex justify-end items-center">
              <CompactSparkline
                values={r.call_scores?.filter((s): s is number => s !== null) ?? []}
                width={56}
                height={12}
              />
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

/**
 * Sealed-verdicts feed — one row per call: agent slug (ladder-style link),
 * lifecycle tag, time-ago. Pending rows are operator-blind on this wire
 * (existence + timestamps + agent only), so the row deliberately carries no
 * side/confidence. Newest first from the API; capped at 20, no pagination.
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
 * Settled, scored-or-void terminal states. The market-calls wire carries the
 * RAW CallStatus enum (src/verdict/schema.ts CallStatusSchema), passed
 * untransformed by projectCallRow — so this feed must map it, never render it
 * literally. A call is SEALED (operator-blind: pos tone, "·sealed") while it is
 * unresolved AND terminal in neither this set NOR the shared terminal-failure
 * set — i.e. submitted / preflighted / accepted / pending_t0 / pending_t1 /
 * disputed. The reveal-failed / rejected terminals are the SHARED
 * isTerminalFailureStatus set (@shared/wire-call-status), which the daemon
 * guard pins to CallStatus, so they are derived rather than re-listed here.
 * `void` is kept as a defensive legacy status literal (not in CallStatus).
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

/** Safe, dim display label per settled terminal state — keeps a raw enum from
 *  ever reaching the UI. `void` reads "·void"; resolved/re_resolved read
 *  "·resolved". Reveal-failed / rejected terminals are labelled "·void" in
 *  {@link verdictStatusTag}. Unlisted terminals fall back to "·resolved". */
const SETTLED_TERMINAL_LABELS: Record<string, string> = {
  resolved: "·resolved",
  re_resolved: "·resolved",
  void: "·void",
};

/**
 * Map a feed row's lifecycle to a display tag. Unresolved-non-terminal →
 * "·sealed" (pos). A present `resolved_at`, or any terminal status → a safe
 * dim label; reveal/rejection failures read "·void" (no valid verdict); an
 * unexpected terminal falls back to "·resolved". Never emits a raw enum value.
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

function RCell({
  label,
  value,
  tone = "default",
  title,
}: {
  label: string;
  value: number | string;
  tone?: "pos" | "neg" | "dim" | "default";
  /** Hover text override — defaults to the rendered value (e.g. full id behind a truncated one). */
  title?: string;
}) {
  const toneClass =
    tone === "pos" ? "ck-pos" : tone === "neg" ? "ck-neg" : tone === "dim" ? "ck-dim" : "ck-pos";
  return (
    <div className="px-2 py-1.5 border-r border-[var(--color-border)] flex flex-col gap-0.5 min-w-0">
      <span className="ck-label">{label}</span>
      <span
        className={"ck-mono ck-value truncate " + toneClass}
        title={title ?? String(value)}
      >
        {value}
      </span>
    </div>
  );
}

/** Ribbon cell for the venue-adapter source — external link out to the venue's
 *  own event page when the config carries one. */
function VenueCell({ url, venue }: { url: string | undefined; venue: string }) {
  return (
    <div className="px-2 py-1.5 border-r border-[var(--color-border)] flex flex-col gap-0.5 min-w-0">
      <span className="ck-label">venue</span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="ck-pos no-underline hover:opacity-80 inline-flex items-center gap-1"
          title={`${venue} — open event`}
        >
          <VenueGlyph venue={venue} size={16} />
          <span aria-hidden="true" className="ck-dim text-[12px]">↗</span>
        </a>
      ) : (
        <VenueGlyph venue={venue} size={16} />
      )}
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

function oracleHealthLabel(oracles: MarketOracleSummary | null | undefined): string {
  if (!oracles) return "unknown";
  if (oracles.health === "ok") return "ok";
  if (oracles.health === "warn") return "check";
  return "attention";
}

function oracleHealthTone(
  oracles: MarketOracleSummary | null | undefined,
): "pos" | "neg" | "dim" | "default" {
  if (!oracles) return "dim";
  if (oracles.health === "ok") return "pos";
  return "neg";
}

function oracleRefLabel(ref: MarketOracleRef | null | undefined): string {
  if (!ref) return "none";
  return `${ref.oracle_id} · ${ref.status}`;
}

function oracleRefTone(
  ref: MarketOracleRef | null | undefined,
): "pos" | "neg" | "dim" | "default" {
  if (!ref) return "dim";
  if (ref.status === "listed" && ref.asset_match !== false) return "pos";
  return "neg";
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

/** Compact countdown to an ISO close: `6d 14h` / `14h 02m` / `42m` / `ended`. */
function formatCountdown(endDate: string, nowMs: number): string | null {
  const end = Date.parse(endDate);
  if (!Number.isFinite(end)) return null;
  const ms = end - nowMs;
  if (ms <= 0) return "ended";
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
 * Live odds for one outcome chip. Returns null when the venue snapshot is
 * absent, Gamma is down (prices null), or the outcome has no price point —
 * the chip then stays name-only. Prices arrive as 0..1 numbers from the
 * daemon; coerce defensively in case the wire ever carries decimal strings.
 */
function venueOddsFor(
  venue: MarketVenueSnapshot | null,
  outcome: string,
): { pct: number; title: string } | null {
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
  return { pct: Math.round(n * 100), title: `${hit.price}${asOf}` };
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
