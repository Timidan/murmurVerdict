// ─── live-tape — what the tape shows, decided outside React ────────────────
//
// Pure data → data so it can be checked in node. Two rules:
//
//   ONE ROW PER CALL. The stream emits a call twice, once sealed and once
//   resolved. The resolved event is the later fact and supersedes the sealed
//   one, whatever order they arrived in.
//
//   BOUNDED BY TIME. A count-capped tape backfills until it hits the count,
//   which on a quiet deployment means weeks-old rows under a "realtime"
//   header. The window ends where recency ends; `limit` is only a ceiling
//   inside it so a burst cannot make the panel unbounded either.

export interface TapeEvent {
  type: string;
  call_id: string;
  accepted_at?: string;
  resolved_at?: string;
}

export const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The instant a row is about: when it resolved, else when it was sealed. */
export function eventAt(evt: TapeEvent): number {
  const iso = evt.type === "call.resolved" ? evt.resolved_at : evt.accepted_at;
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export interface TapeRows<E extends TapeEvent> {
  rows: E[];
  /** Calls older than the window. Reported, never silently cut. */
  older: number;
  /** Calls inside the window but past `limit`. Likewise reported. */
  overflow: number;
}

export function tapeRows<E extends TapeEvent>(
  events: readonly E[],
  nowMs: number,
  limit: number,
  windowMs = LIVE_WINDOW_MS,
): TapeRows<E> {
  // Newest-first input, so the first event seen for a call is its latest;
  // resolved still wins over sealed regardless, because it is the later fact.
  const byCall = new Map<string, E>();
  for (const evt of events) {
    const prev = byCall.get(evt.call_id);
    if (!prev || (evt.type === "call.resolved" && prev.type !== "call.resolved")) {
      byCall.set(evt.call_id, evt);
    }
  }
  const calls = [...byCall.values()];
  const cutoff = nowMs - windowMs;
  const recent = calls.filter((evt) => eventAt(evt) >= cutoff);
  const rows = recent.slice(0, Math.max(0, limit));
  return { rows, older: calls.length - recent.length, overflow: recent.length - rows.length };
}
