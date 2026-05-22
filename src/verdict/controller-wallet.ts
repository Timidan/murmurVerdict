import { getAddress, recoverMessageAddress, type Hex } from "viem";

export type ControllerWalletKind = "embedded" | "external";

export const CONTROLLER_WALLET_AUTH_WINDOW_MS = 10 * 60 * 1000;
export const CONTROLLER_WALLET_FUTURE_SKEW_MS = 2 * 60 * 1000;
export const DEFAULT_CONTROLLER_REATTESTATION_INTERVAL_SECONDS = 14 * 24 * 60 * 60;

export interface ControllerWalletBindingMessageInput {
  agentSlug: string;
  walletAddress: string;
  chainId: string;
  walletKind: ControllerWalletKind;
  provider?: string | null;
  issuedAt: string;
}

export interface RuntimeKeyAuthorizationMessageInput {
  agentSlug: string;
  controllerWalletAddress: string;
  controllerChainId: string;
  policyHash: string;
  authorizationNonce: string;
  issuedAt: string;
  expiresAt?: string | null;
}

export interface ControllerWalletReattestationMessageInput {
  agentSlug: string;
  controllerWalletAddress: string;
  controllerChainId: string;
  attestationNonce: string;
  issuedAt: string;
}

export function normalizeEvmAddress(raw: string): string {
  return getAddress(raw).toLowerCase();
}

export function buildControllerWalletBindingMessage(
  input: ControllerWalletBindingMessageInput,
): string {
  return [
    "Murmur Controller Wallet Binding",
    `agent:${input.agentSlug}`,
    `wallet:${normalizeEvmAddress(input.walletAddress)}`,
    `chain:${input.chainId}`,
    `wallet_kind:${input.walletKind}`,
    `provider:${input.provider?.trim() || "none"}`,
    "scope:identity-only",
    `issued_at:${input.issuedAt}`,
  ].join("\n");
}

export function buildRuntimeKeyAuthorizationMessage(
  input: RuntimeKeyAuthorizationMessageInput,
): string {
  return [
    "Murmur Runtime Key Authorization",
    `agent:${input.agentSlug}`,
    `controller_wallet:${normalizeEvmAddress(input.controllerWalletAddress)}`,
    `chain:${input.controllerChainId}`,
    `policy_hash:${input.policyHash}`,
    `authorization_nonce:${input.authorizationNonce}`,
    `expires_at:${input.expiresAt ?? "none"}`,
    "scope:gateway-runtime-key",
    `issued_at:${input.issuedAt}`,
  ].join("\n");
}

export function buildControllerWalletReattestationMessage(
  input: ControllerWalletReattestationMessageInput,
): string {
  return [
    "Murmur Controller Wallet Re-Attestation",
    `agent:${input.agentSlug}`,
    `controller_wallet:${normalizeEvmAddress(input.controllerWalletAddress)}`,
    `chain:${input.controllerChainId}`,
    `attestation_nonce:${input.attestationNonce}`,
    "scope:identity-retention",
    `issued_at:${input.issuedAt}`,
  ].join("\n");
}

export function isFreshAuthorization(
  issuedAt: string,
  now: Date,
  maxAgeMs = CONTROLLER_WALLET_AUTH_WINDOW_MS,
): boolean {
  const issuedMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedMs)) return false;
  const ageMs = now.getTime() - issuedMs;
  return ageMs >= -CONTROLLER_WALLET_FUTURE_SKEW_MS && ageMs <= maxAgeMs;
}

export async function verifySignedMessageAddress(
  expectedAddress: string,
  message: string,
  signature: Hex,
): Promise<boolean> {
  let recovered: string;
  try {
    recovered = normalizeEvmAddress(
      await recoverMessageAddress({ message, signature }),
    );
  } catch {
    return false;
  }
  return recovered === normalizeEvmAddress(expectedAddress);
}
