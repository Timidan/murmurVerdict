interface CompactSparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Force red (negative) or white (positive). Defaults to trend-based. */
  forceColor?: "pos" | "neg";
}

/**
 * Inline SVG sparkline — tighter than the default. Hairline 1px stroke,
 * no endpoint marker, trend color from first→last. Renders nothing
 * meaningful for <2 points so callers can keep the slot.
 */
export function CompactSparkline({
  values,
  width = 56,
  height = 14,
  forceColor,
}: CompactSparklineProps) {
  if (values.length < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--color-border-vis)"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = values[values.length - 1];
  const trending = last >= values[0];
  const color =
    forceColor === "pos"
      ? "var(--color-display)"
      : forceColor === "neg"
        ? "var(--color-accent)"
        : trending
          ? "var(--color-display)"
          : "var(--color-accent)";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
