import { randomUUID, randomBytes } from "crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import type { Address } from "viem";

import type {
  TreasuryState,
  DecisionReceipt,
  RiskGateResult,
  ScoredAsset,
} from "../types/index.js";
import type { DecisionLogEntry } from "../types/dashboard.js";
import { defaultPolicy, type RiskPolicy } from "../risk/index.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RiskProfile = "conservative" | "balanced" | "aggressive";

export interface UserSettings {
  maxTradeUsd: number;
  riskProfile: RiskProfile;
  maxDailyTrades: number;
}

export interface UserSession {
  token: string;
  ownerAddress: Address;
  agentPrivateKey: `0x${string}`;
  agentAddress: Address;
  settings: UserSettings;
  autopilotEnabled: boolean;
  nonce: string;
  createdAt: string;

  // Runtime state
  policy: RiskPolicy;
  treasuryState: TreasuryState;
  decisionLog: DecisionLogEntry[];
  receipts: DecisionReceipt[];
  lastScoredAssets: ScoredAsset[];
  lastRiskGate: RiskGateResult | null;
  cycleCount: number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: UserSettings = {
  maxTradeUsd: 5,
  riskProfile: "balanced",
  maxDailyTrades: 10,
};

const RISK_PRESETS: Record<RiskProfile, { maxSlippageBps: number; maxConcentrationPct: number }> = {
  conservative: { maxSlippageBps: 30, maxConcentrationPct: 15 },
  balanced: { maxSlippageBps: 50, maxConcentrationPct: 25 },
  aggressive: { maxSlippageBps: 100, maxConcentrationPct: 40 },
};

// ─── Session Store ───────────────────────────────────────────────────────────

const sessions = new Map<string, UserSession>(); // token -> session
const nonces = new Map<string, string>(); // address -> nonce
let activeSessionToken: string | null = null;

export function generateNonce(address: Address): string {
  const nonce = randomBytes(16).toString("hex");
  nonces.set(address.toLowerCase(), nonce);
  return nonce;
}

export function getNonceMessage(nonce: string): string {
  return `Sign in to Murmur\n\nNonce: ${nonce}`;
}

export async function verifyAndCreateSession(params: {
  address: Address;
  signature: `0x${string}`;
}): Promise<UserSession | null> {
  const { address, signature } = params;
  const nonce = nonces.get(address.toLowerCase());
  if (!nonce) return null;

  const message = getNonceMessage(nonce);
  const valid = await verifyMessage({ address, message, signature });
  if (!valid) return null;

  // Clear nonce (one-time use)
  nonces.delete(address.toLowerCase());

  // Check if user already has a session
  for (const [, session] of sessions) {
    if (session.ownerAddress.toLowerCase() === address.toLowerCase()) {
      activeSessionToken = session.token;
      return session;
    }
  }

  // Create new agent wallet for this user
  const agentPrivateKey = generatePrivateKey();
  const agentAccount = privateKeyToAccount(agentPrivateKey);

  const token = randomUUID();
  const session: UserSession = {
    token,
    ownerAddress: address,
    agentPrivateKey,
    agentAddress: agentAccount.address,
    settings: { ...DEFAULT_SETTINGS },
    autopilotEnabled: true,
    nonce,
    createdAt: new Date().toISOString(),

    policy: buildPolicyFromSettings(DEFAULT_SETTINGS),
    treasuryState: {
      usdcBalance: BigInt(0),
      totalPortfolioUsd: 0,
      positions: [],
      lastUpdatedAt: new Date().toISOString(),
    },
    decisionLog: [],
    receipts: [],
    lastScoredAssets: [],
    lastRiskGate: null,
    cycleCount: 0,
  };

  sessions.set(token, session);
  activeSessionToken = token;
  console.log(`[Session] New session for ${address} → agent wallet ${agentAccount.address}`);

  return session;
}

export function getSession(token: string): UserSession | null {
  return sessions.get(token) ?? null;
}

export function getActiveSession(): UserSession | null {
  if (!activeSessionToken) return null;
  return sessions.get(activeSessionToken) ?? null;
}

export function updateSettings(token: string, settings: Partial<UserSettings>): UserSession | null {
  const session = sessions.get(token);
  if (!session) return null;

  if (settings.maxTradeUsd !== undefined) session.settings.maxTradeUsd = settings.maxTradeUsd;
  if (settings.riskProfile !== undefined) session.settings.riskProfile = settings.riskProfile;
  if (settings.maxDailyTrades !== undefined) session.settings.maxDailyTrades = settings.maxDailyTrades;

  session.policy = buildPolicyFromSettings(session.settings);
  console.log(`[Session] Updated settings for ${session.ownerAddress}: ${JSON.stringify(session.settings)}`);

  return session;
}

export function setAutopilot(token: string, enabled: boolean): UserSession | null {
  const session = sessions.get(token);
  if (!session) return null;
  session.autopilotEnabled = enabled;
  console.log(`[Session] Autopilot ${enabled ? "enabled" : "disabled"} for ${session.ownerAddress}`);
  return session;
}

function buildPolicyFromSettings(settings: UserSettings): RiskPolicy {
  const preset = RISK_PRESETS[settings.riskProfile];
  return defaultPolicy({
    maxNotionalUsd: settings.maxTradeUsd,
    maxDailyTurnoverUsd: settings.maxTradeUsd * settings.maxDailyTrades,
    maxDelegationSpendUsd: settings.maxTradeUsd * settings.maxDailyTrades * 2,
    maxSlippageBps: preset.maxSlippageBps,
    maxConcentrationPct: preset.maxConcentrationPct,
  });
}
