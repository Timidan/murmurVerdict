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
    // refresh on (re)start so the first subscriber after idle isn't stale
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
 * Relative timestamp ("7m ago") with the ISO instant in its tooltip; null → "—".
 * `absolute` shows the local instant instead, for columns where order matters.
 */
export function TimeAgo({
  iso,
  className,
  absolute = false,
  compact = false,
}: {
  iso: string | null | undefined;
  className?: string;
  absolute?: boolean;
  /** Drop the trailing "ago" for narrow value columns ("19h"). */
  compact?: boolean;
}) {
  const now = useNowMs();
  if (!iso) return <span className={className}>—</span>;
  const relative = formatRelativeTime(iso, now);
  if (absolute) {
    // Short form for value columns; falls back to relative if unparseable.
    const stamp = formatLocalDateTimeShort(iso);
    return (
      <span className={className} title={`${relative} · ${iso}`}>
        {stamp ?? relative}
      </span>
    );
  }
  return (
    <span className={className} title={compact ? `${relative} · ${iso}` : iso}>
      {compact ? relative.replace(/ ago$/, "") : relative}
    </span>
  );
}
