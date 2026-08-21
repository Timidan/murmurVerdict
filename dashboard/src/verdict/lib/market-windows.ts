/**
 * Window grouping and the phase machine for the markets matrix.
 *
 * Murmur's venue markets do not arrive one at a time. Five assets — BTC, ETH,
 * SOL, XRP, DOGE — share one five-minute window, resolve together, and are
 * replaced by the next five. Rendering them as ten independent rows with ten
 * identical countdowns says the opposite of what is true, and costs the reader
 * the one fact that organizes the whole screen: which window is running.
 *
 * So the matrix groups by the CLOCK, and each group carries one countdown.
 *
 * Everything here is pure — no React, no DOM, no `Date.now()` (the caller
 * passes `nowMs`). That is what lets the smoke drive every phase boundary
 * deterministically instead of sleeping through a real window.
 */

/** The instants a group is grouped and phased by. */
export interface MarketWindowClock {
  submission_open_at_ms: number;
  submission_close_at_ms: number;
  resolution_at_ms: number;
}

/**
 * `upcoming` — the window exists but is not taking submissions yet.
 * `open`     — agents may submit. Counts down to submission close.
 * `sealed`   — submissions are shut and the venue's price window is running.
 *              Counts down to the venue's resolution instant.
 * `resolved` — the venue determined the outcome (or the instant has passed).
 */
export type MarketWindowPhase = "upcoming" | "open" | "sealed" | "resolved";

export interface MarketWindowGroup<T> {
  /** Stable across renders and ticks: the two instants that define the window. */
  key: string;
  submissionOpenAtMs: number;
  submissionCloseAtMs: number;
  resolutionAtMs: number;
  items: T[];
}

/**
 * Phase for one window.
 *
 * `venueResolved` wins over the clock in one direction only — it can pull a
 * window to `resolved` EARLY, never hold it open late. The venue is the
 * authority on its own outcome, so a resolution that lands a second before our
 * copy of the schedule says it should is the truth; but a resolution that has
 * not arrived yet is not a reason to keep claiming a window is still running
 * after its instant has passed. (A venue that is slow to publish leaves the
 * group in `resolved` with no winner shown, which is honest: it is over, and
 * we do not know the outcome yet.)
 */
export function marketWindowPhase(
  clock: MarketWindowClock,
  nowMs: number,
  venueResolved: boolean,
): MarketWindowPhase {
  if (venueResolved) return "resolved";
  if (nowMs >= clock.resolution_at_ms) return "resolved";
  if (nowMs >= clock.submission_close_at_ms) return "sealed";
  if (nowMs >= clock.submission_open_at_ms) return "open";
  return "upcoming";
}

/**
 * The instant this phase is counting down TO, or null when nothing is pending.
 * One target per phase, so a group renders exactly one countdown.
 */
export function marketWindowCountdownTargetMs(
  clock: MarketWindowClock,
  phase: MarketWindowPhase,
): number | null {
  switch (phase) {
    case "upcoming":
      return clock.submission_open_at_ms;
    case "open":
      return clock.submission_close_at_ms;
    case "sealed":
      return clock.resolution_at_ms;
    case "resolved":
      return null;
  }
}

/**
 * Which stacked window should own the one ticking clock, by `key`.
 *
 * Contiguous windows share their boundaries — this window's resolution is the
 * next one's close and the one after's open — so every panel in the stack
 * counts down to the SAME instant and renders the same number. Three identical
 * clocks read as a bug and bury the one deadline that matters.
 *
 * It goes to the window taking calls, because closing submissions is the only
 * boundary a reader can still act on. With none open (the whole stack upcoming
 * or resolved) it falls to the soonest boundary. Every other window's instants
 * stay legible in its own printed range.
 */
export function countdownOwnerKey<T>(
  groups: ReadonlyArray<MarketWindowGroup<T>>,
  phaseOf: (group: MarketWindowGroup<T>) => MarketWindowPhase,
): string | null {
  let soonestKey: string | null = null;
  let soonestTarget = Infinity;
  for (const group of groups) {
    const phase = phaseOf(group);
    if (phase === "open") return group.key;
    const target = marketWindowCountdownTargetMs(
      {
        submission_open_at_ms: group.submissionOpenAtMs,
        submission_close_at_ms: group.submissionCloseAtMs,
        resolution_at_ms: group.resolutionAtMs,
      },
      phase,
    );
    if (target !== null && target < soonestTarget) {
      soonestTarget = target;
      soonestKey = group.key;
    }
  }
  return soonestKey;
}

/** What the countdown is measuring, in words. Pairs with the phase chip. */
export function marketWindowCountdownLabel(phase: MarketWindowPhase): string | null {
  switch (phase) {
    case "upcoming":
      return "opens in";
    case "open":
      return "calls close in";
    case "sealed":
      return "resolves in";
    case "resolved":
      return null;
  }
}

/**
 * The key covers ALL THREE instants the phase machine reads — open, close, and
 * resolution — not just the last two.
 *
 * `marketWindowPhase` branches on `submission_open_at_ms` for the
 * upcoming→open boundary, so two series that share a close and a resolution but
 * open at different moments are genuinely different windows. Keying on two of
 * the three folded them into one group whose header then stated ONE opening
 * time for markets that do not share it — the group's own phase chip and
 * countdown would be right for half its members and wrong for the rest.
 */
export function windowGroupKey(clock: MarketWindowClock): string {
  return `${clock.submission_open_at_ms}:${clock.submission_close_at_ms}:${clock.resolution_at_ms}`;
}

/**
 * Group items that share a window.
 *
 * Two markets are in the same window when their submission OPEN, submission
 * close, AND resolution instants all match — not merely their end time. Two
 * series with different lead times could land on one resolution instant while
 * taking calls at different moments, and folding those together would put one
 * countdown on two different deadlines.
 *
 * `order: "soonest"` (the live board) puts the window closest to resolving
 * first: the sealed one that is about to settle, then the one taking calls,
 * then what is coming. `order: "newest"` (the resolved board) is the reverse —
 * most recently settled first.
 *
 * Items with no clock are NOT dropped; they come back in `unscheduled` so the
 * caller can decide, because a market with no schedule is a real state (it was
 * registered without a series) and silently hiding it would make the matrix
 * disagree with the registry.
 */
export function groupMarketsByWindow<T>(
  items: readonly T[],
  clockOf: (item: T) => MarketWindowClock | null | undefined,
  order: "soonest" | "newest" = "soonest",
): { groups: Array<MarketWindowGroup<T>>; unscheduled: T[] } {
  const byKey = new Map<string, MarketWindowGroup<T>>();
  const unscheduled: T[] = [];

  for (const item of items) {
    const clock = clockOf(item);
    if (!clock) {
      unscheduled.push(item);
      continue;
    }
    const key = windowGroupKey(clock);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        submissionOpenAtMs: clock.submission_open_at_ms,
        submissionCloseAtMs: clock.submission_close_at_ms,
        resolutionAtMs: clock.resolution_at_ms,
        items: [],
      };
      byKey.set(key, group);
    }
    group.items.push(item);
  }

  const groups = [...byKey.values()].sort((a, b) =>
    order === "soonest"
      ? a.resolutionAtMs - b.resolutionAtMs
      : b.resolutionAtMs - a.resolutionAtMs,
  );
  return { groups, unscheduled };
}

/**
 * Local-day epoch-SECOND bounds for a `<input type="date">` value ("2026-08-10").
 *
 * The user picked a day on a calendar, in their own timezone, so "August 10"
 * has to mean midnight-to-midnight where THEY are — not UTC. `new Date(y, m, d)`
 * constructs in local time, which is exactly the conversion wanted; parsing the
 * string with `Date.parse` would instead read it as UTC and shift the whole day
 * for most of the world.
 *
 * Returns null on anything that is not a `YYYY-MM-DD` calendar date.
 */
export function localDayEpochBounds(
  value: string,
): { fromEpochS: number; toEpochS: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  // Round-trip check: a date like 2026-02-31 rolls over silently otherwise.
  if (
    start.getFullYear() !== year ||
    start.getMonth() !== month - 1 ||
    start.getDate() !== day
  ) {
    return null;
  }
  const end = new Date(year, month - 1, day, 23, 59, 59, 999);
  return {
    fromEpochS: Math.floor(start.getTime() / 1000),
    toEpochS: Math.floor(end.getTime() / 1000),
  };
}

/** Epoch seconds at the start of the viewer's current local day. */
export function startOfLocalDayEpochS(nowMs: number): number {
  const now = new Date(nowMs);
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  return Math.floor(start.getTime() / 1000);
}
