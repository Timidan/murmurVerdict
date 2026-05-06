import { useStream } from "../hooks/useStream.js";
import { text } from "../ui/tokens.js";

interface LiveCounterProps {
  label?: string;
  /** Optional fallback used when the stream hasn't delivered a stats.tick yet. */
  fallback?: number | null;
  /** Which 24h count to show. */
  metric?: "accepted_24h" | "resolved_24h" | "wins_24h";
}

const METRIC_LABEL: Record<NonNullable<LiveCounterProps["metric"]>, string> = {
  accepted_24h: "24h calls accepted",
  resolved_24h: "24h calls resolved",
  wins_24h: "24h wins",
};

/**
 * Hero numeric readout in Doto. Subscribes to the daemon's `stats.tick`
 * events so it reflects the current 24h count without polling.
 *
 * On first render before the SSE handshake completes, falls back to the
 * provided initial value (or `——`) — never shows 0 transiently, which
 * would feel like an error.
 */
export function LiveCounter({
  label,
  fallback = null,
  metric = "resolved_24h",
}: LiveCounterProps) {
  const stream = useStream();
  const value = stream.stats?.[metric] ?? fallback;
  const display =
    value === null || value === undefined ? "——" : value.toString().padStart(2, "0");

  return (
    <div>
      <div className="t-label mb-3">{label ?? METRIC_LABEL[metric]}</div>
      <div className={text.display + " text-[var(--color-display)]"}>{display}</div>
    </div>
  );
}
