import type { ScoredAsset } from "../types";

interface HeatmapProps {
  scoredAssets: ScoredAsset[];
}

const ASSET_DISPLAY: Record<string, string> = {
  ethereum: "ETH",
  weth: "WETH",
  "wrapped-bitcoin": "cbBTC",
  aave: "AAVE",
  uniswap: "UNI",
  chainlink: "LINK",
  "aerodrome-finance": "AERO",
  "virtual-protocol": "VRTL",
};

const PLAYBOOK_SHORT: Record<string, string> = {
  early_narrative_breakout: "BREAKOUT",
  euphoria_fade: "EUPHORIA",
  capitulation_rebound: "CAPITULATION",
};

function compositeColor(score: number): string {
  if (score > 0.3) return "#22c55e";
  if (score > 0.1) return "#f59e0b";
  if (score < -0.1) return "#ef4444";
  return "#71717a";
}

export function Heatmap({ scoredAssets }: HeatmapProps) {
  // Filter out weth to avoid duplicate with ethereum, already sorted by compositeScore descending
  const assets = scoredAssets.filter((a) => a.slug !== "weth");

  return (
    <div className="panel">
      <div className="panel-title">Ranked Universe</div>
      <table className="term-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Asset</th>
            <th>Composite</th>
            <th>Playbook</th>
            <th>Key Signals</th>
            <th>Candidate</th>
          </tr>
        </thead>
        <tbody>
          {assets.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ color: "#3f3f46", textAlign: "center", padding: "20px 0" }}>
                No data
              </td>
            </tr>
          ) : (
            assets.map((asset, idx) => {
              const compColor = compositeColor(asset.compositeScore);
              const playbookLabel =
                PLAYBOOK_SHORT[asset.topPlaybook] ?? asset.topPlaybook.toUpperCase();

              // Get top playbook's signals array
              const topPb = asset.playbookScores.find(
                (pb) => pb.playbook === asset.topPlaybook
              );
              const keySignals = topPb?.signals
                ? topPb.signals
                    .slice(0, 2)
                    .map((s) => {
                      const trimmed = s.length > 22 ? s.slice(0, 22) + "..." : s;
                      return trimmed;
                    })
                    .join(", ")
                : "--";

              return (
                <tr key={asset.slug} style={{ background: idx % 2 === 0 ? "#0c0c0e" : "#09090b" }}>
                  <td style={{ color: "#3f3f46" }}>{idx + 1}</td>
                  <td style={{ color: "#e4e4e7", fontWeight: "bold" }}>
                    {ASSET_DISPLAY[asset.slug] ?? asset.slug.toUpperCase()}
                  </td>
                  <td style={{ color: compColor }}>
                    {asset.compositeScore >= 0 ? "+" : ""}
                    {asset.compositeScore.toFixed(3)}
                  </td>
                  <td style={{ color: "#71717a" }}>{playbookLabel}</td>
                  <td
                    style={{
                      color: "#3f3f46",
                      maxWidth: 180,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 11,
                    }}
                    title={topPb?.signals?.join(", ")}
                  >
                    {keySignals}
                  </td>
                  <td>
                    {asset.isCandidate ? (
                      <span style={{ color: "#22c55e" }}>Yes</span>
                    ) : (
                      <span style={{ color: "#3f3f46" }}>No</span>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
