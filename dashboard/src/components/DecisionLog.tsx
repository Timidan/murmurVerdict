import type { DecisionLogEntry } from "../types";

interface DecisionLogProps {
  decisions: DecisionLogEntry[];
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

function actionColor(action: string): string {
  switch (action) {
    case "buy":
      return "amber";
    case "exit":
      return "green";
    case "reduce":
      return "amber";
    case "hold":
      return "";
    default:
      return "";
  }
}

function resultDisplay(entry: DecisionLogEntry): { text: string; className: string } {
  if (entry.pnlPct !== null && entry.result === "executed") {
    const sign = entry.pnlPct >= 0 ? "+" : "";
    return {
      text: `${sign}${entry.pnlPct.toFixed(1)}%`,
      className: entry.pnlPct >= 0 ? "green" : "red",
    };
  }
  switch (entry.result) {
    case "blocked":
      return { text: "BLOCKED", className: "red" };
    case "dry-run":
      return { text: "DRY-RUN", className: "blue" };
    case "hold":
      return { text: "HOLD", className: "" };
    case "executed":
      return { text: "OK", className: "green" };
    default:
      return { text: entry.result, className: "" };
  }
}

function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function DecisionLog({ decisions }: DecisionLogProps) {
  // Newest first
  const sorted = [...decisions].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return (
    <div className="panel">
      <div className="panel-title">DECISION LOG &mdash; LAST 20 CYCLES</div>
      <div className="decision-log-entries">
        {/* Header */}
        <div className="decision-entry decision-entry-header">
          <span>TIME</span>
          <span>ACTION</span>
          <span>ASSET</span>
          <span>THESIS</span>
          <span>RESULT</span>
        </div>

        {sorted.length === 0 ? (
          <div className="empty-state">No decisions yet</div>
        ) : (
          sorted.map((entry, i) => {
            const timeStr = relativeTime(entry.timestamp);
            const { text: resultText, className: resultClass } =
              resultDisplay(entry);

            // Alternating row backgrounds
            const rowBg = i % 2 === 0 ? "#0c0c0e" : "#09090b";

            return (
              <div
                className="decision-entry"
                key={`${entry.cycleId}-${i}`}
                style={{ background: rowBg }}
              >
                <span style={{ color: "#3f3f46" }}>{timeStr}</span>
                <span className={actionColor(entry.action)}>
                  {entry.action.toUpperCase()}
                </span>
                <span style={{ color: "#e4e4e7" }}>
                  {entry.slug ? SLUG_SHORT[entry.slug] ?? entry.slug : "\u2014"}
                </span>
                <span className="decision-thesis" title={entry.thesis}>
                  {entry.thesis}
                </span>
                <span className={resultClass}>{resultText}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
