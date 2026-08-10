import type { ArchivedMarketRow as ArchivedMarket } from "../../api.js";
import type { WireVenueResolutionRow } from "@shared/wire-venue";
import { assetSymbolFromSlugOrQuestion } from "../../lib/market-meta.js";
import {
  formatLocalDateTime,
  formatLocalTimeLabel,
} from "../../lib/date-time-format.js";
import { MarketAssetIcon } from "./MarketAssetIcon.js";

/**
 * One archived market, as a link.
 *
 * Shared by the resolved board and the archive search so the two cannot drift:
 * both are lists of finished markets, and a reader who searches for what they
 * just watched settle should recognise the row.
 *
 * `resolution` is optional and usually absent. The venue ticker keeps
 * resolutions for a short lookback after a window ends, so the most recent
 * settlements carry a winner and older ones do not. An absent winner renders
 * as nothing rather than as "void" — we do not know, and saying we do would be
 * a claim about someone's money.
 */
export function ArchivedMarketLinkRow({
  row,
  resolution,
  showEndedTime = true,
}: {
  row: ArchivedMarket;
  resolution?: WireVenueResolutionRow | undefined;
  /** Off inside a grouped list whose header already states the instant. */
  showEndedTime?: boolean;
}) {
  const symbol = assetSymbolFromSlugOrQuestion(row.slug, row.question);
  const label = row.question ?? row.slug ?? row.market_id;
  const endedLabel = formatLocalTimeLabel(row.ended_at);
  const endedFull = formatLocalDateTime(row.ended_at);

  return (
    <li className="border-b border-[var(--color-border)] last:border-b-0">
      <a
        href={`#/markets/${encodeURIComponent(row.market_id)}`}
        className="flex items-center gap-2 min-h-[40px] px-2 py-1 no-underline text-[var(--color-primary)] ck-hoverable"
      >
        <MarketAssetIcon iconUrl={row.icon_url} symbol={symbol} />
        <span className="ck-mono font-bold flex-none">
          {symbol ?? "—"}
        </span>
        <span className="ck-mono ck-dim truncate min-w-0 flex-1">{label}</span>
        {resolution && <WinnerTag resolution={resolution} />}
        {showEndedTime && (
          <time
            dateTime={row.ended_at}
            title={endedFull ?? undefined}
            className="ck-mono ck-dim tabular-nums whitespace-nowrap flex-none"
          >
            {endedLabel ?? row.ended_at}
          </time>
        )}
      </a>
    </li>
  );
}

/**
 * The winner, as glyph AND word. Colour is reinforcement, never the signal —
 * see the same rule in MarketWindowGroup's ResolvedOutcome.
 */
function WinnerTag({ resolution }: { resolution: WireVenueResolutionRow }) {
  const winner = resolution.winning_label;
  if (winner === null) {
    return <span className="ck-mono ck-dim flex-none">void</span>;
  }
  const lower = winner.trim().toLowerCase();
  const glyph = lower.startsWith("up") || lower === "yes"
    ? "↑"
    : lower.startsWith("down") || lower === "no"
      ? "↓"
      : null;
  return (
    <span
      className={
        "ck-mono whitespace-nowrap flex-none " +
        (glyph === "↓" ? "ck-neg" : "ck-pos")
      }
    >
      {glyph && <span aria-hidden="true">{glyph} </span>}
      {winner}
    </span>
  );
}
