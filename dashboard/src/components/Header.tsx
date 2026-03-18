import { useState, useEffect } from "react";
import type { DashboardSnapshot } from "../types";

interface HeaderProps {
  snapshot: DashboardSnapshot | null;
  connected: boolean;
}

export function Header({ snapshot, connected }: HeaderProps) {
  const [clock, setClock] = useState(getUTCTime());

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
          MURMUR
          {connected && <span className="header-pulse-dot" />}
        </span>
        <span className="header-status">
          <span className={`header-dot ${connected ? "connected" : "disconnected"}`} />
          {connected ? "LIVE" : "OFFLINE"}
        </span>
      </div>
      <div className="header-right">
        {snapshot && (
          <>
            <span>{snapshot.config.network.toUpperCase()}</span>
            <span>CYCLES: {snapshot.cycleCount}</span>
            {snapshot.config.dryRun && (
              <span className="header-badge">DRY RUN</span>
            )}
          </>
        )}
        <span className="value-tick" key={clock}>{clock} UTC</span>
      </div>
    </div>
  );
}

function getUTCTime(): string {
  const now = new Date();
  return now.toISOString().slice(11, 19);
}
