import { randomBytes } from "node:crypto";

import {
  buildControllerWalletBindingMessage,
  buildControllerWalletReattestationMessage,
  buildRuntimeKeyAuthorizationMessage,
  type ControllerWalletKind,
} from "./controller-wallet.js";
import {
  ensureExpiresInFuture,
  normalizeWalletAddress,
  nowIso,
  policyDigest,
} from "./agent-identity.js";

export type ControllerWalletAuthorizationNonceAdapter = () => string;

function randomAuthorizationNonce(): string {
  return randomBytes(18).toString("base64url");
}

export interface ControllerWalletBindingAuthorizationInput {
  agentSlug: string;
  walletAddress: string;
  chainId: string;
  walletKind: ControllerWalletKind;
  provider?: string | null;
  issuedAt?: string;
  now: () => Date;
}

export interface ControllerWalletBindingAuthorization {
  wallet_address: string;
  chain_id: string;
  wallet_kind: ControllerWalletKind;
  provider: string | null;
  authorization_issued_at: string;
  message: string;
}

export function makeControllerWalletBindingAuthorization(
  input: ControllerWalletBindingAuthorizationInput,
): ControllerWalletBindingAuthorization {
  const walletAddress = normalizeWalletAddress(input.walletAddress);
  const issuedAt = input.issuedAt ?? nowIso(input.now);
  return {
    wallet_address: walletAddress,
    chain_id: input.chainId,
    wallet_kind: input.walletKind,
    provider: input.provider ?? null,
    authorization_issued_at: issuedAt,
    message: buildControllerWalletBindingMessage({
      agentSlug: input.agentSlug,
      walletAddress,
      chainId: input.chainId,
      walletKind: input.walletKind,
      provider: input.provider,
      issuedAt,
    }),
  };
}

export interface ControllerWalletReattestationAuthorizationInput {
  agentSlug: string;
  controllerWalletAddress: string;
  controllerChainId: string;
  attestationNonce?: string;
  newAuthorizationNonce?: ControllerWalletAuthorizationNonceAdapter;
  issuedAt?: string;
  now: () => Date;
}

export interface ControllerWalletReattestationAuthorization {
  controller_wallet_address: string;
  controller_chain_id: string;
  attestation_nonce: string;
  authorization_issued_at: string;
  message: string;
}

export function makeControllerWalletReattestationAuthorization(
  input: ControllerWalletReattestationAuthorizationInput,
): ControllerWalletReattestationAuthorization {
  const issuedAt = input.issuedAt ?? nowIso(input.now);
  const newNonce = input.newAuthorizationNonce ?? randomAuthorizationNonce;
  const nonce = input.attestationNonce ?? newNonce();
  return {
    controller_wallet_address: input.controllerWalletAddress,
    controller_chain_id: input.controllerChainId,
    attestation_nonce: nonce,
    authorization_issued_at: issuedAt,
    message: buildControllerWalletReattestationMessage({
      agentSlug: input.agentSlug,
      controllerWalletAddress: input.controllerWalletAddress,
      controllerChainId: input.controllerChainId,
      attestationNonce: nonce,
      issuedAt,
    }),
  };
}

export interface RuntimeKeyAuthorizationInput {
  agentSlug: string;
  controllerWalletAddress: string;
  controllerChainId: string;
  policy: unknown;
  authorizationNonce?: string;
  newAuthorizationNonce?: ControllerWalletAuthorizationNonceAdapter;
  expiresAt?: string;
  issuedAt?: string;
  now: () => Date;
}

export interface RuntimeKeyAuthorization {
  controller_wallet_address: string;
  controller_chain_id: string;
  policy_json: string;
  policy_hash: `0x${string}`;
  authorization_nonce: string;
  authorization_issued_at: string;
  expires_at: string | null;
  message: string;
}

export function makeRuntimeKeyAuthorization(
  input: RuntimeKeyAuthorizationInput,
): RuntimeKeyAuthorization {
  ensureExpiresInFuture(input.expiresAt, input.now);
  const { policy_json, policy_hash } = policyDigest(input.policy);
  const issuedAt = input.issuedAt ?? nowIso(input.now);
  const newNonce = input.newAuthorizationNonce ?? randomAuthorizationNonce;
  const nonce = input.authorizationNonce ?? newNonce();
  return {
    controller_wallet_address: input.controllerWalletAddress,
    controller_chain_id: input.controllerChainId,
    policy_json,
    policy_hash,
    authorization_nonce: nonce,
    authorization_issued_at: issuedAt,
    expires_at: input.expiresAt ?? null,
    message: buildRuntimeKeyAuthorizationMessage({
      agentSlug: input.agentSlug,
      controllerWalletAddress: input.controllerWalletAddress,
      controllerChainId: input.controllerChainId,
      policyHash: policy_hash,
      authorizationNonce: nonce,
      expiresAt: input.expiresAt,
      issuedAt,
    }),
  };
}
