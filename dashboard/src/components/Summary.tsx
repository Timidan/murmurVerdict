import { useRef } from "react";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits } from "viem";
import type { DashboardSnapshot } from "../types";
import { Sparkline } from "./Sparkline";
import { PortfolioChart } from "./PortfolioChart";

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const BALANCE_ABI = [{
  name: "balanceOf",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

const VAULT_BALANCE_ABI = [{
  name: "balanceOf",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "token", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

interface SummaryProps {
  snapshot: DashboardSnapshot;
  vaultAddress: string | null;
}

export function Summary({ snapshot, vaultAddress }: SummaryProps) {
  const { address } = useAccount();
  const navHistory = useRef<number[]>([]);

  // Read user's wallet USDC balance
  const { data: walletUsdc } = useReadContract({
    address: USDC_ADDRESS,
    abi: BALANCE_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 15000 },
  });

  // Read user's vault USDC balance
  const { data: vaultUsdc } = useReadContract({
    address: vaultAddress as `0x${string}` | undefined,
    abi: VAULT_BALANCE_ABI,
    functionName: "balanceOf",
    args: [USDC_ADDRESS],
    query: { enabled: !!vaultAddress, refetchInterval: 15000 },
  });

  const walletUsdcNum = walletUsdc ? Number(formatUnits(walletUsdc as bigint, 6)) : 0;
  const vaultUsdcNum = vaultUsdc ? Number(formatUnits(vaultUsdc as bigint, 6)) : 0;

  // Compute ETH value held in vault positions using live price
  const ethPositions = snapshot.treasury.positions.filter(
    (p) => p.slug === "ethereum" || p.slug === "weth"
  );
  const ethTokens = ethPositions.reduce(
    (sum, p) => sum + Number(p.amountHeld) / 1e18, 0
  );
  const ethValueUsd = snapshot.ethPrice ? ethTokens * snapshot.ethPrice : 0;

  const nav = vaultUsdcNum + ethValueUsd; // NAV = USDC + ETH value in vault

  // Accumulate NAV history from successive snapshots
  if (
    navHistory.current.length === 0 ||
    navHistory.current[navHistory.current.length - 1] !== nav
  ) {
    navHistory.current = [...navHistory.current, nav].slice(-30);
  }

  const usdc = formatUsd(walletUsdcNum);

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

  // Buying power: vault USDC minus nothing already deployed (USDC is liquid)
  const capLeft = vaultUsdcNum;

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
          <div className="stat-label">Vault balance</div>
          <div className="stat-value">{formatUsd(nav)}</div>
          <div className="stat-sub" style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <span>{formatUsd(vaultUsdcNum)} USDC</span>
            {ethTokens > 0 && (
              <span style={{ color: "#a78bfa" }}>
                {ethTokens >= 0.01 ? ethTokens.toFixed(4) : ethTokens.toFixed(6)} ETH
              </span>
            )}
          </div>
          {navHistory.current.length >= 3 && (
            <div style={{ marginTop: 4, display: "flex", justifyContent: "center" }}>
              <Sparkline data={navHistory.current} width={60} height={16} filled />
            </div>
          )}
        </div>
        <div className="stat-box">
          <div className="stat-label">Wallet USDC</div>
          <div className="stat-value">{usdc}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">P&L 24h</div>
          <div className={`stat-value ${pnl24h !== null ? (pnl24h >= 0 ? "green" : "red") : ""}`}>
            {pnl24h !== null ? `${pnl24h >= 0 ? "+" : ""}${pnl24h.toFixed(2)}%` : "No exits"}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Buying power</div>
          <div className="stat-value">{formatUsd(capLeft)}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Trades</div>
          <div className="stat-value">{dailyVol}</div>
          <div className="stat-sub">trades</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Last action</div>
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
        <div className="stat-box">
          <div className="stat-label">Eth/Usd</div>
          <div className="stat-value">{snapshot.ethPrice ? `$${snapshot.ethPrice.toFixed(2)}` : "\u2014"}</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Regime</div>
          <div className={`stat-value ${snapshot.regime === "bullish" ? "green" : snapshot.regime === "bearish" ? "red" : ""}`}>
            {snapshot.regime.toUpperCase()}
          </div>
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
