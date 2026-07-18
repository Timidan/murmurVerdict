// dashboard/src/verdict/components/MMark.tsx
//
// Static SVG of the Murmur Verdict M waveform mark.
// Geometry extracted from murmur-verdict__full-asset-pack__final/01_murmur-verdict__mark__dark.png
// via the script in docs/plans/2026-05-16-paper-mode-and-mark-plan.md Task 2.1.
//
// Note on sub-pixel coordinates: geometry uses 2-decimal viewBox values
// (e.g. 0.27, 11.77). At small render sizes (18px) edges antialias; this
// preserves higher-DPI fidelity at the cost of slight 1× softness.

export interface MMarkProps {
  /** px size (rendered as square). Defaults to 18 (topbar size). */
  size?: number;
  /** Show the red verdict dot. Defaults to true. */
  showDot?: boolean;
  className?: string;
  /**
   * Mark the SVG as decorative (aria-hidden, no role).
   * Use when the parent already owns the accessible name (e.g., a labeled
   * anchor or wrapper). Mutually exclusive with `label`.
   */
  decorative?: boolean;
  /** Optional aria-label override. Ignored if `decorative` is true.
   * Defaults to "Murmur Verdict". */
  label?: string;
}

const BARS: Array<{ x: number; y: number; w: number; h: number }> = [
  { x: 0.27,  y: 0.14,  w: 7.04, h: 99.59 },
  { x: 11.77, y: 20.30, w: 7.17, h: 79.42 },
  { x: 23.14, y: 34.43, w: 7.17, h: 30.04 },
  { x: 34.37, y: 48.01, w: 7.04, h: 30.18 },
  { x: 45.74, y: 48.01, w: 7.04, h: 30.18 },
  { x: 56.83, y: 34.43, w: 7.17, h: 30.04 },
  { x: 68.20, y: 20.30, w: 7.17, h: 79.42 },
  { x: 79.70, y: 0.14,  w: 7.04, h: 99.59 },
];

// Dot rendered as a square (geometric language: discrete, not circular).
// Derived from {cx: 95.94, cy: 95.61, r: 3.92} via cx-r, cy-r, 2r.
const DOT = {
  x: 95.94 - 3.92,
  y: 95.61 - 3.92,
  size: 3.92 * 2,
};

export function MMark({
  size = 18,
  showDot = true,
  className,
  decorative = false,
  label = "Murmur Verdict",
}: MMarkProps) {
  const a11yProps = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img" as const, "aria-label": label });

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      {...a11yProps}
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      {BARS.map((b, i) => (
        // rx = w/2 renders each bar as a capsule — the asset-pack bars have
        // fully rounded ends, not square corners.
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx={b.w / 2}
          fill="currentColor"
        />
      ))}
      {showDot && (
        <rect
          x={DOT.x}
          y={DOT.y}
          width={DOT.size}
          height={DOT.size}
          fill="var(--color-brand-mark)"
        />
      )}
    </svg>
  );
}
