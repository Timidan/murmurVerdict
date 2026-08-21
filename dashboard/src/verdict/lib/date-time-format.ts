/**
 * Local time rendering for the markets matrix.
 *
 * Every instant murmur publishes is UTC. Every person reading the matrix is
 * not. The venue names its own windows in ET ("Bitcoin Up or Down - August 10,
 * 1:35AM-1:40AM ET"), which is the venue's label for its product — NOT a
 * timezone anyone else should have to convert out of in their head. So the
 * matrix renders times in the viewer's own zone and locale, and the venue's ET
 * phrasing survives only as secondary text where it is quoting the venue.
 *
 * Two rules this module exists to enforce:
 *
 *   1. NO forced `hour12`. Whether 13:30 reads as "1:30 PM" or "13:30" is a
 *      locale decision, and hardcoding either is how an app tells half its
 *      readers it was not built for them. `Intl` already knows; let it answer.
 *
 *   2. Formatters are CACHED. `new Intl.DateTimeFormat(...)` is one of the more
 *      expensive constructors in the platform (it resolves locale data on every
 *      call). The matrix formats a label per market per render and a countdown
 *      every second, so constructing per call is a measurable cost for a value
 *      that never varies. Keyed by the resolved locale so a runtime locale
 *      change still produces a fresh formatter.
 */

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * `undefined` means "the runtime's own preference", which is what we want.
 * Read once per call rather than cached, so the key reflects reality if the
 * page outlives a locale change.
 */
function localeKey(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "default";
  }
}

function timeFormatter(): Intl.DateTimeFormat {
  const key = localeKey();
  let cached = timeFormatters.get(key);
  if (!cached) {
    // No `hour12` — see rule 1. No timeZone either: omitting it means the
    // viewer's own zone, which is the whole point.
    cached = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    timeFormatters.set(key, cached);
  }
  return cached;
}

function dateTimeFormatter(): Intl.DateTimeFormat {
  const key = localeKey();
  let cached = dateTimeFormatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "long",
    });
    dateTimeFormatters.set(key, cached);
  }
  return cached;
}

function toDate(iso: string | number | null | undefined): Date | null {
  if (iso === null || iso === undefined) return null;
  const date = typeof iso === "number" ? new Date(iso) : new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Short local clock label — "1:25 AM", "01:25". The matrix's window headers and
 * row times use this; it is deliberately time-only, because a group header
 * already says which day it belongs to.
 *
 * Returns null (never a fabricated "—" or the raw string) on an unparseable
 * input, so the caller decides what an absent time looks like.
 */
export function formatLocalTimeLabel(
  iso: string | number | null | undefined,
): string | null {
  const date = toDate(iso);
  if (date === null) return null;
  return timeFormatter().format(date);
}

/**
 * The full local instant, with a named zone — "Aug 10, 2026, 1:25:00 AM GMT+1".
 *
 * This is the TITLE half of every time in the matrix: the visible text is the
 * short label, the tooltip is this. A reader who needs to know exactly when a
 * window closed (and in which zone the page is speaking) gets it on hover and
 * on focus without the layout carrying a 30-character string per row.
 */
export function formatLocalDateTime(
  iso: string | number | null | undefined,
): string | null {
  const date = toDate(iso);
  if (date === null) return null;
  return dateTimeFormatter().format(date);
}

/**
 * A window as one label: "1:25 – 1:30 AM".
 *
 * Collapses the shared meridiem/suffix when both ends carry the same trailing
 * token, which is the common case for a five-minute window and reads far
 * better than "1:25 AM – 1:30 AM". Purely a string operation on what `Intl`
 * produced, so it degrades to the full "a – b" form in any locale whose format
 * does not end in a shared token.
 */
export function formatLocalTimeRange(
  startIso: string | number | null | undefined,
  endIso: string | number | null | undefined,
): string | null {
  const start = formatLocalTimeLabel(startIso);
  const end = formatLocalTimeLabel(endIso);
  if (start === null || end === null) return start ?? end;
  const startParts = start.split(" ");
  const endParts = end.split(" ");
  if (
    startParts.length > 1 &&
    endParts.length > 1 &&
    startParts[startParts.length - 1] === endParts[endParts.length - 1]
  ) {
    return `${startParts.slice(0, -1).join(" ")} – ${end}`;
  }
  return `${start} – ${end}`;
}

/**
 * A countdown, as a fixed-width clock: "04:31", "1:02:07".
 *
 * Fixed width matters more than it looks — this string is re-rendered once a
 * second under `tabular-nums`, and a label that changes width every tick makes
 * the row beside it twitch. Never negative: a passed deadline is "00:00", and
 * the phase machine (not the formatter) decides what to say about it.
 */
export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Spoken form of a countdown, for the one place a screen reader needs it: the
 * phase-transition announcement. "4 minutes 31 seconds" rather than "04:31",
 * which most screen readers voice as a date or a pair of bare numbers.
 */
export function describeCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (hours === 0 && seconds > 0) {
    parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" ") : "0 seconds";
}

/* ── Local calendar days ─────────────────────────────────────────────────────
   A history grouped by day has to group by the READER's day. Grouping on the
   ISO string's first ten characters groups by UTC, which puts a 7pm call in
   New York on tomorrow's pile — the same bug rule 1 above exists to prevent,
   one level up. The formatter cache lives beside its two siblings for the
   reason stated at the top of this file. */

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(): Intl.DateTimeFormat {
  const key = localeKey();
  let cached = dayFormatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    });
    dayFormatters.set(key, cached);
  }
  return cached;
}

/**
 * The viewer's own calendar day for an instant, as a sortable key —
 * "2026-07-20". Local by construction: `getFullYear`/`getMonth`/`getDate` read
 * the runtime's zone, the same zone every label in this module speaks.
 *
 * Returns null on an unparseable input, so a caller decides what an undated
 * row looks like instead of inheriting a fabricated day.
 */
export function localDayKey(
  iso: string | number | null | undefined,
): string | null {
  const date = toDate(iso);
  if (date === null) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Short local day label — "jul 20". Lowercased into the cockpit's chrome voice;
 * `Intl` still picks the month name and the word order, so a reader in another
 * locale gets their own form rather than an English one.
 */
export function formatLocalDayLabel(
  iso: string | number | null | undefined,
): string | null {
  const date = toDate(iso);
  if (date === null) return null;
  return dayFormatter().format(date).toLowerCase();
}
