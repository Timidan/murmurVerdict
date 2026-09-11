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
/**
 * Split a venue market's question into the series it belongs to and the window
 * it covers: "Ethereum Up or Down - July 19, 8:25PM-8:30PM ET" becomes
 * `{ head: "Ethereum Up or Down", tail: "July 19, 8:25PM" }`.
 *
 * A per-market list for one agent is a list of five-minute WINDOWS, and every
 * one of them opens with the same nineteen characters. Rendered as a single
 * truncating string in a narrow column they all read "Ethereum Up or Do…" —
 * distinguishable from a hex id, but not from each other, which is the same
 * failure one step along. Splitting lets the column truncate the part the rows
 * share and keep the part that tells them apart.
 *
 * Total by construction: a question with no " - " separator (a native price
 * market, or any venue that words its markets differently) comes back whole as
 * `head` with a null `tail`, and the caller renders it exactly as before. The
 * closing time is dropped from the tail because every one of these windows is
 * five minutes long, so the second clock reading carries no information the
 * first does not.
 */
export function splitMarketLabel(label: string): { head: string; tail: string | null } {
  const at = label.indexOf(" - ");
  if (at < 0) return { head: label, tail: null };
  const head = label.slice(0, at).trim();
  const rest = label.slice(at + 3).trim();
  if (head.length === 0 || rest.length === 0) return { head: label, tail: null };
  // "July 19, 8:25PM-8:30PM ET" → "July 19, 8:25PM". The dash here has no
  // spaces around it, which is what keeps it distinct from the separator above.
  const open = /^(.*?\d{1,2}:\d{2}\s?[AaPp]\.?[Mm]\.?)\s*-/.exec(rest);
  return { head, tail: open ? open[1]!.trim() : rest };
}

export function shortId(value: string, lead = 7, tail = 5): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/** Compact single-unit relative time vs `nowMs`, floored (a unit never
 *  promotes early — "59.6s" stays "59s").
 *  Past: "now" (<10s either side), "42s ago", "7m ago", "34h ago" (<48h),
 *  "2d ago" (<14d), "6w ago" (<60d), "7mo ago" (<1y), "2y ago". Future
 *  timestamps mirror as "in 42s" / "in 7m" / …
 *  Always a relative unit: the exact instant lives in the `title` tooltip, and
 *  an absolute fallback ("2026-07-20") only ever clipped to "2026-0…" in the
 *  narrow columns this feeds.
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
  else if (s < 14 * 86400) unit = `${Math.floor(s / 86400)}d`;
  else if (s < 60 * 86400) unit = `${Math.floor(s / (7 * 86400))}w`;
  else if (s < 365 * 86400) unit = `${Math.floor(s / (30 * 86400))}mo`;
  else unit = `${Math.floor(s / (365 * 86400))}y`;
  return diff >= 0 ? `${unit} ago` : `in ${unit}`;
}
