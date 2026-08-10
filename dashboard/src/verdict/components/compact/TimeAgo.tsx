import { useSyncExternalStore } from "react";
import { formatRelativeTime } from "../../lib/display-format.js";

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
 */
export function TimeAgo({
  iso,
  className,
}: {
  iso: string | null | undefined;
  className?: string;
}) {
  const now = useNowMs();
  if (!iso) return <span className={className}>—</span>;
  return (
    <span className={className} title={iso}>
      {formatRelativeTime(iso, now)}
    </span>
  );
}
