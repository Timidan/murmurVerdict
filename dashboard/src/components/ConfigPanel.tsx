import { useState } from "react";
import { useWriteContract, useReadContract, usePublicClient } from "wagmi";
import { parseUnits, maxUint256, formatUnits } from "viem";

const API_URL = (import.meta as any).env?.VITE_TRIGGER_URL ?? "http://localhost:3001";

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const VAULT_FACTORY = "0x6008148Bc859a7834A217f268c49b207D18465a3" as const;

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const VAULT_DEPOSIT_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const TRADE_VAULT_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const FACTORY_CREATE_ABI = [
  {
    name: "createVault",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getVault",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

interface ConfigPanelProps {
  token: string;
  agentAddress: string;
  ownerAddress: string;
  vaultAddress: string | null;
  settings: {
    maxTradeUsd: number;
    riskProfile: "conservative" | "balanced" | "aggressive";
    maxDailyTrades: number;
  };
  autopilotEnabled: boolean;
  onSettingsChange: (settings: any) => void;
  onAutopilotChange: (enabled: boolean) => void;
  onVaultCreated?: () => void;
}

export function ConfigPanel({
  token,
  agentAddress,
  ownerAddress,
  vaultAddress,
  settings,
  autopilotEnabled,
  onSettingsChange,
  onAutopilotChange,
  onVaultCreated,
}: ConfigPanelProps) {
  const [maxTradeUsd, setMaxTradeUsd] = useState(settings.maxTradeUsd);
  const [riskProfile, setRiskProfile] = useState(settings.riskProfile);
  const [maxDailyTrades, setMaxDailyTrades] = useState(settings.maxDailyTrades);
  const [saving, setSaving] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositing, setDepositing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const { data: vaultUsdcBalance, refetch: refetchVaultBalance } = useReadContract({
    address: vaultAddress as `0x${string}` | undefined,
    abi: TRADE_VAULT_ABI,
    functionName: "balanceOf",
    args: [USDC_ADDRESS],
    query: { enabled: !!vaultAddress, refetchInterval: 15000 },
  });

  const { data: walletUsdcBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: [{
      name: "balanceOf",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    }] as const,
    functionName: "balanceOf",
    args: ownerAddress ? [ownerAddress as `0x${string}`] : undefined,
    query: { enabled: !!ownerAddress, refetchInterval: 15000 },
  });

  const formattedWalletBalance =
    walletUsdcBalance !== undefined
      ? `$${Number(formatUnits(walletUsdcBalance as bigint, 6)).toFixed(2)}`
      : "—";

  const saveSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/me/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ maxTradeUsd, riskProfile, maxDailyTrades }),
      });
      const data = await res.json();
      onSettingsChange(data.settings);
    } catch {}
    setSaving(false);
  };

  const toggleAutopilot = async () => {
    try {
      const res = await fetch(`${API_URL}/api/me/autopilot`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled: !autopilotEnabled }),
      });
      const data = await res.json();
      onAutopilotChange(data.autopilotEnabled);
    } catch {}
  };

  const [depositStep, setDepositStep] = useState("");

  const waitForTx = async (hash: `0x${string}`) => {
    if (!publicClient) throw new Error("No public client");
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status === "reverted") throw new Error("Transaction reverted");
    return receipt;
  };

  const handleDeposit = async () => {
    if (!depositAmount || Number(depositAmount) <= 0) return;
    setDepositing(true);
    setDepositStep("");
    try {
      const amount = parseUnits(depositAmount, 6);
      let vault = vaultAddress as `0x${string}` | null;

      // Step 1: create vault if none exists
      if (!vault) {
        setDepositStep("Creating vault...");
        const createHash = await writeContractAsync({
          address: VAULT_FACTORY,
          abi: FACTORY_CREATE_ABI,
          functionName: "createVault",
        });
        setDepositStep("Waiting for vault deployment...");
        await waitForTx(createHash);

        // Read the new vault address
        const newVault = await publicClient!.readContract({
          address: VAULT_FACTORY,
          abi: FACTORY_CREATE_ABI,
          functionName: "getVault",
          args: [ownerAddress as `0x${string}`],
        });
        vault = newVault as `0x${string}`;
        if (!vault || vault === "0x0000000000000000000000000000000000000000") {
          throw new Error("Vault creation failed");
        }
        onVaultCreated?.();
      }

      // Step 2: approve USDC spend
      setDepositStep("Approving USDC...");
      const approveHash = await writeContractAsync({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [vault, maxUint256],
      });
      setDepositStep("Waiting for approval...");
      await waitForTx(approveHash);

      // Step 3: deposit into vault
      setDepositStep("Depositing to vault...");
      const depositHash = await writeContractAsync({
        address: vault,
        abi: VAULT_DEPOSIT_ABI,
        functionName: "deposit",
        args: [USDC_ADDRESS, amount],
      });
      setDepositStep("Confirming deposit...");
      await waitForTx(depositHash);

      setDepositAmount("");
      setDepositStep("Done!");
      await refetchVaultBalance();
      onVaultCreated?.(); // refetch vault data
      setTimeout(() => setDepositStep(""), 2000);
    } catch (err: any) {
      console.error("[ConfigPanel] Deposit failed:", err);
      setDepositStep(err?.shortMessage || err?.message || "Transaction failed");
      setTimeout(() => setDepositStep(""), 4000);
    }
    setDepositing(false);
  };

  const EXPLORER = "https://sepolia.basescan.org/address/";
  const addrLink = (addr: string | null, label?: string) => {
    if (!addr) return <span>—</span>;
    const display = label || `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    return (
      <a href={`${EXPLORER}${addr}`} target="_blank" rel="noopener noreferrer"
        style={{ color: "#3b82f6", textDecoration: "none" }}
        onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
        onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
      >{display}</a>
    );
  };

  const formattedVaultBalance =
    vaultUsdcBalance !== undefined
      ? `$${Number(formatUnits(vaultUsdcBalance as bigint, 6)).toFixed(2)}`
      : "—";

  const hasNoUsdc = !walletUsdcBalance || (walletUsdcBalance as bigint) === BigInt(0);
  const hasNoVault = !vaultAddress;
  const hasNoVaultBalance = !vaultUsdcBalance || (vaultUsdcBalance as bigint) === BigInt(0);
  const isNewUser = hasNoVault && hasNoUsdc;

  return (
    <div className="panel config-panel">
      <div className="panel-title">Agent configuration</div>

      {/* ── New user onboarding prompts ────────────────── */}
      {isNewUser && (
        <div className="setup-banner">
          <div className="setup-banner-title">Welcome to Murmur</div>
          <div className="setup-banner-desc">Get started in 3 steps:</div>
          <div className="setup-steps">
            <div className={`setup-step ${hasNoUsdc ? "active" : "done"}`}>
              <span className="setup-step-num">{hasNoUsdc ? "1" : "\u2713"}</span>
              <span>Get testnet USDC on Base Sepolia</span>
            </div>
            <div className={`setup-step ${!hasNoUsdc && hasNoVault ? "active" : hasNoVault ? "" : "done"}`}>
              <span className="setup-step-num">{hasNoVault ? "2" : "\u2713"}</span>
              <span>Deposit to create your vault</span>
            </div>
            <div className={`setup-step ${!hasNoVault && hasNoVaultBalance ? "active" : ""}`}>
              <span className="setup-step-num">3</span>
              <span>Configure &amp; enable autopilot</span>
            </div>
          </div>
        </div>
      )}

      {hasNoUsdc && (
        <div className="setup-prompt">
          <div className="setup-prompt-icon">{"\u26A0"}</div>
          <div>
            <div className="setup-prompt-title">No USDC in wallet</div>
            <div className="setup-prompt-desc">
              You need Base Sepolia USDC to deposit into your vault.
            </div>
            <a
              href="https://faucet.circle.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="setup-prompt-link"
            >
              Get testnet USDC from Circle Faucet {"\u2192"}
            </a>
          </div>
        </div>
      )}

      {!hasNoUsdc && hasNoVault && (
        <div className="setup-prompt success">
          <div className="setup-prompt-icon">{"\u2713"}</div>
          <div>
            <div className="setup-prompt-title">USDC ready — deposit to create your vault</div>
            <div className="setup-prompt-desc">
              Your first deposit will deploy a non-custodial TradeVault contract owned by you.
            </div>
          </div>
        </div>
      )}

      {!hasNoVault && hasNoVaultBalance && (
        <div className="setup-prompt">
          <div className="setup-prompt-icon">{"\u21E9"}</div>
          <div>
            <div className="setup-prompt-title">Vault deployed — deposit USDC to start trading</div>
            <div className="setup-prompt-desc">
              Your vault is live. Deposit USDC below so the agent can trade within your limits.
            </div>
          </div>
        </div>
      )}

      <div className="config-addresses">
        <div className="config-row">
          <span className="config-label">Your wallet</span>
          <span className="config-value">{addrLink(ownerAddress)}</span>
        </div>
        <div className="config-row">
          <span className="config-label">Agent wallet</span>
          <span className="config-value">{addrLink(agentAddress)}</span>
        </div>
        <div className="config-row">
          <span className="config-label">Trade vault</span>
          <span className="config-value">{hasNoVault ? <span style={{ color: "#f59e0b" }}>Not deployed yet</span> : addrLink(vaultAddress)}</span>
        </div>
        <div className="config-row">
          <span className="config-label">Your USDC</span>
          <span className="config-value">{formattedWalletBalance}</span>
        </div>
        <div className="config-row">
          <span className="config-label">Vault balance</span>
          <span className="config-value green">{formattedVaultBalance}</span>
        </div>
      </div>

      <div className="config-actions">
        <button className="config-btn save" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </div>

      {/* ── Settings Dialog ─────────────────────────────── */}
      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <span className="panel-title">Agent Settings</span>
              <button className="settings-close" onClick={() => setShowSettings(false)}>&times;</button>
            </div>

            <div className="config-section">
              <label className="config-label">Max trade size (USD)</label>
              <input
                type="number"
                className="config-input"
                value={maxTradeUsd}
                onChange={(e) => setMaxTradeUsd(Number(e.target.value))}
                min={1}
                max={100}
              />
            </div>

            <div className="config-section">
              <label className="config-label">Risk profile</label>
              <div className="config-risk-buttons">
                {(["conservative", "balanced", "aggressive"] as const).map((p) => (
                  <button
                    key={p}
                    className={`config-risk-btn ${riskProfile === p ? "active" : ""}`}
                    onClick={() => setRiskProfile(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <div className="config-section">
              <label className="config-label">Max daily trades</label>
              <input
                type="number"
                className="config-input"
                value={maxDailyTrades}
                onChange={(e) => setMaxDailyTrades(Number(e.target.value))}
                min={1}
                max={50}
              />
            </div>

            <div className="config-section">
              <label className="config-label">Auto-trade</label>
              <button
                className={`config-btn ${autopilotEnabled ? "autopilot-on" : "autopilot-off"}`}
                style={{ width: "100%" }}
                onClick={toggleAutopilot}
              >
                {autopilotEnabled ? "Autopilot: ON — agent is trading" : "Autopilot: OFF — signals only"}
              </button>
            </div>

            <button className="config-btn save" style={{ width: "100%" }} onClick={async () => { await saveSettings(); setShowSettings(false); }} disabled={saving}>
              {saving ? "Saving..." : "Save settings"}
            </button>
          </div>
        </div>
      )}

      <div className="config-section">
        <label className="config-label">Deposit USDC to vault</label>
        <div className="deposit-input-row">
          <div className="deposit-input-wrap">
            <input
              type="number"
              className="config-input"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="0.00"
              min={0.01}
              step={0.01}
              disabled={depositing}
            />
            <div className="deposit-pct-btns">
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  className="deposit-pct-btn"
                  disabled={hasNoUsdc || depositing}
                  onClick={() => {
                    if (!walletUsdcBalance) return;
                    const total = Number(formatUnits(walletUsdcBalance as bigint, 6));
                    const val = pct === 100 ? total : Math.floor(total * pct / 100 * 100) / 100;
                    setDepositAmount(val.toString());
                  }}
                >
                  {pct === 100 ? "MAX" : `${pct}%`}
                </button>
              ))}
            </div>
          </div>
          <button className="config-btn save" onClick={handleDeposit} disabled={depositing || hasNoUsdc}>
            {depositing ? "Processing..." : hasNoVault ? "Create Vault & Deposit" : "Deposit"}
          </button>
        </div>
        {depositStep && (
          <div style={{
            marginTop: 6,
            fontSize: 11,
            fontFamily: "'Geist Mono', monospace",
            color: depositStep === "Done!" ? "#22c55e"
              : depositStep.includes("failed") || depositStep.includes("reverted") ? "#ef4444"
              : "#f59e0b",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}>
            {depositing && <span className="deposit-spinner" />}
            {depositStep}
          </div>
        )}
      </div>
    </div>
  );
}
