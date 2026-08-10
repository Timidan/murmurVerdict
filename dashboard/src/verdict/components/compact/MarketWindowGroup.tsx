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
import { MarketAssetIcon } from "./MarketAssetIcon.js";

/**
 * One window: the five assets that share a clock, under one header with one
 * countdown.
 *
 * The header carries everything the rows would otherwise repeat five times —
 * the time range, the phase, the countdown — so a row is free to be just the
 * asset and its state. That is the whole point of grouping: ten rows with ten
 * identical countdowns hide the one number the reader is actually watching.
 */
export function MarketWindowGroupPanel({
  group,
  phase,
  nowMs,
  venueMarkets,
  venueResolutions,
  onOpenMarket,
}: {
  group: WindowGroup<MarketRow>;
  phase: MarketWindowPhase;
  nowMs: number;
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

  return (
    <section
      aria-label={`${rangeLabel ?? "window"} — ${PHASE_TEXT[phase]}`}
      className="border-b border-[var(--color-border-vis)]"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 bg-[var(--color-surface)]">
        <h3 className="ck-mono ck-pos font-bold m-0">
          {/* The window is a RANGE, so it needs two machine-readable stamps;
              <time> takes one. The visible range is the pair of them, each its
              own element, with the full local instant on hover/focus. */}
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
        <span className={"ck-badge " + PHASE_TONE[phase]}>{PHASE_TEXT[phase]}</span>
        {target !== null && countdownLabel !== null && (
          <span className="ml-auto flex items-center gap-1.5">
            <span className="ck-label">{countdownLabel}</span>
            {/* NO aria-live. This number changes every second; announcing it
                would make the panel unusable with a screen reader on. The
                phase-transition status region (MarketsGrid) is what speaks. */}
            <span className="ck-mono tabular-nums ck-pos">
              {formatCountdown(target - nowMs)}
            </span>
          </span>
        )}
      </header>

      <ul className="m-0 p-0 list-none">
        {group.items.map((market) => (
          <MarketWindowRow
            key={market.market_id}
            market={market}
            phase={phase}
            venue={venueMarkets[market.market_id]}
            resolution={venueResolutions[market.market_id]}
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
  onOpenMarket,
}: {
  market: MarketRow;
  phase: MarketWindowPhase;
  venue: WireVenueMarketRow | undefined;
  resolution: WireVenueResolutionRow | undefined;
  onOpenMarket?: (marketId: string) => void;
}) {
  const cfg = parseMarketConfig(market);
  const symbol = marketAssetSymbol(market);
  const displayName = marketDisplayName(market);

  return (
    <li className="border-b border-[var(--color-border)] last:border-b-0">
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
        <span className="ck-mono font-bold flex-none">
          {symbol ?? shortMarketId(market.market_id)}
        </span>
        {/* The venue's own phrasing — including its "ET" window naming — is
            the destination's real title, so it belongs in the accessible name.
            Visually it would repeat the group header five times, so it is
            hidden and the header speaks for the whole group. */}
        <span className="sr-only">{displayName}</span>
        <span className="ml-auto flex items-center gap-2 min-w-0">
          {phase === "resolved" ? (
            <ResolvedOutcome resolution={resolution} />
          ) : (
            <LiveQuotes venue={venue} phase={phase} />
          )}
        </span>
      </a>
    </li>
  );
}

/**
 * The settled outcome.
 *
 * NEVER color alone: the direction is a glyph AND a word. A reader who cannot
 * tell green from red — and a reader on a monochrome or high-contrast theme,
 * which this cockpit supports — gets the same answer as everyone else. The
 * tone class is reinforcement on top, not the signal.
 */
function ResolvedOutcome({
  resolution,
}: {
  resolution: WireVenueResolutionRow | undefined;
}) {
  if (!resolution) {
    // The window is over but the venue has not published (or we have dropped
    // it from the ticker's lookback). Saying nothing is honest; saying "void"
    // would be a claim we cannot make.
    return <span className="ck-mono ck-dim">awaiting venue</span>;
  }
  const winner = resolution.winning_label;
  if (winner === null) {
    return <span className="ck-mono ck-dim">void · no winner</span>;
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

/**
 * Both sides of the book, quoted independently.
 *
 * Never derive one side as 1 − the other: the venue tracks each outcome's own
 * bid/ask, and a wide or one-sided book makes that arithmetic wrong. When the
 * ticker has no book yet the row says so rather than showing a zero.
 */
function LiveQuotes({
  venue,
  phase,
}: {
  venue: WireVenueMarketRow | undefined;
  phase: MarketWindowPhase;
}) {
  if (!venue || venue.freshness === "warming" || venue.outcomes.length === 0) {
    return (
      <span className="ck-mono ck-dim">
        {phase === "upcoming" ? "not open yet" : "awaiting book"}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 min-w-0">
      {venue.freshness === "stale" && (
        <span className="ck-badge ck-dim">stale</span>
      )}
      {venue.outcomes.map((outcome) => (
        <span
          key={outcome.token_id}
          className="ck-mono whitespace-nowrap tabular-nums"
        >
          <span className="ck-dim">{outcome.label} </span>
          {outcome.price === null ? "—" : outcome.price.toFixed(2)}
        </span>
      ))}
    </span>
  );
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

export const PHASE_TEXT: Record<MarketWindowPhase, string> = {
  upcoming: "upcoming",
  open: "calls open",
  sealed: "sealed",
  resolved: "resolved",
};

const PHASE_TONE: Record<MarketWindowPhase, string> = {
  upcoming: "ck-dim",
  open: "ck-pos",
  sealed: "",
  resolved: "ck-dim",
};
