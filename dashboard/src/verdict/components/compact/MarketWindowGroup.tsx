import type { MarketRow } from "../../api.js";
import type { WireVenueMarketRow, WireVenueResolutionRow } from "@shared/wire-venue";
import {
  marketAssetSymbol,
  marketDisplayName,
  parseMarketConfig,
} from "../../lib/market-meta.js";
import {
  formatCountdown,
  formatLocalDateTime,
  formatLocalTimeLabel,
  formatLocalTimeRange,
} from "../../lib/date-time-format.js";
import {
  marketWindowCountdownLabel,
  marketWindowCountdownTargetMs,
  type MarketWindowGroup as WindowGroup,
  type MarketWindowPhase,
} from "../../lib/market-windows.js";
import { sentenceCase } from "../../lib/display-format.js";
import { MarketAssetIcon } from "./MarketAssetIcon.js";

/**
 * One window: the assets sharing a clock, under one header with the range,
 * phase, countdown and outcome labels. Contiguous windows share boundaries, so
 * MarketsGrid passes `showCountdown` only to the window taking calls.
 */
export function MarketWindowGroupPanel({
  group,
  phase,
  nowMs,
  showCountdown = true,
  venueMarkets,
  venueResolutions,
  onOpenMarket,
}: {
  group: WindowGroup<MarketRow>;
  phase: MarketWindowPhase;
  nowMs: number;
  showCountdown?: boolean;
  venueMarkets: Record<string, WireVenueMarketRow>;
  venueResolutions: Record<string, WireVenueResolutionRow>;
  onOpenMarket?: (marketId: string) => void;
}) {
  const rangeLabel = formatLocalTimeRange(
    group.submissionCloseAtMs,
    group.resolutionAtMs,
  );
  const startFull = formatLocalDateTime(group.submissionCloseAtMs);
  const endFull = formatLocalDateTime(group.resolutionAtMs);
  const target = marketWindowCountdownTargetMs(
    {
      submission_open_at_ms: group.submissionOpenAtMs,
      submission_close_at_ms: group.submissionCloseAtMs,
      resolution_at_ms: group.resolutionAtMs,
    },
    phase,
  );
  const countdownLabel = marketWindowCountdownLabel(phase);
  const hoistedLabels =
    phase === "resolved" ? null : sharedOutcomeLabels(group.items, venueMarkets);
  const phaseText = windowPhaseText(
    phase,
    group.items.every((m) => venueResolutions[m.market_id] !== undefined),
  );

  return (
    <section
      aria-label={`${rangeLabel ?? "window"} — ${phaseText}`}
      className="border-b border-[var(--color-border-vis)]"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1">
        <h3 className="ck-colhead m-0">
          {/* A range needs two <time> stamps. */}
          <time
            dateTime={new Date(group.submissionCloseAtMs).toISOString()}
            title={startFull ?? undefined}
          >
            {formatLocalTimeLabel(group.submissionCloseAtMs) ?? "—"}
          </time>
          <span aria-hidden="true"> – </span>
          <time
            dateTime={new Date(group.resolutionAtMs).toISOString()}
            title={endFull ?? undefined}
          >
            {formatLocalTimeLabel(group.resolutionAtMs) ?? "—"}
          </time>
        </h3>
        {/* No box: the phase is a label. Taking-calls keeps the LED, which the
            ck-badge-live rule draws on its own. */}
        <span
          className={
            "ck-colhead inline-flex items-center " +
            (phase === "open" ? "ck-badge-live" : "")
          }
        >
          {phaseText}
        </span>
        <span className="ml-auto flex items-center gap-3">
          {showCountdown && target !== null && countdownLabel !== null && (
            <span className="flex items-center gap-1.5">
              <span className="ck-label">{sentenceCase(countdownLabel)}</span>
              {/* No aria-live: it ticks every second. MarketsGrid's status region speaks. */}
              <span className="ck-mono tabular-nums ck-pos">
                {formatCountdown(target - nowMs)}
              </span>
            </span>
          )}
          {/* Quote column headers; aria-hidden since each row has an sr-only
              label. Widths match QUOTE_CELL. */}
          {hoistedLabels && (
            <span className="flex items-center gap-2" aria-hidden="true">
              {hoistedLabels.map((label) => (
                <span key={label} className={"ck-label ck-dim " + QUOTE_CELL}>
                  {label}
                </span>
              ))}
            </span>
          )}
        </span>
      </header>

      <ul className="m-0 p-0 list-none">
        {group.items.map((market) => (
          <MarketWindowRow
            key={market.market_id}
            market={market}
            phase={phase}
            venue={venueMarkets[market.market_id]}
            resolution={venueResolutions[market.market_id]}
            labelsInHeader={hoistedLabels !== null}
            onOpenMarket={onOpenMarket}
          />
        ))}
      </ul>
    </section>
  );
}

function MarketWindowRow({
  market,
  phase,
  venue,
  resolution,
  labelsInHeader,
  onOpenMarket,
}: {
  market: MarketRow;
  phase: MarketWindowPhase;
  venue: WireVenueMarketRow | undefined;
  resolution: WireVenueResolutionRow | undefined;
  labelsInHeader: boolean;
  onOpenMarket?: (marketId: string) => void;
}) {
  const cfg = parseMarketConfig(market);
  const symbol = marketAssetSymbol(market);
  const displayName = marketDisplayName(market);

  return (
    <li
      className={
        "border-b border-[var(--color-border)] last:border-b-0 " +
        // A window that has not opened is inert; one ink says so.
        (phase === "upcoming" ? "ck-row-off" : "")
      }
    >
      <a
        href={`#/markets/${encodeURIComponent(market.market_id)}`}
        onClick={(e) => {
          if (
            onOpenMarket &&
            e.button === 0 &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.shiftKey &&
            !e.altKey
          ) {
            e.preventDefault();
            onOpenMarket(market.market_id);
          }
        }}
        className="flex items-center gap-2 min-h-[40px] px-2 py-1 no-underline text-[var(--color-primary)] ck-hoverable"
      >
        <MarketAssetIcon iconUrl={cfg?.icon_url} symbol={symbol} />
        {/* Symbol, else the question; the id only as a last resort. */}
        <span className={"ck-mono " + (symbol ? "flex-none" : "truncate min-w-0")}>
          {symbol ??
            (displayName === market.market_id
              ? shortMarketId(market.market_id)
              : displayName)}
        </span>
        {/* The venue's title, for the accessible name only. */}
        {symbol !== null && <span className="sr-only">{displayName}</span>}
        <span className="ml-auto flex items-center gap-2 min-w-0">
          {phase === "resolved" ? (
            <ResolvedOutcome resolution={resolution} />
          ) : (
            <LiveQuotes venue={venue} phase={phase} labelsInHeader={labelsInHeader} />
          )}
        </span>
      </a>
    </li>
  );
}

/** The settled outcome as glyph and word; colour only reinforces. */
function ResolvedOutcome({
  resolution,
}: {
  resolution: WireVenueResolutionRow | undefined;
}) {
  if (!resolution) {
    // Venue hasn't published (or it left the lookback); don't claim "void".
    return <span className="ck-mono ck-dim">waiting for the venue</span>;
  }
  const winner = resolution.winning_label;
  if (winner === null) {
    return <span className="ck-mono ck-dim">void — no winner</span>;
  }
  const direction = directionGlyph(winner);
  return (
    <span
      className={
        "ck-mono whitespace-nowrap " + (direction === "↓" ? "ck-neg" : "ck-pos")
      }
    >
      {direction && <span aria-hidden="true">{direction} </span>}
      {winner}
    </span>
  );
}

/** Both sides quoted independently; never derive one as 1 − the other. */
function LiveQuotes({
  venue,
  phase,
  labelsInHeader,
}: {
  venue: WireVenueMarketRow | undefined;
  phase: MarketWindowPhase;
  labelsInHeader: boolean;
}) {
  if (!venue || venue.freshness === "warming" || venue.outcomes.length === 0) {
    return (
      <span className="ck-mono ck-dim">
        {phase === "upcoming" ? "not open yet" : "no prices yet"}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 min-w-0">
      {venue.freshness === "stale" && (
        <span className="ck-badge ck-dim" title="these prices have stopped updating">Stale</span>
      )}
      {venue.outcomes.map((outcome) => (
        <span
          key={outcome.token_id}
          className={
            "ck-mono whitespace-nowrap tabular-nums " +
            (labelsInHeader ? QUOTE_CELL : "")
          }
        >
          {/* Label hoisted to the group header: keep it for screen readers,
              which read a row at a time and would otherwise hear bare numbers. */}
          <span className={labelsInHeader ? "sr-only" : "ck-dim"}>{outcome.label} </span>
          {outcome.price === null ? "—" : formatQuotePrice(outcome.price)}
        </span>
      ))}
    </span>
  );
}

/** 0.004 → "0.004", 0.0004 → "<0.001", 0.42 → "0.42"; never rounds to zero. */
function formatQuotePrice(price: number): string {
  if (price <= 0) return "0.00";
  if (price < 0.001) return "<0.001";
  if (price < 0.01) return price.toFixed(3);
  return price.toFixed(2);
}

/** Fixed width so the quote cells form real columns under the header labels.
 *  Six mono characters, the width of the widest quote ("<0.001"). */
const QUOTE_CELL = "w-[58px] text-right";

/** Labels every quoted row shares in the same order, or null (also when <2 rows quote). */
function sharedOutcomeLabels(
  items: MarketRow[],
  venueMarkets: Record<string, WireVenueMarketRow>,
): string[] | null {
  let shared: string[] | null = null;
  let quoted = 0;
  for (const market of items) {
    const venue = venueMarkets[market.market_id];
    if (!venue || venue.freshness === "warming" || venue.outcomes.length === 0) continue;
    const labels = venue.outcomes.map((o) => o.label);
    if (shared === null) shared = labels;
    else if (labels.length !== shared.length || labels.some((l, i) => l !== shared![i])) {
      return null;
    }
    quoted += 1;
  }
  return quoted >= 2 ? shared : null;
}

function directionGlyph(label: string): "↑" | "↓" | null {
  const lower = label.trim().toLowerCase();
  if (lower.startsWith("up") || lower === "yes") return "↑";
  if (lower.startsWith("down") || lower === "no") return "↓";
  return null;
}

function shortMarketId(marketId: string): string {
  return marketId.length > 10 ? `${marketId.slice(0, 8)}…` : marketId;
}

/**
 * The window's state in words. A clock-resolved window reads "waiting for the
 * venue" until every market in it has a venue outcome.
 */
export function windowPhaseText(
  phase: MarketWindowPhase,
  venueConfirmed: boolean,
): string {
  if (phase === "resolved" && !venueConfirmed) return "Waiting for the venue";
  return PHASE_TEXT[phase];
}

export const PHASE_TEXT: Record<MarketWindowPhase, string> = {
  upcoming: "Upcoming",
  open: "Taking calls",
  sealed: "Sealed",
  resolved: "Resolved",
};
