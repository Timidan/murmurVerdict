import type Database from "better-sqlite3";
import { z } from "zod";

import { requireOwnedAgentBySlug } from "./agent-identity.js";
import {
  assertAgentCredentialsEnabled,
  listApiKeysForAccountAgent,
  mintApiKey,
  rotateApiKeyForAccount,
} from "./auth/accounts.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

const MintKeySchema = z.object({
  label: z.string().max(80).optional(),
});

export interface AccountApiKeySurfaceBase {
  db: Database.Database;
  accountId: string;
}

export interface AccountApiKeyWriteClock {
  operationInstant: Date;
}

export interface AccountApiKeyJsonResponse {
  status: 200 | 201;
  body: unknown;
}

export interface AccountApiKeyJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendAccountApiKeyJsonResponse(
  res: AccountApiKeyJsonResponseTarget,
  result: AccountApiKeyJsonResponse,
): void {
  res.status(result.status).json(result.body);
}

export function listAgentApiKeysResponse(input: AccountApiKeySurfaceBase & {
  slug: string;
}): {
  status: 200;
  body: {
    keys: Array<{
      api_key_id: string;
      created_at: string;
      label: string | null;
      rotated_at: string | null;
    }>;
  };
} {
  const agent = requireOwnedAgentBySlug(input.db, input.accountId, input.slug);
  const keys = listApiKeysForAccountAgent(
    input.db,
    input.accountId,
    agent.agent_id,
    true,
  ).map((key) => ({
    api_key_id: key.api_key_id,
    created_at: key.created_at,
    label: key.label,
    rotated_at: key.rotated_at,
  }));
  return { status: 200, body: { keys } };
}

export function mintAgentApiKeyResponse(
  input: AccountApiKeySurfaceBase & AccountApiKeyWriteClock & {
    slug: string;
    body: unknown;
    newApiKeyId?: () => string;
    newApiKeySecret?: () => string;
  },
): {
  status: 201;
  body: {
    api_key_id: string;
    secret: string;
    created_at: string;
    warning: string;
  };
} {
  assertAgentCredentialsEnabled(input.db, input.accountId);
  const agent = requireOwnedAgentBySlug(input.db, input.accountId, input.slug);
  const parsed = MintKeySchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throw new VerdictError(
      "invalid request",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.issues },
    );
  }
  const minted = mintApiKey(input.db, {
    account_id: input.accountId,
    agent_id: agent.agent_id,
    label: parsed.data.label,
    newApiKeyId: input.newApiKeyId,
    newApiKeySecret: input.newApiKeySecret,
    createdAt: input.operationInstant,
  });
  return {
    status: 201,
    body: {
      api_key_id: minted.api_key_id,
      secret: minted.secret,
      created_at: minted.created_at,
      warning: "store this secret now — it is not retrievable later",
    },
  };
}

export function rotateAccountApiKeyResponse(
  input: AccountApiKeySurfaceBase & AccountApiKeyWriteClock & {
    keyId: string;
  },
): {
  status: 200;
  body: {
    rotated: boolean;
  };
} {
  const rotated = rotateApiKeyForAccount(input.db, {
    account_id: input.accountId,
    api_key_id: input.keyId,
    rotatedAt: input.operationInstant,
  });
  if (rotated === null) {
    throw new VerdictError(
      "api key not owned by this account",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
  return { status: 200, body: { rotated } };
}
