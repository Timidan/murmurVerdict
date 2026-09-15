// Static SVG of the Murmur Verdict M waveform mark, traced from the brand asset.

export interface MMarkProps {
  /** px size (rendered as square). */
  size?: number;
  showDot?: boolean;
  className?: string;
  /** aria-hidden, no role; use when the parent owns the accessible name. */
  decorative?: boolean;
  /** Ignored if `decorative` is true. */
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

// Dot drawn as a square from the traced circle {cx: 95.94, cy: 95.61, r: 3.92}.
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
        // rx = w/2 makes each bar a capsule.
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
