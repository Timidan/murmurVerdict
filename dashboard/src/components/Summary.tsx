import { useRef } from "react";
import type { DashboardSnapshot } from "../types";
import { Sparkline } from "./Sparkline";
import { PortfolioChart } from "./PortfolioChart";

interface SummaryProps {
  snapshot: DashboardSnapshot;
}

export function Summary({ snapshot }: SummaryProps) {
  const navHistory = useRef<number[]>([]);
  const nav = snapshot.treasury.totalPortfolioUsd;

  // Accumulate NAV history from successive snapshots
  if (
    navHistory.current.length === 0 ||
    navHistory.current[navHistory.current.length - 1] !== nav
  ) {
    navHistory.current = [...navHistory.current, nav].slice(-30);
  }

  // usdcBalance comes as string over WS (bigint serialization)
  const usdcRaw = Number(snapshot.treasury.usdcBalance) / 1e6;
  const usdc = formatUsd(usdcRaw);

  // P&L 24h: sum pnlPct from executed decisions in last 24h
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const recentExecuted = snapshot.lastDecisions.filter(
    (d) =>
      d.result === "executed" &&
      d.pnlPct !== null &&
      now - new Date(d.timestamp).getTime() < day
  );
  const pnl24h =
    recentExecuted.length > 0
      ? recentExecuted.reduce((sum, d) => sum + (d.pnlPct ?? 0), 0)
      : null;

  // Cap left
  const capLeft =
    snapshot.riskGate?.delegationCapRemaining ??
    snapshot.config.maxNotionalUsd;

  // Daily volume: count executed decisions
  const dailyVol = snapshot.lastDecisions.filter(
    (d) =>
      d.result === "executed" &&
      now - new Date(d.timestamp).getTime() < day
  ).length;

  // Last action: most recent non-hold decision
  const lastAction = snapshot.lastDecisions.find((d) => d.action !== "hold");

  return (
    <div className="summary-section">
      <div className="summary-row">
        <div className="stat-box">
          <div className="stat-label">NAV</div>
          <div className="stat-value">{formatUsd(nav)}</div>
          {navHistory.current.length >= 3 && (
            <div style={{ marginTop: 4, display: "flex", justifyContent: "center" }}>
              <Sparkline data={navHistory.current} width={60} height={16} filled />
            </div>
          )}
        </div>
        <div className="stat-box">
          <div className="stat-label">USDC</div>
          <div className="stat-value">{usdc}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">P&L 24H</div>
          <div className={`stat-value ${pnl24h !== null ? (pnl24h >= 0 ? "green" : "red") : ""}`}>
            {pnl24h !== null ? `${pnl24h >= 0 ? "+" : ""}${pnl24h.toFixed(2)}%` : "\u2014"}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">CAP LEFT</div>
          <div className="stat-value">{formatUsd(capLeft)}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">DAILY VOL</div>
          <div className="stat-value">{dailyVol}</div>
          <div className="stat-sub">trades</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">LAST ACTION</div>
          <div className={`stat-value ${actionColor(lastAction?.action)}`}>
            {lastAction
              ? `${lastAction.action.toUpperCase()} ${slugShort(lastAction.slug)}`
              : "\u2014"}
          </div>
          {lastAction && (
            <div className="stat-sub">
              {new Date(lastAction.timestamp).toISOString().slice(11, 16)} UTC
            </div>
          )}
        </div>
      </div>
      <PortfolioChart nav={nav} />
    </div>
  );
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${formatNum(n / 1_000_000, 2)}M`;
  if (n >= 1_000) return `$${formatNum(n / 1_000, 1)}K`;
  return `$${formatNum(n, 2)}`;
}

function formatNum(n: number, decimals: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function actionColor(action?: string): string {
  switch (action) {
    case "buy":
      return "amber";
    case "exit":
      return "green";
    case "reduce":
      return "amber";
    default:
      return "";
  }
}

function slugShort(slug: string | null | undefined): string {
  if (!slug) return "";
  const map: Record<string, string> = {
    ethereum: "ETH",
    weth: "WETH",
    "wrapped-bitcoin": "cbBTC",
    aave: "AAVE",
    uniswap: "UNI",
    chainlink: "LINK",
    "aerodrome-finance": "AERO",
    "virtual-protocol": "VRTL",
  };
  return map[slug] ?? slug.toUpperCase();
}
