import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface ApiKeyRow {
  api_key_id: string;
  account_id: string;
  agent_id: string;
  api_key_hash: string;
  label: string | null;
  created_at: string;
  rotated_at: string | null;
}

export interface MintApiKeyResult {
  api_key_id: string;
  /** Plaintext secret. Returned ONCE - caller MUST hand to the user and not persist. */
  secret: string;
  created_at: string;
}

export interface MintApiKeyInput {
  account_id: string;
  agent_id: string;
  label?: string | null;
  newApiKeyId?: () => string;
  newApiKeySecret?: () => string;
  createdAt: Date;
}

export interface RotateApiKeyInput {
  api_key_id: string;
  rotatedAt: Date;
}

export interface RotateApiKeyForAccountInput extends RotateApiKeyInput {
  account_id: string;
}

function stripIso(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function newApiKeySecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Mint a new API key for the (account, agent) pair. Generates 32 random
 * bytes, hex-encodes (64 chars), stores sha256 of the hex string. Returns
 * the plaintext exactly once.
 */
export function mintApiKey(
  db: Database.Database,
  input: MintApiKeyInput,
): MintApiKeyResult {
  const secret = (input.newApiKeySecret ?? newApiKeySecret)();
  const api_key_id = (input.newApiKeyId ?? randomUUID)();
  const created_at = stripIso(input.createdAt);
  db.prepare(
    `INSERT INTO api_keys (
       api_key_id, account_id, agent_id, api_key_hash,
       label, created_at, rotated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    api_key_id,
    input.account_id,
    input.agent_id,
    hashApiKeySecret(secret),
    input.label ?? null,
    created_at,
  );
  return { api_key_id, secret, created_at };
}

export function verifyApiKey(
  db: Database.Database,
  secret: string,
): { account_id: string; agent_id: string; api_key_id: string } | null {
  if (typeof secret !== "string" || secret.length < 16) {
    return null;
  }
  const hash = hashApiKeySecret(secret);
  const row = db
    .prepare(
      `SELECT api_key_id, account_id, agent_id, api_key_hash
       FROM api_keys
       WHERE api_key_hash = ? AND rotated_at IS NULL`,
    )
    .get(hash) as
    | { api_key_id: string; account_id: string; agent_id: string; api_key_hash: string }
    | undefined;
  if (!row) {
    return null;
  }
  const a = Buffer.from(row.api_key_hash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  return {
    account_id: row.account_id,
    agent_id: row.agent_id,
    api_key_id: row.api_key_id,
  };
}

export function rotateApiKey(
  db: Database.Database,
  input: RotateApiKeyInput,
): boolean {
  const result = db
    .prepare(
      "UPDATE api_keys SET rotated_at = ? WHERE api_key_id = ? AND rotated_at IS NULL",
    )
    .run(stripIso(input.rotatedAt), input.api_key_id);
  return result.changes > 0;
}

export function rotateApiKeyForAccount(
  db: Database.Database,
  input: RotateApiKeyForAccountInput,
): boolean | null {
  const existing = db
    .prepare(
      "SELECT rotated_at FROM api_keys WHERE account_id = ? AND api_key_id = ?",
    )
    .get(input.account_id, input.api_key_id) as
    | { rotated_at: string | null }
    | undefined;
  if (!existing) {
    return null;
  }
  if (existing.rotated_at) {
    return false;
  }
  const result = db
    .prepare(
      `UPDATE api_keys
          SET rotated_at = ?
       WHERE account_id = ? AND api_key_id = ? AND rotated_at IS NULL`,
    )
    .run(stripIso(input.rotatedAt), input.account_id, input.api_key_id);
  return result.changes > 0;
}

export function listApiKeysForAccount(
  db: Database.Database,
  account_id: string,
  includeRotated = false,
): Array<Omit<ApiKeyRow, "api_key_hash">> {
  const sql = includeRotated
    ? `SELECT api_key_id, account_id, agent_id, label, created_at, rotated_at
       FROM api_keys WHERE account_id = ?
       ORDER BY created_at DESC`
    : `SELECT api_key_id, account_id, agent_id, label, created_at, rotated_at
       FROM api_keys WHERE account_id = ? AND rotated_at IS NULL
       ORDER BY created_at DESC`;
  return db.prepare(sql).all(account_id) as Array<
    Omit<ApiKeyRow, "api_key_hash">
  >;
}

export function listApiKeysForAccountAgent(
  db: Database.Database,
  account_id: string,
  agent_id: string,
  includeRotated = false,
): Array<Omit<ApiKeyRow, "api_key_hash">> {
  const sql = includeRotated
    ? `SELECT api_key_id, account_id, agent_id, label, created_at, rotated_at
       FROM api_keys WHERE account_id = ? AND agent_id = ?
       ORDER BY created_at DESC`
    : `SELECT api_key_id, account_id, agent_id, label, created_at, rotated_at
       FROM api_keys WHERE account_id = ? AND agent_id = ? AND rotated_at IS NULL
       ORDER BY created_at DESC`;
  return db.prepare(sql).all(account_id, agent_id) as Array<
    Omit<ApiKeyRow, "api_key_hash">
  >;
}
