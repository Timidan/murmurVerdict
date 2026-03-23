import { useState, useEffect, useCallback } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import type { DashboardSnapshot } from "../types";
import { MurmurLogoInline } from "./MurmurLogo";

const TRIGGER_URL = (import.meta as any).env?.VITE_TRIGGER_URL ?? "http://localhost:3001";

interface HeaderProps {
  snapshot: DashboardSnapshot | null;
  connected: boolean;
}

export function Header({ snapshot }: HeaderProps) {
  const [clock, setClock] = useState(getUTCTime());
  const [triggering, setTriggering] = useState(false);

  const triggerCycle = useCallback(async () => {
    setTriggering(true);
    try {
      await fetch(`${TRIGGER_URL}/api/trigger-cycle`, { method: "POST" });
    } catch {}
    setTimeout(() => setTriggering(false), 3000);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setClock(getUTCTime());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="header">
      <div className="header-left">
        <span className="header-brand">
          <MurmurLogoInline />
        </span>
      </div>
      <div className="header-right">
        {snapshot && (
          <>
            <span>{snapshot.config.network.toUpperCase()}</span>
            <span>Cycles: {snapshot.cycleCount}</span>
            {snapshot.config.dryRun && (
              <span className="header-badge">Dry run</span>
            )}
          </>
        )}
        <button
          className="header-trigger-btn"
          onClick={triggerCycle}
          disabled={triggering}
        >
          {triggering ? "Running..." : "Run cycle"}
        </button>
        <span className="value-tick" key={clock}>{clock} UTC</span>
        <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
      </div>
    </div>
  );
}

function getUTCTime(): string {
  const now = new Date();
  return now.toISOString().slice(11, 19);
}
