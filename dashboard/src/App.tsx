import { useEffect, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useSignMessage, useReadContract } from "wagmi";
import { useSocket } from "./hooks/useSocket";
import { Header } from "./components/Header";
import { CycleBar } from "./components/CycleBar";
import { Summary } from "./components/Summary";
import { Positions } from "./components/Positions";
// Heatmap removed from dashboard layout
// RiskGate removed — internal debug info, not useful to end users
import { DecisionLog } from "./components/DecisionLog";
import { CurrentDecision } from "./components/CurrentDecision";
import { ReceiptStrip } from "./components/ReceiptStrip";
import { ConfigPanel } from "./components/ConfigPanel";
import { MurmurLogo, MurmurLogoInline } from "./components/MurmurLogo";

const API_URL = (import.meta as any).env?.VITE_TRIGGER_URL ?? "http://localhost:3001";
const VAULT_FACTORY = "0x6008148Bc859a7834A217f268c49b207D18465a3" as const;

const FACTORY_ABI = [{
  name: "getVault",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "user", type: "address" }],
  outputs: [{ name: "", type: "address" }],
}] as const;

interface AuthSession {
  token: string;
  agentAddress: string;
  settings: {
    maxTradeUsd: number;
    riskProfile: "conservative" | "balanced" | "aggressive";
    maxDailyTrades: number;
  };
  autopilotEnabled: boolean;
}

type SignMessageAsync = (args: { message: string }) => Promise<`0x${string}`>;

const DEFAULT_SETTINGS = {
  maxTradeUsd: 5,
  riskProfile: "balanced" as const,
  maxDailyTrades: 10,
};

/** Promise-based deduplication: only one auth flow per address at a time */
const authInFlight = new Map<string, Promise<AuthSession>>();

function authenticateOnce(address: `0x${string}`, signMessageAsync: SignMessageAsync): Promise<AuthSession> {
  const key = address.toLowerCase();
  const existing = authInFlight.get(key);
  if (existing) return existing;

  const request = (async (): Promise<AuthSession> => {
    const nonceRes = await fetch(`${API_URL}/api/auth/nonce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const nonceBody = await nonceRes.json();
    if (!nonceRes.ok || !nonceBody?.message) {
      throw new Error(nonceBody?.error ?? "Failed to fetch nonce.");
    }

    const signature = await signMessageAsync({ message: nonceBody.message });

    const verifyRes = await fetch(`${API_URL}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, signature }),
    });
    const verifyBody = await verifyRes.json();
    if (!verifyRes.ok || !verifyBody?.token) {
      throw new Error(verifyBody?.error ?? "Signature rejected or server error.");
    }

    return {
      token: verifyBody.token,
      agentAddress: verifyBody.agentAddress,
      settings: verifyBody.settings ?? DEFAULT_SETTINGS,
      autopilotEnabled: verifyBody.autopilotEnabled ?? true,
    };
  })().finally(() => {
    if (authInFlight.get(key) === request) authInFlight.delete(key);
  });

  authInFlight.set(key, request);
  return request;
}

export function App() {
  const { address, isConnected, connector } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [session, setSession] = useState<AuthSession | null>(() => {
    try {
      const stored = sessionStorage.getItem("murmur_session");
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  });
  const { snapshot, connected, currentPhase, authFailed } = useSocket(session?.token ?? null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);

  // Persist session to sessionStorage
  useEffect(() => {
    if (session) {
      sessionStorage.setItem("murmur_session", JSON.stringify(session));
    } else {
      sessionStorage.removeItem("murmur_session");
    }
  }, [session]);

  // Clear stale session when WS auth fails (e.g. after backend restart)
  useEffect(() => {
    if (authFailed && session) {
      setSession(null);
    }
  }, [authFailed]);

  // Reset session on disconnect
  useEffect(() => {
    if (!isConnected) {
      setSession(null);
      setAuthError(null);
    }
  }, [isConnected]);

  // Look up user's vault from factory
  const { data: userVaultAddr, refetch: refetchVault } = useReadContract({
    address: VAULT_FACTORY,
    abi: FACTORY_ABI,
    functionName: "getVault",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 10000 },
  });
  const vaultAddress = userVaultAddr && userVaultAddr !== "0x0000000000000000000000000000000000000000"
    ? (userVaultAddr as string)
    : null;

  // Manual sign-in — triggered by button click, never by useEffect
  const handleSignIn = async () => {
    if (!address || isSigning) return;
    setIsSigning(true);
    setAuthError(null);
    try {
      const result = await authenticateOnce(address, signMessageAsync);
      setSession(result);
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : "Signature rejected or server error.");
    } finally {
      setIsSigning(false);
    }
  };

  // Not connected — show connect screen
  if (!isConnected || !session) {
    return (
      <div className="dashboard-shell">
        <div className="header">
          <div className="header-left">
            <span className="header-brand"><MurmurLogoInline /></span>
          </div>
          <div className="header-right">
            <ConnectButton />
          </div>
        </div>
        <div className="connect-screen">
          <MurmurLogo size="lg" />
          <div className="connect-tagline">LISTEN. TRADE. REPEAT.</div>
          <div className="connect-subtitle">
            Connect your wallet to authenticate and configure your autonomous trading agent.
          </div>
          {authError && (
            <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>{authError}</div>
          )}
          {!isConnected && (
            <ConnectButton />
          )}
          {isConnected && !session && (
            <button
              className="header-trigger-btn"
              style={{ padding: "8px 24px", fontSize: 14 }}
              disabled={isSigning}
              onClick={handleSignIn}
            >
              {isSigning ? "Waiting for signature..." : "Sign in to Murmur"}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Authenticated — show full dashboard
  if (!connected) {
    return (
      <div className="dashboard-shell">
        <div className="header">
          <div className="header-left">
            <span className="header-brand"><MurmurLogoInline /></span>
          </div>
          <div className="header-right" style={{ color: "#ef4444" }}>
            DISCONNECTED
            <ConnectButton />
          </div>
        </div>
        <div className="loading-container">CONNECTING TO AGENT...</div>
      </div>
    );
  }

  return (
    <div className="dashboard-shell">
      <Header snapshot={snapshot} connected={connected} />
      <CycleBar
        currentPhase={currentPhase}
        cycleId={snapshot?.currentCycle?.cycleId}
        cycleStartedAt={snapshot?.currentCycle?.startedAt}
      />
      {!snapshot ? (
        <SkeletonLayout />
      ) : (
        <>
          <Summary snapshot={snapshot} vaultAddress={vaultAddress} />
          <ReceiptStrip snapshot={snapshot} />
          <div className="main-grid">
            <div className="main-grid-left-col">
              <ConfigPanel
                token={session.token}
                agentAddress={session.agentAddress}
                ownerAddress={address!}
                vaultAddress={vaultAddress}
                settings={session.settings}
                autopilotEnabled={session.autopilotEnabled}
                onSettingsChange={(settings) => setSession((s) => s ? { ...s, settings } : s)}
                onAutopilotChange={(autopilotEnabled) => setSession((s) => s ? { ...s, autopilotEnabled } : s)}
                onVaultCreated={() => refetchVault()}
              />
              <Positions snapshot={snapshot} ethPrice={snapshot.ethPrice} />
            </div>
            <div className="main-grid-right-col">
              <CurrentDecision snapshot={snapshot} />
              <DecisionLog decisions={snapshot.lastDecisions} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Skeleton loading state that mirrors the real layout */
function SkeletonLayout() {
  return (
    <>
      {/* Summary skeleton */}
      <div className="summary-section">
        <div className="summary-row">
          {Array.from({ length: 8 }).map((_, i) => (
            <div className="stat-box" key={i}>
              <div className="stat-label">
                <span className="skeleton" style={{ display: "inline-block", width: 36, height: 8 }} />
              </div>
              <div style={{ marginTop: 6 }}>
                <span className="skeleton" style={{ display: "inline-block", width: 64, height: 16 }} />
              </div>
            </div>
          ))}
        </div>
        {/* Chart skeleton */}
        <div className="portfolio-chart-container">
          <div className="skeleton" style={{ width: "100%", height: 120 }} />
        </div>
      </div>

      {/* Receipt strip skeleton */}
      <div className="receipt-strip">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="receipt-item" key={i}>
            <span className="skeleton" style={{ display: "inline-block", width: 48, height: 8 }} />
            <span className="skeleton" style={{ display: "inline-block", width: 80, height: 8 }} />
          </div>
        ))}
      </div>

      {/* Main grid skeleton */}
      <div className="main-grid">
        {/* Left col: config + positions skeleton */}
        <div className="main-grid-left-col">
          <div className="panel">
            <div className="panel-title">
              <span className="skeleton" style={{ display: "inline-block", width: 140, height: 8 }} />
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <span className="skeleton" style={{ display: "inline-block", width: 80, height: 8, marginBottom: 4 }} />
                <span className="skeleton" style={{ display: "block", width: "100%", height: 28 }} />
              </div>
            ))}
          </div>
          <div className="panel">
            <div className="panel-title">
              <span className="skeleton" style={{ display: "inline-block", width: 120, height: 8 }} />
            </div>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} style={{ display: "flex", gap: 12, padding: "6px 0", alignItems: "center" }}>
                <span className="skeleton" style={{ display: "inline-block", width: 40, height: 10 }} />
                <span className="skeleton" style={{ display: "inline-block", width: 48, height: 10 }} />
                <span className="skeleton" style={{ display: "inline-block", width: 32, height: 10 }} />
                <span className="skeleton" style={{ display: "inline-block", width: 32, height: 10 }} />
                <span className="skeleton" style={{ display: "inline-block", width: 28, height: 10 }} />
              </div>
            ))}
          </div>
        </div>

        {/* CurrentDecision skeleton */}
        <div className="panel current-decision">
          <div className="panel-title">
            <span className="skeleton" style={{ display: "inline-block", width: 120, height: 8 }} />
          </div>
          <span className="skeleton" style={{ display: "inline-block", width: 200, height: 28, marginTop: 8 }} />
          <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <span key={i} className="skeleton" style={{ display: "inline-block", width: 60, height: 10 }} />
            ))}
          </div>
          <span className="skeleton" style={{ display: "inline-block", width: "100%", height: 10, marginTop: 12 }} />
        </div>

        {/* RiskGate skeleton */}
        <div className="panel">
          <div className="panel-title">
            <span className="skeleton" style={{ display: "inline-block", width: 100, height: 8 }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px" }}>
            {Array.from({ length: 14 }).map((_, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0" }}>
                <span className="skeleton" style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%" }} />
                <span className="skeleton" style={{ display: "inline-block", width: 80, height: 9 }} />
              </div>
            ))}
          </div>
        </div>

        {/* Ranked Universe skeleton */}
        <div className="panel">
          <div className="panel-title">
            <span className="skeleton" style={{ display: "inline-block", width: 160, height: 8 }} />
          </div>
          {Array.from({ length: 7 }).map((_, row) => (
            <div key={row} style={{ display: "flex", gap: 8, marginBottom: 4, padding: "4px 0" }}>
              <span className="skeleton" style={{ display: "inline-block", width: 24, height: 12 }} />
              <span className="skeleton" style={{ display: "inline-block", width: 48, height: 12 }} />
              <span className="skeleton" style={{ display: "inline-block", width: 60, height: 12 }} />
              <span className="skeleton" style={{ display: "inline-block", width: 80, height: 12 }} />
              <span className="skeleton" style={{ display: "inline-block", flex: 1, height: 12 }} />
              <span className="skeleton" style={{ display: "inline-block", width: 32, height: 12 }} />
            </div>
          ))}
        </div>

        {/* DecisionLog skeleton */}
        <div className="panel main-grid-full">
          <div className="panel-title">
            <span className="skeleton" style={{ display: "inline-block", width: 160, height: 8 }} />
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "56px 52px 48px 40px 52px 1fr 72px 68px",
                gap: 6,
                padding: "4px 0",
                background: i % 2 === 0 ? "#0c0c0e" : "#09090b",
              }}
            >
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
              <span className="skeleton" style={{ display: "inline-block", height: 9 }} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
