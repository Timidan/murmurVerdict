interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  filled?: boolean;
}

export function Sparkline({
  data,
  width = 40,
  height = 16,
  color,
  filled = false,
}: SparklineProps) {
  if (data.length < 2) return null;

  const resolvedColor =
    color ?? (data[data.length - 1] >= data[0] ? "#22c55e" : "#ef4444");

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const padding = 1;
  const plotW = width - padding * 2;
  const plotH = height - padding * 2;

  const points = data
    .map((v, i) => {
      const x = padding + (i / (data.length - 1)) * plotW;
      const y = padding + plotH - ((v - min) / range) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const gradientId = `spark-grad-${Math.random().toString(36).slice(2, 8)}`;

  // Build fill polygon: line points + bottom-right + bottom-left
  const fillPoints = filled
    ? `${points} ${(padding + plotW).toFixed(1)},${(padding + plotH).toFixed(1)} ${padding.toFixed(1)},${(padding + plotH).toFixed(1)}`
    : "";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block", flexShrink: 0 }}
    >
      {filled && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={resolvedColor} stopOpacity="0.3" />
            <stop offset="100%" stopColor={resolvedColor} stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {filled && (
        <polygon
          points={fillPoints}
          fill={`url(#${gradientId})`}
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={resolvedColor}
        strokeWidth="1"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
