import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { z } from "zod";

import {
  assertFreshAuthorization,
  publicRuntimeKeyRow,
  requireControllerWalletForAgent,
  requireOwnedAgentBySlug,
} from "./agent-identity.js";
import {
  assertAgentCredentialsEnabled,
  controllerWalletAttestationStatus,
  mintRuntimeKey,
  revokeRuntimeKey,
  RuntimeKeyAuthorizationReplayError,
  type RuntimeKeyMintAdapters,
} from "./auth/accounts.js";
import { listRuntimeKeysForAccountAgent } from "./auth/runtime-keys.js";
import { RuntimeKeyPolicySchema } from "./auth/runtime-key-policy.js";
import {
  aggregateRuntimeKeyConnection,
  runtimeKeyConnection,
} from "./runtime-key-connection.js";
import {
  verifySignedMessageAddress,
} from "./controller-wallet.js";
import {
  type ControllerWalletAuthorizationNonceAdapter,
  makeRuntimeKeyAuthorization,
} from "./controller-wallet-authorization.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

export interface AccountRuntimeKeySurfaceBase {
  db: Database.Database;
  accountId: string;
}

export interface AccountRuntimeKeyWriteClock {
  operationInstant: Date;
}

export interface AccountRuntimeKeyJsonResponse {
  status: 200 | 201;
  body: unknown;
}

export interface AccountRuntimeKeyJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendAccountRuntimeKeyJsonResponse(
  res: AccountRuntimeKeyJsonResponseTarget,
  result: AccountRuntimeKeyJsonResponse,
): void {
  res.status(result.status).json(result.body);
}

export type RuntimeKeySignatureVerifier = (
  expectedAddress: string,
  message: string,
  signature: Hex,
) => Promise<boolean>;

export function listAccountRuntimeKeysResponse(
  input: AccountRuntimeKeySurfaceBase & AccountRuntimeKeyWriteClock & {
    slug: string;
  },
): {
  status: 200;
  body: {
    keys: Array<ReturnType<typeof publicRuntimeKeyRow> & {
      connection: ReturnType<typeof runtimeKeyConnection>;
    }>;
    connection: ReturnType<typeof runtimeKeyConnection>;
    served_at: string;
  };
} {
  const agent = requireOwnedAgentBySlug(input.db, input.accountId, input.slug);
  const keys = listRuntimeKeysForAccountAgent(
    input.db,
    input.accountId,
    agent.agent_id,
    true,
  ).map((row) => ({
    ...publicRuntimeKeyRow(row),
    connection: runtimeKeyConnection(input.db, row, input.operationInstant),
  }));
  return {
    status: 200,
    body: {
      keys,
      connection: aggregateRuntimeKeyConnection(keys.map((key) => key.connection)),
      served_at: input.operationInstant.toISOString().replace(/\.\d+Z$/, "Z"),
    },
  };
}

export function runtimeKeyChallengeResponse(
  input: AccountRuntimeKeySurfaceBase & AccountRuntimeKeyWriteClock & {
    slug: string;
    body: unknown;
    newAuthorizationNonce?: ControllerWalletAuthorizationNonceAdapter;
  },
): {
  status: 200;
  body: {
    agent_id: string;
    display_slug: string;
    controller_wallet_address: string;
    controller_chain_id: string;
    policy_hash: string;
    authorization_nonce: string;
    authorization_issued_at: string;
    expires_at: string | null;
    message: string;
  };
} {
  assertAgentCredentialsEnabled(input.db, input.accountId);
  const agent = requireOwnedAgentBySlug(input.db, input.accountId, input.slug);
  const controller = requireControllerWalletForAgent(
    input.db,
    agent.agent_id,
    "bind a controller wallet before minting runtime keys",
  );
  const parsed = RuntimeKeyChallengeSchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throwInvalidRequest(parsed.error.issues);
  }
  const authorization = makeRuntimeKeyAuthorization({
    agentSlug: agent.display_slug,
    controllerWalletAddress: controller.wallet_address,
    controllerChainId: controller.chain_id,
    policy: parsed.data.policy,
    expiresAt: parsed.data.expires_at,
    newAuthorizationNonce: input.newAuthorizationNonce,
    now: () => input.operationInstant,
  });
  return {
    status: 200,
    body: {
      agent_id: agent.agent_id,
      display_slug: agent.display_slug,
      controller_wallet_address: authorization.controller_wallet_address,
      controller_chain_id: authorization.controller_chain_id,
      policy_hash: authorization.policy_hash,
      authorization_nonce: authorization.authorization_nonce,
      authorization_issued_at: authorization.authorization_issued_at,
      expires_at: authorization.expires_at,
      message: authorization.message,
    },
  };
}

export async function mintAccountRuntimeKeyResponse(
  input: AccountRuntimeKeySurfaceBase & AccountRuntimeKeyWriteClock & RuntimeKeyMintAdapters & {
    slug: string;
    body: unknown;
    verifySignature?: RuntimeKeySignatureVerifier;
  },
): Promise<{
  status: 201;
  body: {
    runtime_key_id: string;
    secret: string;
    runtime_key_prefix: string;
    label: string | null;
    policy_hash: string;
    created_at: string;
    expires_at: string | null;
    warning: string;
  };
}> {
  assertAgentCredentialsEnabled(input.db, input.accountId);
  const agent = requireOwnedAgentBySlug(input.db, input.accountId, input.slug);
  const controller = requireControllerWalletForAgent(
    input.db,
    agent.agent_id,
    "bind a controller wallet before minting runtime keys",
  );
  const operationClock = () => input.operationInstant;
  const attestation = controllerWalletAttestationStatus(controller, {
    checkedAt: input.operationInstant,
  });
  if (attestation.reattestation_overdue) {
    throw new VerdictError(
      "controller wallet re-attestation is overdue; sign a fresh re-attestation before minting runtime keys",
      ERROR_CODES.agent_not_authorized,
      409,
      {
        reattestation_due_at: attestation.reattestation_due_at,
        reattestation_overdue: true,
      },
    );
  }

  const parsed = RuntimeKeyMintSchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throwInvalidRequest(parsed.error.issues);
  }
  const authorization = makeRuntimeKeyAuthorization({
    agentSlug: agent.display_slug,
    controllerWalletAddress: controller.wallet_address,
    controllerChainId: controller.chain_id,
    policy: parsed.data.policy,
    authorizationNonce: parsed.data.authorization_nonce,
    expiresAt: parsed.data.expires_at,
    issuedAt: parsed.data.authorization_issued_at,
    now: operationClock,
  });
  assertFreshAuthorization(parsed.data.authorization_issued_at, operationClock);

  const signatureOk = await (input.verifySignature ?? verifySignedMessageAddress)(
    controller.wallet_address,
    authorization.message,
    parsed.data.signature as Hex,
  );
  if (!signatureOk) {
    throw new VerdictError(
      "runtime-key authorization signature does not match controller wallet",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }

  let minted: ReturnType<typeof mintRuntimeKey>;
  try {
    // The signature await above is a suspension point: the kill switch can
    // engage (bulk-revoking every EXISTING key) or the controller wallet can
    // be rebound while this request is parked. Re-check both inside one
    // immediate transaction with the insert, so a late mint can never slip a
    // fresh unrevoked key past an engagement or bind to a stale wallet.
    minted = input.db.transaction(() => {
      assertAgentCredentialsEnabled(input.db, input.accountId);
      requireOwnedAgentBySlug(input.db, input.accountId, input.slug);
      const controllerNow = requireControllerWalletForAgent(
        input.db,
        agent.agent_id,
        "controller wallet unbound while minting",
      );
      if (
        controllerNow.wallet_address !== controller.wallet_address ||
        controllerNow.chain_id !== controller.chain_id
      ) {
        throw new VerdictError(
          "controller wallet changed while minting; re-sign the authorization",
          ERROR_CODES.agent_not_authorized,
          409,
        );
      }
      const attestationNow = controllerWalletAttestationStatus(controllerNow, {
        checkedAt: input.operationInstant,
      });
      if (attestationNow.reattestation_overdue) {
        throw new VerdictError(
          "controller wallet re-attestation lapsed while minting",
          ERROR_CODES.agent_not_authorized,
          409,
        );
      }
      return mintRuntimeKey(input.db, {
        account_id: input.accountId,
        agent_id: agent.agent_id,
        label: parsed.data.label,
        policy_json: authorization.policy_json,
        policy_hash: authorization.policy_hash,
        controller_wallet_address: controller.wallet_address,
        controller_chain_id: controller.chain_id,
        authorization_nonce: authorization.authorization_nonce,
        authorization_message: authorization.message,
        authorization_signature: parsed.data.signature,
        expires_at: authorization.expires_at,
        createdAt: input.operationInstant,
        newRuntimeKeyId: input.newRuntimeKeyId,
        newRuntimeKeySecret: input.newRuntimeKeySecret,
      });
    }).immediate();
  } catch (err) {
    if (err instanceof RuntimeKeyAuthorizationReplayError) {
      throw new VerdictError(err.message, ERROR_CODES.duplicate, 409, {
        agent_id: agent.agent_id,
      });
    }
    throw err;
  }

  return {
    status: 201,
    body: {
      runtime_key_id: minted.runtime_key_id,
      secret: minted.secret,
      runtime_key_prefix: minted.runtime_key_prefix,
      label: parsed.data.label ?? null,
      policy_hash: authorization.policy_hash,
      created_at: minted.created_at,
      expires_at: authorization.expires_at,
      warning: "store this runtime key now — it is not retrievable later",
    },
  };
}

export function revokeAccountRuntimeKeyResponse(
  input: AccountRuntimeKeySurfaceBase & AccountRuntimeKeyWriteClock & {
    keyId: string;
    body: unknown;
  },
): {
  status: 200;
  body: {
    revoked: boolean;
  };
} {
  const parsed = RuntimeKeyRevokeSchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throwInvalidRequest(parsed.error.issues);
  }
  const revoked = revokeRuntimeKey(input.db, {
    account_id: input.accountId,
    runtime_key_id: input.keyId,
    reason: parsed.data.reason,
    revokedAt: input.operationInstant,
  });
  return { status: 200, body: { revoked } };
}

export function deleteRevokedAccountRuntimeKeyResponse(input: AccountRuntimeKeySurfaceBase & {
  keyId: string;
  body: unknown;
}): { status: 200; body: { deleted: true } } {
  if (!z.object({ confirm: z.literal(input.keyId) }).strict().safeParse(input.body).success) {
    throw new VerdictError("confirm the key ID to permanently delete it", ERROR_CODES.schema_invalid, 400);
  }
  return input.db.transaction(() => {
    const key = input.db.prepare("SELECT revoked_at FROM agent_runtime_keys WHERE runtime_key_id = ? AND account_id = ?")
      .get(input.keyId, input.accountId) as { revoked_at: string | null } | undefined;
    if (!key) throw new VerdictError("runtime key not owned by this account", ERROR_CODES.agent_not_authorized, 403);
    if (!key.revoked_at) throw new VerdictError("revoke the Runtime Key before deleting it", ERROR_CODES.schema_invalid, 409);
    // ON DELETE SET NULL preserves history, but pending workers still need the
    // key ID to enforce revocation before broadcasting or finish confirming.
    for (const table of ["fhenix_gateway_tx_attempts", "fhenix_gateway_feed_packet_tx_attempts"]) {
      if (input.db.prepare(`SELECT 1 FROM ${table} WHERE runtime_key_id = ? AND status NOT IN ('accepted', 'failed_terminal') LIMIT 1`).get(input.keyId)) {
        throw new VerdictError("this key has pending transactions; wait for them to finish before deleting it", ERROR_CODES.schema_invalid, 409);
      }
    }
    input.db.prepare("DELETE FROM agent_runtime_key_nonces WHERE runtime_key_id = ?").run(input.keyId);
    input.db.prepare("DELETE FROM agent_runtime_keys WHERE runtime_key_id = ? AND account_id = ? AND revoked_at IS NOT NULL")
      .run(input.keyId, input.accountId);
    return { status: 200 as const, body: { deleted: true as const } };
  }).immediate();
}

const SignatureSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, "65-byte ECDSA signature");

const RuntimeKeyChallengeSchema = z.object({
  policy: RuntimeKeyPolicySchema.default({}),
  expires_at: z.string().datetime({ offset: false }).optional(),
});

const RuntimeKeyMintSchema = RuntimeKeyChallengeSchema.extend({
  label: z.string().max(80).optional(),
  authorization_nonce: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,80}$/, "16-80 chars of base64url-ish entropy"),
  authorization_issued_at: z.string().datetime({ offset: false }),
  signature: SignatureSchema,
});

const RuntimeKeyRevokeSchema = z.object({
  reason: z.string().max(160).optional(),
});

function throwInvalidRequest(issues: z.ZodIssue[]): never {
  throw new VerdictError(
    "invalid request",
    ERROR_CODES.schema_invalid,
    400,
    { issues },
  );
}
