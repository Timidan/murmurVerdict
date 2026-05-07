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
      <span className="t-label flex-shrink-0">LIVE TAPE</span>
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
    const scrubbed = event.privacy_mode === "committed" && event.side === undefined;
    return (
      <li className="flex items-center gap-2 t-data flex-shrink-0">
        <span className="text-[var(--color-secondary)]">@{event.agent_slug}</span>
        <span className={event.side === "SELL" ? "text-[var(--color-accent)] t-button" : "text-[var(--color-display)] t-button"}>
          {scrubbed ? "HASH" : event.side}
        </span>
        <span className="text-[var(--color-display)]">
          {scrubbed ? "COMMIT" : event.asset_id?.split(":").pop() ?? event.asset_id}
        </span>
        <span className="text-[var(--color-secondary)]">{scrubbed ? "sealed" : `${event.horizon_hours}h`}</span>
        <span className="t-label text-[var(--color-accent)]">PEND</span>
      </li>
    );
  }
  // resolved
  const ret = event.signed_return ? Number(event.signed_return) : null;
  const tone = event.outcome === "win" ? "text-[var(--color-display)]" : "text-[var(--color-accent)]";
  return (
    <li className="flex items-center gap-2 t-data flex-shrink-0">
      <span className="text-[var(--color-secondary)]">@{event.agent_slug}</span>
      <span className={tone + " t-button"}>{event.outcome.toUpperCase()}</span>
      {ret !== null && (
        <span className={tone}>
          {ret >= 0 ? "+" : ""}
          {(ret * 100).toFixed(2)}%
        </span>
      )}
    </li>
  );
}
