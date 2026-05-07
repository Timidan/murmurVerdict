interface SparklineProps {
  /** Raw values plotted left → right. Missing data → empty render. */
  values: number[];
  /** Width × height in px. Tuned for inline use inside a row. */
  width?: number;
  height?: number;
  /** Hide the trailing endpoint marker (used in micro-rows). */
  hideEnd?: boolean;
}

/**
 * Minimal SVG line — Nothing-canonical: hairline stroke, single accent color
 * for trailing endpoint, no fill, no labels. Renders nothing when there are
 * fewer than 2 points so a placeholder doesn't fake data.
 */
export function Sparkline({ values, width = 80, height = 18, hideEnd = false }: SparklineProps) {
  if (values.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden
        className="opacity-40"
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--color-border-vis)"
          strokeWidth={1}
          strokeDasharray="2 3"
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
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = values[values.length - 1];
  const lastX = (values.length - 1) * stepX;
  const lastY = height - ((last - min) / range) * height;
  const trending = last >= values[0];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke={trending ? "var(--color-display)" : "var(--color-accent)"}
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {!hideEnd && (
        <rect
          x={lastX - 1.5}
          y={lastY - 1.5}
          width={3}
          height={3}
          fill={trending ? "var(--color-display)" : "var(--color-accent)"}
        />
      )}
    </svg>
  );
}
