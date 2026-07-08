import type Database from "better-sqlite3";
import {
  agentsRepo,
  type AgentRow,
} from "./repos/agents-repo.js";
import {
  controllerWalletAttestationStatus,
  getAccountForAgent,
  getControllerWalletForAgent,
  listRuntimeKeysForAccountAgent,
  type ControllerWalletRow,
  type RuntimeKeyRow,
} from "./auth/accounts.js";
import {
  DEFAULT_CONTROLLER_REATTESTATION_INTERVAL_SECONDS,
  isFreshAuthorization,
  normalizeEvmAddress,
} from "./controller-wallet.js";
import { parseRuntimeKeyGatewayPolicyJson } from "./auth/runtime-key-policy.js";
import {
  ERROR_CODES,
  WalletAddressSchema,
  VerdictError,
} from "./schema.js";
import { canonicalHash, canonicalize } from "../receipts/canonical.js";

export function nowIso(clock: () => Date): string {
  return clock().toISOString().replace(/\.\d+Z$/, "Z");
}

export function requireOwnedAgentBySlug(
  db: Database.Database,
  accountId: string,
  slug: string,
): AgentRow {
  const agent = agentsRepo.bySlug(db, slug);
  if (!agent) {
    throw new VerdictError("unknown agent", ERROR_CODES.unknown_agent, 404);
  }
  assertAgentOwnedBy(db, accountId, agent.agent_id);
  return agent;
}

export function assertAgentOwnedBy(
  db: Database.Database,
  accountId: string,
  agentId: string,
): void {
  const owner = getAccountForAgent(db, agentId);
  if (owner !== accountId) {
    throw new VerdictError(
      "agent not owned by this account",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
}

export function normalizeWalletAddress(raw: string): string {
  let normalized: string;
  try {
    normalized = normalizeEvmAddress(raw);
  } catch (err) {
    throw new VerdictError(
      "invalid wallet_address",
      ERROR_CODES.schema_invalid,
      400,
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
  const parsed = WalletAddressSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new VerdictError(
      "invalid wallet_address",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

export function assertFreshAuthorization(issuedAt: string, clock: () => Date): void {
  if (!isFreshAuthorization(issuedAt, clock())) {
    throw new VerdictError(
      "authorization signature is stale or issued too far in the future",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
}

export function ensureExpiresInFuture(
  expiresAt: string | undefined,
  clock: () => Date,
): void {
  if (!expiresAt) return;
  if (Date.parse(expiresAt) <= clock().getTime()) {
    throw new VerdictError(
      "expires_at must be in the future",
      ERROR_CODES.schema_invalid,
      400,
    );
  }
}

export function policyDigest(policy: unknown): {
  policy_json: string;
  policy_hash: `0x${string}`;
} {
  return {
    policy_json: canonicalize(policy),
    policy_hash: canonicalHash(policy),
  };
}

export function publicRuntimeKeyRow(row: RuntimeKeyRow) {
  return {
    runtime_key_id: row.runtime_key_id,
    runtime_key_prefix: row.runtime_key_prefix,
    label: row.label,
    policy: parseRuntimeKeyGatewayPolicyJson(row.policy_json),
    policy_hash: row.policy_hash,
    controller_wallet_address: row.controller_wallet_address,
    controller_chain_id: row.controller_chain_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    revoke_reason: row.revoke_reason,
  };
}

export function publicControllerWalletRow(
  controller: ControllerWalletRow,
  clock: () => Date,
) {
  const status = controllerWalletAttestationStatus(controller, {
    checkedAt: clock(),
  });
  return {
    wallet_address: controller.wallet_address,
    chain_id: controller.chain_id,
    wallet_kind: controller.wallet_kind,
    provider: controller.provider,
    created_at: controller.created_at,
    last_attested_at: status.last_attested_at,
    reattestation_due_at: status.reattestation_due_at,
    reattestation_overdue: status.reattestation_overdue,
    reattestation_interval_seconds: status.reattestation_interval_seconds,
  };
}

export function requireControllerWalletForAgent(
  db: Database.Database,
  agentId: string,
  message: string,
): ControllerWalletRow {
  const controller = getControllerWalletForAgent(db, agentId);
  if (!controller) {
    throw new VerdictError(
      message,
      ERROR_CODES.agent_not_authorized,
      409,
    );
  }
  return controller;
}

export function listPublicRuntimeKeysForAccountAgent(
  db: Database.Database,
  accountId: string,
  agentId: string,
) {
  return listRuntimeKeysForAccountAgent(db, accountId, agentId, true).map(
    publicRuntimeKeyRow,
  );
}

export function controllerWalletReattestationConstants() {
  return {
    reattestation_interval_seconds:
      DEFAULT_CONTROLLER_REATTESTATION_INTERVAL_SECONDS,
  };
}
