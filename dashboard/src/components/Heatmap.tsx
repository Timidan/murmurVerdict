import type { ScoredAsset } from "../types";

interface HeatmapProps {
  scoredAssets: ScoredAsset[];
}

const ASSET_DISPLAY: Record<string, string> = {
  ethereum: "ETH",
  "wrapped-bitcoin": "cbBTC",
  aave: "AAVE",
  uniswap: "UNI",
  chainlink: "LINK",
  "aerodrome-finance": "AERO",
  "virtual-protocol": "VRTL",
};

const METRICS = [
  { key: "social_dominance_total", label: "SOC DOM" },
  { key: "sentiment_weighted_total", label: "SENT" },
  { key: "exchange_inflow_usd", label: "INFLOW" },
  { key: "exchange_outflow_usd", label: "OUTFLOW" },
  { key: "age_consumed", label: "AGE" },
  { key: "daily_active_addresses", label: "ADDR" },
  { key: "network_growth", label: "GROWTH" },
  { key: "mvrv_usd", label: "MVRV" },
  { key: "whale_transaction_count_100k_usd_to_inf", label: "WHALE" },
] as const;

function heatClass(z: number | undefined): string {
  if (z === undefined) return "heat-neutral";
  if (z > 0.5) return "heat-high";
  if (z > 0.2) return "heat-mid";
  if (z < -0.2) return "heat-low";
  return "heat-neutral";
}

function compHeatClass(score: number): string {
  if (score > 0.5) return "heat-comp-high";
  if (score > 0.2) return "heat-comp-mid";
  if (score < -0.2) return "heat-comp-low";
  return "heat-comp-neutral";
}

/** Get the bar color for a heat class */
function heatBarColor(z: number | undefined): string {
  if (z === undefined) return "#3f3f46";
  if (z > 0.5) return "#22c55e";
  if (z > 0.2) return "#f59e0b";
  if (z < -0.2) return "#ef4444";
  return "#3f3f46";
}

function compBarColor(score: number): string {
  if (score > 0.5) return "#22c55e";
  if (score > 0.2) return "#f59e0b";
  if (score < -0.2) return "#ef4444";
  return "#71717a";
}

/** Tiny inline SVG bar proportional to absolute value */
function MiniBar({ value, color, maxHeight = 14 }: { value: number; color: string; maxHeight?: number }) {
  const absVal = Math.min(Math.abs(value), 2); // clamp at 2
  const barHeight = Math.max(2, (absVal / 2) * maxHeight);

  return (
    <svg width="4" height={maxHeight} style={{ flexShrink: 0 }}>
      <rect
        x="0"
        y={maxHeight - barHeight}
        width="4"
        height={barHeight}
        fill={color}
        opacity="0.7"
      />
    </svg>
  );
}

export function Heatmap({ scoredAssets }: HeatmapProps) {
  // Filter out weth to avoid duplicate with ethereum
  const assets = scoredAssets.filter((a) => a.slug !== "weth");

  return (
    <div className="panel">
      <div className="panel-title">SIGNAL HEATMAP &mdash; COMPOSITE SCORES</div>
      <div
        className="heatmap-grid"
        style={{ gridTemplateColumns: `60px repeat(${METRICS.length}, 1fr) 50px` }}
      >
        {/* Header row */}
        <div className="heatmap-header" />
        {METRICS.map((m) => (
          <div className="heatmap-header" key={m.key}>
            {m.label}
          </div>
        ))}
        <div className="heatmap-header">COMP</div>

        {/* Asset rows */}
        {assets.map((asset) => (
          <AssetRow key={asset.slug} asset={asset} />
        ))}
      </div>
    </div>
  );
}

function AssetRow({ asset }: { asset: ScoredAsset }) {
  const metrics = asset.normalizedSignals.metrics;

  return (
    <>
      <div className="heatmap-asset">
        {ASSET_DISPLAY[asset.slug] ?? asset.slug}
      </div>
      {METRICS.map((m) => {
        const metricData = metrics[m.key as keyof typeof metrics];
        const z = metricData?.zScore;
        return (
          <div className={`heatmap-cell ${heatClass(z)}`} key={m.key}>
            <MiniBar value={z ?? 0} color={heatBarColor(z)} />
            <span>{z !== undefined ? z.toFixed(1) : "\u2014"}</span>
          </div>
        );
      })}
      <div className={`heatmap-cell ${compHeatClass(asset.compositeScore)}`}>
        <MiniBar value={asset.compositeScore} color={compBarColor(asset.compositeScore)} />
        <span>{asset.compositeScore.toFixed(2)}</span>
      </div>
    </>
  );
}
