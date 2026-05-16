// dashboard/src/verdict/components/MMark.tsx
//
// Static SVG of the Murmur Verdict M waveform mark.
// Geometry extracted from murmur-verdict__full-asset-pack__final/01_murmur-verdict__mark__dark.png
// via the script in docs/plans/2026-05-16-paper-mode-and-mark-plan.md Task 2.1.

export interface MMarkProps {
  /** px size (rendered as square). Defaults to 18 (topbar size). */
  size?: number;
  /** Show the red verdict dot. Defaults to true. */
  showDot?: boolean;
  className?: string;
  /** Optional aria-label override. Defaults to "Murmur Verdict". */
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

export function MMark({ size = 18, showDot = true, className, label = "Murmur Verdict" }: MMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={label}
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      {BARS.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill="currentColor" />
      ))}
      {showDot && (
        <rect
          x={DOT.x}
          y={DOT.y}
          width={DOT.size}
          height={DOT.size}
          fill="var(--color-accent)"
        />
      )}
    </svg>
  );
}
