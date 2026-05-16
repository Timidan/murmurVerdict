import { useStream, type CallAcceptedEvent, type CallResolvedEvent } from "../hooks/useStream.js";

/**
 * Horizontal tape of recent calls — Bloomberg-style ticker without the
 * marquee. New events render at the right and rest of the tape shifts
 * via CSS only. No scroll-jacking, no parallax.
 *
 * Each entry: agent · side · asset · horizon · outcome.
 * SELL is in accent red so the eye reads direction at a glance.
 */
export function LiveTape() {
  const stream = useStream();
  const items = stream.recentCalls.slice(0, 8);

  if (items.length === 0) {
    return (
      <div className="px-6 py-4 t-meta text-[var(--color-disabled)]">
        live tape · waiting for the next call …
      </div>
    );
  }

  return (
    <div className="px-6 py-4 flex items-center gap-3 overflow-x-auto">
      <span className="t-label flex-shrink-0">live tape</span>
      <span className="t-meta text-[var(--color-border-vis)]">·</span>
      <ol className="m-0 p-0 list-none flex items-center gap-6 flex-nowrap">
        {items.map((item) => (
          <TapeEntry key={item.call_id} event={item} />
        ))}
      </ol>
    </div>
  );
}

function TapeEntry({ event }: { event: CallAcceptedEvent | CallResolvedEvent }) {
  if (event.type === "call.accepted") {
    // Pending Fhenix-sealed verdicts are not public; the tape renders
    // blind placards until the post-horizon reveal.
    return (
      <li className="flex items-center gap-2 t-data flex-shrink-0">
        <span className="text-[var(--color-secondary)]">@{event.agent_slug}</span>
        <span className="text-[var(--color-secondary)] t-button">hash</span>
        <span className="text-[var(--color-display)]">blind</span>
        <span className="text-[var(--color-secondary)]">sealed</span>
        <span className="t-label text-[var(--color-accent)]">pend</span>
      </li>
    );
  }
  // resolved
  const ret = event.signed_return ? Number(event.signed_return) : null;
  const tone = event.outcome === "win" ? "text-[var(--color-display)]" : "text-[var(--color-accent)]";
  return (
    <li className="flex items-center gap-2 t-data flex-shrink-0">
      <span className="text-[var(--color-secondary)]">@{event.agent_slug}</span>
      <span className={tone + " t-button"}>{event.outcome}</span>
      {ret !== null && (
        <span className={tone}>
          {ret >= 0 ? "+" : ""}
          {(ret * 100).toFixed(2)}%
        </span>
      )}
    </li>
  );
}
