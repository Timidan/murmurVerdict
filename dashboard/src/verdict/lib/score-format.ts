// Shared score formatter for every COMPACT surface.
//
// Scores (verdict_score, verdict_score_lb, call_score, general_score …) are
// small signed reals in roughly [-0.75, 0.25]. Before this helper the same
// value rendered three incompatible ways across the app — signed 3-decimal in
// the live tape, a ×1000 integer on the ladder, unsigned 4-decimal on the call
// page — so the same number read as "+0.123", "+123" and "0.1230". This is the
// single canonical encoding: an explicit sign (+ / − with a real U+2212 minus)
// followed by the absolute value at a fixed decimal count (default 3, matching
// the live tape). null / undefined render as an em-dash placeholder.

interface FormatScoreOptions {
  /** Fixed decimal places. Default 3 (the live-tape encoding). */
  decimals?: number;
}

/**
 * U+2007 FIGURE SPACE — a blank the width of a digit, held in the sign slot so
 * a zero still lines up under the signed values above and below it in a
 * right-aligned column. A plain space would be collapsed away by HTML at the
 * start of an inline box; this one is not, and in Space Mono every glyph is
 * one cell wide regardless.
 */
const SIGN_BLANK = "\u2007";

export function formatScore(
  value: number | null | undefined,
  opts?: FormatScoreOptions,
): string {
  if (value === null || value === undefined) return "—";
  const decimals = opts?.decimals ?? 3;
  const rounded = Number(value.toFixed(decimals));
  // Zero is neither. It used to take the `+` branch, so every zero-scored
  // LOSS in the call log read "+0.000" in loss red — a plus sign on the page's
  // own word for "wrong". Rounding first means a value that only displays as
  // zero (1e-5 at three decimals) is treated as the zero it will render as.
  const sign = rounded === 0 ? SIGN_BLANK : rounded > 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toFixed(decimals)}`;
}
