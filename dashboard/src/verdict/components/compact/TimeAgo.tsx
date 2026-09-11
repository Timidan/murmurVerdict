import { useSyncExternalStore } from "react";
import { formatRelativeTime } from "../../lib/display-format.js";
import { formatLocalDateTimeShort } from "../../lib/date-time-format.js";

// ─── shared 30s clock ───────────────────────────────────────────────────────
// One module-level ticker drives every <TimeAgo/> on screen; the interval
// starts with the first subscriber and stops with the last, so idle pages
// carry no timer at all.

const listeners = new Set<() => void>();
let nowMs = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (timer === null) {
    // refresh the snapshot on ticker (re)start — otherwise the first subscriber after an idle stretch reads a stale clock until the first tick
    nowMs = Date.now();
    timer = setInterval(() => {
      nowMs = Date.now();
      for (const l of listeners) l();
    }, 30_000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getNow(): number {
  return nowMs;
}

/** Shared 30s-resolution clock for relative-time rendering. */
export function useNowMs(): number {
  return useSyncExternalStore(subscribe, getNow, getNow);
}

/**
 * Relative timestamp ("7m ago") that stays fresh off the shared ticker and
 * carries the exact ISO instant in its tooltip. `null`/`undefined` → "—".
 *
 * `absolute` swaps the visible text for the full local instant and keeps the
 * relative form in the tooltip. Use it wherever several timestamps sit in one
 * column and the reader's question is "in what order, how far apart" rather
 * than "how long ago" — a call's lifecycle being the case this exists for.
 * Relative time compresses hard: seven rows of a call's history all rendered
 * "8d ago", which reads as one instant repeated seven times rather than as a
 * sequence anyone can audit.
 */
export function TimeAgo({
  iso,
  className,
  absolute = false,
}: {
  iso: string | null | undefined;
  className?: string;
  absolute?: boolean;
}) {
  const now = useNowMs();
  if (!iso) return <span className={className}>—</span>;
  const relative = formatRelativeTime(iso, now);
  if (absolute) {
    // Falls back to the relative form if the instant will not parse, so a bad
    // timestamp costs precision, never the row.
    // Short form, not the full one: this renders INSIDE a value column, and
    // the exact instant is already on the tooltip below.
    const stamp = formatLocalDateTimeShort(iso);
    return (
      <span className={className} title={`${relative} · ${iso}`}>
        {stamp ?? relative}
      </span>
    );
  }
  return (
    <span className={className} title={iso}>
      {relative}
    </span>
  );
}
