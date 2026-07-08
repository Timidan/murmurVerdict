import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { z } from "zod";

import {
  assertFreshAuthorization,
  controllerWalletReattestationConstants,
  publicControllerWalletRow,
  requireControllerWalletForAgent,
  requireOwnedAgentBySlug,
} from "./agent-identity.js";
import {
  bindControllerWallet,
  ControllerWalletBindingError,
  ControllerWalletReattestationReplayError,
  controllerWalletAttestationStatus,
  getControllerWalletForAgent,
  recordControllerWalletReattestation,
  type ControllerWalletReattestationIdAdapter,
} from "./auth/accounts.js";
import {
  verifySignedMessageAddress,
  type ControllerWalletKind,
} from "./controller-wallet.js";
import {
  makeControllerWalletBindingAuthorization,
  makeControllerWalletReattestationAuthorization,
  type ControllerWalletAuthorizationNonceAdapter,
} from "./controller-wallet-authorization.js";
import {
  ChainIdSchema,
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

export interface AccountControllerWalletSurfaceBase {
  db: Database.Database;
  accountId: string;
}

export interface AccountControllerWalletOperationClock {
  now: () => Date;
}

export interface AccountControllerWalletJsonResponse {
  status: 200;
  body: unknown;
}

export interface AccountControllerWalletJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendAccountControllerWalletJsonResponse(
  res: AccountControllerWalletJsonResponseTarget,
  result: AccountControllerWalletJsonResponse,
): void {
  res.status(result.status).json(result.body);
}

export type ControllerWalletSignatureVerifier = (
  expectedAddress: string,
  message: string,
  signature: Hex,
) => Promise<boolean>;

export function controllerWalletChallengeResponse(
  input: AccountControllerWalletSurfaceBase & AccountControllerWalletOperationClock & {
    slug: string;
    body: unknown;
  },
): {
  status: 200;
  body: {
    agent_id: string;
    display_slug: string;
    wallet_address: string;
    chain_id: string;
    wallet_kind: ControllerWalletKind;
    provider: string | null;
    authorization_issued_at: string;
    message: string;
  };
} {
  const agent = requireOwnedAgentBySlug(input.db, input.accountId, input.slug);
  const parsed = BindWalletChallengeSchema.safeParse(input.body);
  if (!parsed.success) {
    throwInvalidRequest(parsed.error.issues);
  }
  const authorization = makeControllerWalletBindingAuthorization({
    agentSlug: agent.display_slug,
    walletAddress: parsed.data.wallet_address,
    chainId: parsed.data.chain_id,
    walletKind: parsed.data.wallet_kind,
    provider: parsed.data.provider,
    now: input.now,
  });
  return {
    status: 200,
    body: {
      agent_id: agent.agent_id,
      display_slug: agent.display_slug,
      wallet_address: authorization.wallet_address,
      chain_id: authorization.chain_id,
      wallet_kind: authorization.wallet_kind,
      provider: authorization.provider,
      authorization_issued_at: authorization.authorization_issued_at,
      message: authorization.message,
    },
  };
}

export async function bindControllerWalletResponse(
  input: AccountControllerWalletSurfaceBase & AccountControllerWalletOperationClock & {
    slug: string;
    body: unknown;
    verifySignature?: ControllerWalletSignatureVerifier;
  },
): Promise<{
  status: 200;
  body: ReturnType<typeof publicControllerWalletRow> & {
    agent_id: string;
    display_slug: string;
    idempotent_hit: boolean;
  };
}> {
  const agent = requireOwnedAgentBySlug(input.db, input.accountId, input.slug);
  const parsed = BindWalletSchema.safeParse(input.body);
  if (!parsed.success) {
    throwInvalidRequest(parsed.error.issues);
  }
  const operationNow = input.now();
  const operationClock = () => operationNow;
  assertFreshAuthorization(parsed.data.authorization_issued_at, operationClock);
  const authorization = makeControllerWalletBindingAuthorization({
    agentSlug: agent.display_slug,
    walletAddress: parsed.data.wallet_address,
    chainId: parsed.data.chain_id,
    walletKind: parsed.data.wallet_kind,
    provider: parsed.data.provider,
    issuedAt: parsed.data.authorization_issued_at,
    now: operationClock,
  });
  const signatureOk = await (input.verifySignature ?? verifySignedMessageAddress)(
    authorization.wallet_address,
    authorization.message,
    parsed.data.signature as Hex,
  );
  if (!signatureOk) {
    throw new VerdictError(
      "controller wallet signature does not match wallet_address",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }

  let bound: ReturnType<typeof bindControllerWallet>;
  try {
    bound = bindControllerWallet(input.db, {
      account_id: input.accountId,
      agent_id: agent.agent_id,
      wallet_address: authorization.wallet_address,
      chain_id: authorization.chain_id,
      wallet_kind: authorization.wallet_kind,
      provider: authorization.provider ?? undefined,
      binding_message: authorization.message,
      binding_signature: parsed.data.signature,
      createdAt: operationNow,
    });
  } catch (err) {
    if (err instanceof ControllerWalletBindingError) {
      throw new VerdictError(err.message, ERROR_CODES.duplicate, 409, {
        agent_id: agent.agent_id,
      });
    }
    throw err;
  }

  return {
    status: 200,
    body: {
      agent_id: agent.agent_id,
      display_slug: agent.display_slug,
      ...publicControllerWalletRow(bound, operationClock),
      idempotent_hit: bound.idempotent_hit,
    },
  };
}

export function controllerWalletReattestationChallengeResponse(
  input: AccountControllerWalletSurfaceBase & AccountControllerWalletOperationClock & {
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
    attestation_nonce: string;
    authorization_issued_at: string;
    previous_last_attested_at: string;
    previous_reattestation_due_at: string;
    reattestation_interval_seconds: number;
    message: string;
  };
} {
  const agent = requireOwnedAgentBySlug(input.db, input.accountId, input.slug);
  const controller = requireControllerWalletForAgent(
    input.db,
    agent.agent_id,
    "bind a controller wallet before re-attesting",
  );
  const parsed = z.object({}).strict().safeParse(input.body ?? {});
  if (!parsed.success) {
    throwInvalidRequest(parsed.error.issues);
  }
  const operationNow = input.now();
  const operationClock = () => operationNow;
  const authorization = makeControllerWalletReattestationAuthorization({
    agentSlug: agent.display_slug,
    controllerWalletAddress: controller.wallet_address,
    controllerChainId: controller.chain_id,
    newAuthorizationNonce: input.newAuthorizationNonce,
    now: operationClock,
  });
  const status = controllerWalletAttestationStatus(controller, {
    checkedAt: operationNow,
  });
  return {
    status: 200,
    body: {
      agent_id: agent.agent_id,
      display_slug: agent.display_slug,
      controller_wallet_address: authorization.controller_wallet_address,
      controller_chain_id: authorization.controller_chain_id,
      attestation_nonce: authorization.attestation_nonce,
      authorization_issued_at: authorization.authorization_issued_at,
      previous_last_attested_at: status.last_attested_at,
      previous_reattestation_due_at: status.reattestation_due_at,
      ...controllerWalletReattestationConstants(),
      message: authorization.message,
    },
  };
}

export async function reattestControllerWalletResponse(
  input: AccountControllerWalletSurfaceBase & AccountControllerWalletOperationClock & {
    slug: string;
    body: unknown;
    newReattestationId?: ControllerWalletReattestationIdAdapter;
    verifySignature?: ControllerWalletSignatureVerifier;
  },
): Promise<{
  status: 200;
  body: {
    agent_id: string;
    display_slug: string;
    attestation_id: string;
    controller_wallet: ReturnType<typeof publicControllerWalletRow> | null;
  };
}> {
  const agent = requireOwnedAgentBySlug(input.db, input.accountId, input.slug);
  const controller = requireControllerWalletForAgent(
    input.db,
    agent.agent_id,
    "bind a controller wallet before re-attesting",
  );
  const parsed = ReattestWalletSchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throwInvalidRequest(parsed.error.issues);
  }
  const operationNow = input.now();
  const operationClock = () => operationNow;
  assertFreshAuthorization(parsed.data.authorization_issued_at, operationClock);
  const authorization = makeControllerWalletReattestationAuthorization({
    agentSlug: agent.display_slug,
    controllerWalletAddress: controller.wallet_address,
    controllerChainId: controller.chain_id,
    attestationNonce: parsed.data.attestation_nonce,
    issuedAt: parsed.data.authorization_issued_at,
    now: operationClock,
  });
  const signatureOk = await (input.verifySignature ?? verifySignedMessageAddress)(
    controller.wallet_address,
    authorization.message,
    parsed.data.signature as Hex,
  );
  if (!signatureOk) {
    throw new VerdictError(
      "controller wallet re-attestation signature does not match wallet",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }

  let attestation: ReturnType<typeof recordControllerWalletReattestation>;
  try {
    attestation = recordControllerWalletReattestation(input.db, {
      account_id: input.accountId,
      agent_id: agent.agent_id,
      wallet_address: controller.wallet_address,
      chain_id: controller.chain_id,
      attestation_nonce: parsed.data.attestation_nonce,
      attestation_message: authorization.message,
      attestation_signature: parsed.data.signature,
      attestedAt: operationNow,
      newReattestationId: input.newReattestationId,
    });
  } catch (err) {
    if (err instanceof ControllerWalletBindingError) {
      throw new VerdictError(err.message, ERROR_CODES.agent_not_authorized, 409);
    }
    if (err instanceof ControllerWalletReattestationReplayError) {
      throw new VerdictError(err.message, ERROR_CODES.duplicate, 409);
    }
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      throw new VerdictError(
        "controller wallet re-attestation nonce already used",
        ERROR_CODES.duplicate,
        409,
      );
    }
    throw err;
  }

  const refreshed = getControllerWalletForAgent(input.db, agent.agent_id);
  return {
    status: 200,
    body: {
      agent_id: agent.agent_id,
      display_slug: agent.display_slug,
      attestation_id: attestation.attestation_id,
      controller_wallet: refreshed
        ? publicControllerWalletRow(refreshed, operationClock)
        : null,
    },
  };
}

const SignatureSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, "65-byte ECDSA signature");

const ControllerWalletKindSchema = z.enum(["embedded", "external"]);

const BindWalletSchema = z.object({
  wallet_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chain_id: ChainIdSchema,
  wallet_kind: ControllerWalletKindSchema.default("embedded"),
  provider: z.string().min(1).max(64).optional(),
  authorization_issued_at: z.string().datetime({ offset: false }),
  signature: SignatureSchema,
});

const BindWalletChallengeSchema = z.object({
  wallet_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chain_id: ChainIdSchema,
  wallet_kind: ControllerWalletKindSchema.default("embedded"),
  provider: z.string().min(1).max(64).optional(),
});

const ReattestWalletSchema = z.object({
  attestation_nonce: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,80}$/, "16-80 chars of base64url-ish entropy"),
  authorization_issued_at: z.string().datetime({ offset: false }),
  signature: SignatureSchema,
});

function throwInvalidRequest(issues: z.ZodIssue[]): never {
  throw new VerdictError(
    "invalid request",
    ERROR_CODES.schema_invalid,
    400,
    { issues },
  );
}
