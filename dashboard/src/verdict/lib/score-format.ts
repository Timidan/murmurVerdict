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

export function formatScore(
  value: number | null | undefined,
  opts?: FormatScoreOptions,
): string {
  if (value === null || value === undefined) return "—";
  const decimals = opts?.decimals ?? 3;
  const sign = value >= 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toFixed(decimals)}`;
}
