import type { DashboardSnapshot } from "../types";

interface CurrentDecisionProps {
  snapshot: DashboardSnapshot;
}

const SLUG_SHORT: Record<string, string> = {
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

function actionColorClass(action: string): string {
  switch (action) {
    case "buy":
      return "buy";
    case "exit":
      return "exit";
    case "reduce":
      return "reduce";
    default:
      return "";
  }
}

function actionTextColor(action: string): string {
  switch (action) {
    case "buy":
      return "#22c55e";
    case "exit":
      return "#ef4444";
    case "reduce":
      return "#f59e0b";
    default:
      return "#e4e4e7";
  }
}

export function CurrentDecision({ snapshot }: CurrentDecisionProps) {
  const latest = snapshot.lastDecisions.find((d) => d.action !== "hold");

  if (!latest) {
    return (
      <div className="panel current-decision">
        <div className="panel-title">Current Signal</div>
        <div style={{ color: "#3f3f46", fontSize: 16, letterSpacing: 2, padding: "20px 0" }}>
          Awaiting signal
        </div>
      </div>
    );
  }

  const colorClass = actionColorClass(latest.action);
  const textColor = actionTextColor(latest.action);
  const assetShort = latest.slug ? (SLUG_SHORT[latest.slug] ?? latest.slug.toUpperCase()) : "--";
  const confPct = `${Math.round(latest.confidence * 100)}%`;
  const sizeStr = latest.effectiveSizeUsd > 0 ? `$${latest.effectiveSizeUsd.toFixed(2)}` : "--";

  // Extract top playbook from the scored asset for this slug
  const scoredAsset = latest.slug
    ? snapshot.scoredAssets.find((a) => a.slug === latest.slug)
    : null;
  const playbookName = scoredAsset
    ? (PLAYBOOK_SHORT[scoredAsset.topPlaybook] ?? scoredAsset.topPlaybook.toUpperCase())
    : "--";

  const thesisSnip = latest.thesis.length > 100 ? latest.thesis.slice(0, 100) + "..." : latest.thesis;

  // Invalidation condition lives in thesis text after "Invalidation:" if present,
  // or we pull from position if available
  const position = latest.slug
    ? snapshot.treasury.positions.find((p) => p.slug === latest.slug)
    : null;
  const invalidation = position?.invalidationCondition ?? null;

  return (
    <div className={`panel current-decision ${colorClass}`}>
      <div className="panel-title">Current Signal</div>
      <div className="decision-action" style={{ color: textColor }}>
        {latest.action.toUpperCase()} {assetShort}
      </div>
      <div className="decision-meta">
        <span>
          Conf <span className="decision-meta-value">{confPct}</span>
        </span>
        <span>
          Playbook <span className="decision-meta-value">{playbookName}</span>
        </span>
        <span>
          Size <span className="decision-meta-value">{sizeStr}</span>
        </span>
        <span>
          Result{" "}
          <span
            className="decision-meta-value"
            style={{
              color:
                latest.result === "executed"
                  ? "#22c55e"
                  : latest.result === "blocked"
                    ? "#ef4444"
                    : "#71717a",
            }}
          >
            {latest.result}
          </span>
        </span>
      </div>
      <div className="decision-thesis-text">{thesisSnip}</div>
      {invalidation && (
        <div className="decision-thesis-text" style={{ marginTop: 6, color: "#3f3f46" }}>
          Invalidation: {invalidation}
        </div>
      )}
    </div>
  );
}
