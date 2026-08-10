// ─── display-format — compact hash + relative-time rendering ────────────────
//
// One rule for every long identifier and timestamp in the cockpit:
//   · ids/hashes middle-truncate (`0x1c014…05769`) with the FULL value in a
//     `title` tooltip at the render site — links and copy targets keep the
//     full string, only the glyphs on screen shrink.
//   · timestamps render relative ("7m ago") and carry the full ISO in
//     `title`. Rendering lives in <TimeAgo/> (components/compact/TimeAgo.tsx)
//     so every instance re-renders off one shared 30s ticker.

/** Middle-truncate a long id / hash / address: `0x1c0148…05769`.
 *  Values short enough to show whole are returned untouched. */
export function shortId(value: string, lead = 7, tail = 5): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/** Compact single-unit relative time vs `nowMs`, floored (a unit never
 *  promotes early — "59.6s" stays "59s").
 *  Past: "now" (<10s either side), "42s ago", "7m ago", "34h ago" (<48h),
 *  "2d ago" (<14d), then the plain date ("2026-07-20"). Future timestamps
 *  mirror as "in 42s" / "in 7m" / …; beyond 14d ahead, the plain date.
 *  Invalid input → "—". */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = nowMs - t;
  const abs = Math.abs(diff);
  const s = Math.floor(abs / 1000);
  // <10s either side reads as "now" — a thing 5s in the future is not worth
  // an "in <10s" label. floor (not round) so a unit never promotes early
  // ("59.6s" stays 59s, never "60s"/premature "1m").
  if (s < 10) return "now";
  let unit: string;
  if (s < 60) unit = `${s}s`;
  else if (s < 60 * 60) unit = `${Math.floor(s / 60)}m`;
  else if (s < 48 * 60 * 60) unit = `${Math.floor(s / 3600)}h`;
  else if (s < 14 * 24 * 60 * 60) unit = `${Math.floor(s / 86400)}d`;
  else return iso.slice(0, 10);
  return diff >= 0 ? `${unit} ago` : `in ${unit}`;
}
