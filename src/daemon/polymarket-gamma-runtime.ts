import type Database from "better-sqlite3";

export interface DaemonPolymarketGammaRuntime {
  stop: () => void;
}

export interface DaemonPolymarketGammaRuntimeDeps {
  db: Database.Database;
  enabled: boolean;
  nowMs: () => number;
  skipTickers?: boolean;
}

export async function startDaemonPolymarketGammaRuntime(
  deps: DaemonPolymarketGammaRuntimeDeps,
): Promise<DaemonPolymarketGammaRuntime | null> {
  if (!deps.enabled) return null;

  const { registerPolymarketGammaAdapter } = await import(
    "../markets/polymarket-gamma/register.js"
  );
  return registerPolymarketGammaAdapter(
    deps.skipTickers
      ? { nowMs: deps.nowMs, configureDefaultClient: true }
      : { db: deps.db, nowMs: deps.nowMs, configureDefaultClient: true },
  );
}
