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

const VALID_RISK_PROFILES: readonly RiskProfile[] = ["conservative", "balanced", "aggressive"] as const;

export function generateNonce(address: Address): string {
  const key = address.toLowerCase();
  const existing = nonces.get(key);
  if (existing) return existing;
  const nonce = randomBytes(16).toString("hex");
  nonces.set(key, nonce);
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
      return session;
    }
  }

  // Use the configured on-chain agent when available so the dashboard shows
  // the address that can actually execute against deployed vaults.
  const configuredAgentPrivateKey = process.env.AGENT_PRIVATE_KEY?.trim() ?? "";
  const configuredAgentAddress = process.env.AGENT_ADDRESS?.trim() ?? "";
  const hasConfiguredAgent =
    configuredAgentPrivateKey.startsWith("0x") &&
    configuredAgentAddress.startsWith("0x");

  const agentPrivateKey = hasConfiguredAgent
    ? (configuredAgentPrivateKey as `0x${string}`)
    : generatePrivateKey();
  const agentAccount = privateKeyToAccount(agentPrivateKey);
  const agentAddress = hasConfiguredAgent
    ? (configuredAgentAddress as Address)
    : agentAccount.address;

  const token = randomUUID();
  const session: UserSession = {
    token,
    ownerAddress: address,
    agentPrivateKey,
    agentAddress,
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
  console.log(`[Session] New session for ${address} → agent wallet ${agentAddress}`);

  return session;
}

export function getSession(token: string): UserSession | null {
  return sessions.get(token) ?? null;
}

export function updateSettings(token: string, settings: Partial<UserSettings>): UserSession | null {
  const session = sessions.get(token);
  if (!session) return null;

  // Validate maxTradeUsd: must be a positive number <= 1000
  if (settings.maxTradeUsd !== undefined) {
    if (typeof settings.maxTradeUsd !== "number" || !Number.isFinite(settings.maxTradeUsd) ||
        settings.maxTradeUsd <= 0 || settings.maxTradeUsd > 1000) {
      return null;
    }
  }

  // Validate riskProfile: must be one of the allowed values
  if (settings.riskProfile !== undefined) {
    if (!VALID_RISK_PROFILES.includes(settings.riskProfile as RiskProfile)) {
      return null;
    }
  }

  // Validate maxDailyTrades: must be a positive integer <= 100
  if (settings.maxDailyTrades !== undefined) {
    if (typeof settings.maxDailyTrades !== "number" || !Number.isInteger(settings.maxDailyTrades) ||
        settings.maxDailyTrades <= 0 || settings.maxDailyTrades > 100) {
      return null;
    }
  }

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

export function getAutopilotSessions(): UserSession[] {
  return [...sessions.values()].filter((session) => session.autopilotEnabled);
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
