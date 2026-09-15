import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isControllerWalletAttestationCurrent } from "./controller-wallets.js";

export interface RuntimeKeyRow {
  runtime_key_id: string;
  account_id: string;
  agent_id: string;
  runtime_key_prefix: string;
  label: string | null;
  policy_json: string;
  policy_hash: string;
  controller_wallet_address: string;
  controller_chain_id: string;
  authorization_nonce: string;
  authorization_message: string;
  authorization_signature: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  last_heartbeat_at: string | null;
  last_contact_at: string | null;
  runtime_mode: "interactive" | "continuous";
}

export interface MintRuntimeKeyResult {
  runtime_key_id: string;
  /** Plaintext runtime key. Returned ONCE - caller MUST hand to the user and not persist. */
  secret: string;
  runtime_key_prefix: string;
  created_at: string;
}

export interface RuntimeKeyVerification {
  runtime_key_id: string;
  account_id: string;
  agent_id: string;
  runtime_key_prefix: string;
  policy_json: string;
  policy_hash: string;
  controller_wallet_address: string;
  controller_chain_id: string;
  expires_at: string | null;
  /**
   * True when the dispatcher verified a murmur-rk-v2 PoP signature for this
   * request. Set by dispatchAuth AFTER verification, never read from the DB;
   * bearer-only keys carry false. Persisted onto gateway attempt rows as
   * auth_proof so acceptance-time audit attribution reflects reality.
   */
  signature_verified?: boolean;
}

export interface VerifyRuntimeKeyInput {
  secret: string;
  verifiedAt: Date;
}

export interface RuntimeKeyMintAdapters {
  newRuntimeKeyId?: () => string;
  newRuntimeKeySecret?: () => string;
}

export interface RuntimeKeyActiveInput {
  runtime_key_id: string;
  checkedAt: Date;
}

export class RuntimeKeyAuthorizationReplayError extends Error {
  readonly code = "runtime_key_authorization_replay" as const;
  constructor(agent_id: string) {
    super(`runtime key authorization already used for agent ${agent_id}`);
    this.name = "RuntimeKeyAuthorizationReplayError";
  }
}

function stripIso(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function hashRuntimeKeySecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function newRuntimeKeySecret(): string {
  return `mrt_${randomBytes(32).toString("hex")}`;
}

function runtimeKeyPrefix(secret: string): string {
  return secret.slice(0, 12);
}

export function mintRuntimeKey(
  db: Database.Database,
  input: {
    account_id: string;
    agent_id: string;
    label?: string | null;
    policy_json: string;
    policy_hash: string;
    controller_wallet_address: string;
    controller_chain_id: string;
    authorization_nonce: string;
    authorization_message: string;
    authorization_signature: string;
    expires_at?: string | null;
    createdAt: Date;
  } & RuntimeKeyMintAdapters,
): MintRuntimeKeyResult {
  const replay = db
    .prepare(
      `SELECT runtime_key_id
       FROM agent_runtime_keys
       WHERE agent_id = ? AND authorization_message = ?
       LIMIT 1`,
    )
    .get(input.agent_id, input.authorization_message);
  if (replay) {
    throw new RuntimeKeyAuthorizationReplayError(input.agent_id);
  }
  const secret = (input.newRuntimeKeySecret ?? newRuntimeKeySecret)();
  const runtime_key_id = (input.newRuntimeKeyId ?? randomUUID)();
  const runtime_key_prefix = runtimeKeyPrefix(secret);
  const created_at = stripIso(input.createdAt);
  try {
    db.prepare(
      `INSERT INTO agent_runtime_keys (
         runtime_key_id, account_id, agent_id, runtime_key_hash,
         runtime_key_prefix, label, policy_json, policy_hash,
         controller_wallet_address, controller_chain_id,
         authorization_nonce, authorization_message, authorization_signature,
         created_at, expires_at, revoked_at, revoke_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      runtime_key_id,
      input.account_id,
      input.agent_id,
      hashRuntimeKeySecret(secret),
      runtime_key_prefix,
      input.label ?? null,
      input.policy_json,
      input.policy_hash,
      input.controller_wallet_address,
      input.controller_chain_id,
      input.authorization_nonce,
      input.authorization_message,
      input.authorization_signature,
      created_at,
      input.expires_at ?? null,
    );
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
      /agent_runtime_keys.+authorization_message/i.test(err.message)
    ) {
      throw new RuntimeKeyAuthorizationReplayError(input.agent_id);
    }
    throw err;
  }
  return {
    runtime_key_id,
    secret,
    runtime_key_prefix: runtimeKeyPrefix(secret),
    created_at,
  };
}

export function listRuntimeKeysForAccountAgent(
  db: Database.Database,
  account_id: string,
  agent_id: string,
  includeRevoked = true,
): RuntimeKeyRow[] {
  const sql = includeRevoked
    ? `SELECT runtime_key_id, account_id, agent_id, runtime_key_prefix, label,
              policy_json, policy_hash, controller_wallet_address,
              controller_chain_id, authorization_nonce, authorization_message,
              authorization_signature, created_at, expires_at, revoked_at,
              revoke_reason, last_heartbeat_at, last_contact_at, runtime_mode
       FROM agent_runtime_keys
       WHERE account_id = ? AND agent_id = ?
       ORDER BY created_at DESC`
    : `SELECT runtime_key_id, account_id, agent_id, runtime_key_prefix, label,
              policy_json, policy_hash, controller_wallet_address,
              controller_chain_id, authorization_nonce, authorization_message,
              authorization_signature, created_at, expires_at, revoked_at,
              revoke_reason, last_heartbeat_at, last_contact_at, runtime_mode
       FROM agent_runtime_keys
       WHERE account_id = ? AND agent_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`;
  return db.prepare(sql).all(account_id, agent_id) as RuntimeKeyRow[];
}

/** Record a verified runtime process presence. The caller owns authentication. */
export function recordRuntimeKeyHeartbeat(
  db: Database.Database,
  input: {
    runtime_key_id: string;
    account_id: string;
    agent_id: string;
    observedAt: Date;
    runtime_mode: RuntimeKeyRow["runtime_mode"];
  },
): boolean {
  const result = db.prepare(
    `UPDATE agent_runtime_keys
        SET last_heartbeat_at = ?, last_contact_at = ?, runtime_mode = ?
      WHERE runtime_key_id = ? AND account_id = ? AND agent_id = ?`,
  ).run(
    stripIso(input.observedAt),
    stripIso(input.observedAt),
    input.runtime_mode,
    input.runtime_key_id,
    input.account_id,
    input.agent_id,
  );
  return result.changes === 1;
}

export function revokeRuntimeKey(
  db: Database.Database,
  input: {
    account_id: string;
    runtime_key_id: string;
    reason?: string | null;
    revokedAt: Date;
  },
): boolean {
  const revoked_at = stripIso(input.revokedAt);
  const result = db
    .prepare(
      `UPDATE agent_runtime_keys
       SET revoked_at = ?, revoke_reason = ?
       WHERE account_id = ? AND runtime_key_id = ? AND revoked_at IS NULL`,
    )
    .run(
      revoked_at,
      input.reason ?? null,
      input.account_id,
      input.runtime_key_id,
    );
  return result.changes > 0;
}

export function verifyRuntimeKey(
  db: Database.Database,
  input: VerifyRuntimeKeyInput,
): RuntimeKeyVerification | null {
  if (
    typeof input.secret !== "string" ||
    !/^mrt_[0-9a-f]{64}$/.test(input.secret)
  ) {
    return null;
  }
  const hash = hashRuntimeKeySecret(input.secret);
  const row = db
    .prepare(
      `SELECT runtime_key_id, account_id, agent_id, runtime_key_hash,
              runtime_key_prefix, policy_json, policy_hash,
              controller_wallet_address, controller_chain_id,
              expires_at, revoked_at
       FROM agent_runtime_keys
       WHERE runtime_key_hash = ?`,
    )
    .get(hash) as
    | (RuntimeKeyVerification & {
        runtime_key_hash: string;
        revoked_at: string | null;
      })
    | undefined;
  if (!row) {
    return null;
  }
  const a = Buffer.from(row.runtime_key_hash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  if (row.revoked_at) {
    return null;
  }
  if (row.expires_at) {
    const expiresMs = Date.parse(row.expires_at);
    if (
      !Number.isFinite(expiresMs) ||
      expiresMs <= input.verifiedAt.getTime()
    ) {
      return null;
    }
  }
  if (
    !isControllerWalletAttestationCurrent(db, {
      agent_id: row.agent_id,
      checkedAt: input.verifiedAt,
    })
  ) {
    return null;
  }
  return {
    runtime_key_id: row.runtime_key_id,
    account_id: row.account_id,
    agent_id: row.agent_id,
    runtime_key_prefix: row.runtime_key_prefix,
    policy_json: row.policy_json,
    policy_hash: row.policy_hash,
    controller_wallet_address: row.controller_wallet_address,
    controller_chain_id: row.controller_chain_id,
    expires_at: row.expires_at,
  };
}

export function isRuntimeKeyActive(
  db: Database.Database,
  input: RuntimeKeyActiveInput,
): boolean {
  const row = db
    .prepare(
      `SELECT agent_id, expires_at, revoked_at
       FROM agent_runtime_keys
       WHERE runtime_key_id = ?`,
    )
    .get(input.runtime_key_id) as
    | {
        agent_id: string;
        expires_at: string | null;
        revoked_at: string | null;
      }
    | undefined;
  if (!row || row.revoked_at) return false;
  if (
    !isControllerWalletAttestationCurrent(db, {
      agent_id: row.agent_id,
      checkedAt: input.checkedAt,
    })
  ) {
    return false;
  }
  if (!row.expires_at) return true;
  const expiresMs = Date.parse(row.expires_at);
  return (
    Number.isFinite(expiresMs) &&
    expiresMs > input.checkedAt.getTime()
  );
}
