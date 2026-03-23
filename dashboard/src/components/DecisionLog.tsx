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
      return "green";
    case "exit":
      return "red";
    case "reduce":
      return "amber";
    case "hold":
      return "dim";
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
      return { text: "blocked", className: "red" };
    case "dry-run":
      return { text: "dry-run", className: "blue" };
    case "hold":
      return { text: "hold", className: "" };
    case "executed":
      return { text: "ok", className: "green" };
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

function truncateThesis(thesis: string, maxLen = 60): string {
  if (thesis.length <= maxLen) return thesis;
  return thesis.slice(0, maxLen - 1) + "\u2026";
}

function shortTxHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return hash.slice(0, 6) + "\u2026" + hash.slice(-4);
}

export function DecisionLog({ decisions }: DecisionLogProps) {
  // Newest first
  const sorted = [...decisions].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return (
    <div className="panel">
      <div className="panel-title">Decision Log &mdash; Last 20 Cycles</div>
      <div className="decision-log-entries">
        {/* Header */}
        <div className="decision-entry decision-entry-header">
          <span>Time</span>
          <span>Action</span>
          <span>Asset</span>
          <span>Conf</span>
          <span>Size</span>
          <span>Thesis</span>
          <span>Tx</span>
          <span>Result</span>
        </div>

        {sorted.length === 0 ? (
          <div className="empty-state">No decisions yet</div>
        ) : (
          sorted.map((entry, i) => {
            const timeStr = relativeTime(entry.timestamp);
            const { text: resultText, className: resultClass } =
              resultDisplay(entry);

            const confStr = `${Math.round(entry.confidence * 100)}%`;
            const sizeStr =
              entry.effectiveSizeUsd > 0
                ? `$${entry.effectiveSizeUsd.toFixed(0)}`
                : "\u2014";

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
                <span style={{ color: "#71717a" }}>{confStr}</span>
                <span style={{ color: "#71717a" }}>{sizeStr}</span>
                <span className="decision-thesis" title={entry.thesis}>
                  {truncateThesis(entry.thesis)}
                </span>
                <span>
                  {entry.txHash ? (
                    <a
                      href={`https://sepolia.basescan.org/tx/${entry.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#60a5fa", textDecoration: "none" }}
                    >
                      {shortTxHash(entry.txHash)}
                    </a>
                  ) : (
                    <span style={{ color: "#3f3f46" }}>\u2014</span>
                  )}
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
