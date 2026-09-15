// ─── Runtime-key proof-of-possession (murmur-rk-v2) ──────────────────────────
// A key whose signed policy carries `signing_pubkey` needs a per-request Ed25519 signature,
// from a private key only the agent host holds, over:
//
//   murmur-rk-v2\n<audience>\n<runtime_key_id>\n<timestamp>\n<nonce>\n
//   <METHOD>\n<path-and-query>\n<raw-body-sha256>
//
//   - Audience is a configured deployment id, never the Host header.
//   - runtime_key_id stops reuse across keys that share a keypair.
//   - The nonce is signed, so it cannot be swapped; v1 is rejected.
//   - The body hash covers the raw bytes, not a re-serialized req.body.
//   - Replay: bounded skew, each (runtime_key_id, nonce) consumed once, retention > max skew.

import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import type Database from "better-sqlite3";

import { ERROR_CODES, VerdictError } from "../schema.js";

export const RUNTIME_KEY_POP_VERSION = "murmur-rk-v2";
export const RUNTIME_KEY_POP_MAX_SKEW_SECONDS = 120;
export const RUNTIME_KEY_POP_NONCE_RETENTION_SECONDS = 600;

export const POP_HEADER_TIMESTAMP = "X-Murmur-Key-Timestamp";
export const POP_HEADER_NONCE = "X-Murmur-Key-Nonce";
export const POP_HEADER_SIGNATURE = "X-Murmur-Key-Signature";

/** sha256 of zero bytes — the raw-body hash of a bodyless request. */
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** 32-byte Ed25519 public key as 64 lowercase hex chars. */
const PUBKEY_RE = /^[0-9a-f]{64}$/;
/** 64-byte Ed25519 signature as 128 lowercase hex chars. */
const SIGNATURE_RE = /^[0-9a-f]{128}$/;
/** 128-bit request nonce as 32 lowercase hex chars. */
const NONCE_RE = /^[0-9a-f]{32}$/;

export interface RuntimeKeyPopRequestContext {
  method: string;
  /** Path + query exactly as requested, e.g. `/v2/gateway/calls?x=1`. */
  pathAndQuery: string;
  /** Lowercase hex sha256 of the raw request body bytes ('' body → e3b0c…). */
  rawBodySha256: string;
  timestampHeader: string | undefined;
  nonceHeader: string | undefined;
  signatureHeader: string | undefined;
}

export function buildRuntimeKeyPopSigningString(input: {
  audience: string;
  runtimeKeyId: string;
  timestamp: number;
  /** Normalized lowercase 32-hex request nonce. */
  nonce: string;
  method: string;
  pathAndQuery: string;
  rawBodySha256: string;
}): string {
  return [
    RUNTIME_KEY_POP_VERSION,
    input.audience,
    input.runtimeKeyId,
    String(input.timestamp),
    input.nonce,
    input.method.toUpperCase(),
    input.pathAndQuery,
    input.rawBodySha256,
  ].join("\n");
}

// RFC 8410 SPKI prefix for an Ed25519 raw public key. Node 20 has no raw
// ed25519 import, so wrap the 32 raw bytes in DER ourselves.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519PublicKeyFromHex(pubkeyHex: string) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubkeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
}

function popError(message: string, context?: Record<string, unknown>): VerdictError {
  return new VerdictError(
    message,
    ERROR_CODES.runtime_key_signature_invalid,
    401,
    context,
  );
}

/**
 * Verify (and consume the nonce of) a PoP-bound runtime-key request.
 * Throws VerdictError(runtime_key_signature_invalid, 401) on ANY defect —
 * callers must not catch-and-fall-through; PoP keys fail closed.
 */
export function verifyRuntimeKeyPop(
  db: Database.Database,
  input: {
    runtimeKeyId: string;
    signingPubkeyHex: string;
    audience: string;
    request: RuntimeKeyPopRequestContext;
    now: Date;
  },
): void {
  const { request } = input;
  if (!PUBKEY_RE.test(input.signingPubkeyHex)) {
    throw popError("runtime key policy signing_pubkey is malformed");
  }
  if (!request.timestampHeader || !request.nonceHeader || !request.signatureHeader) {
    throw popError(
      `PoP-bound runtime key requires ${POP_HEADER_TIMESTAMP}, ${POP_HEADER_NONCE}, and ${POP_HEADER_SIGNATURE} headers`,
    );
  }
  if (!/^\d{1,12}$/.test(request.timestampHeader)) {
    throw popError("PoP timestamp header must be unix seconds");
  }
  const timestamp = Number(request.timestampHeader);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > RUNTIME_KEY_POP_MAX_SKEW_SECONDS) {
    throw popError("PoP timestamp outside freshness window", {
      max_skew_seconds: RUNTIME_KEY_POP_MAX_SKEW_SECONDS,
    });
  }
  const nonce = request.nonceHeader.toLowerCase();
  if (!NONCE_RE.test(nonce)) {
    throw popError("PoP nonce must be 32 lowercase hex chars (128 bits)");
  }
  const signatureHex = request.signatureHeader.toLowerCase();
  if (!SIGNATURE_RE.test(signatureHex)) {
    throw popError("PoP signature must be 128 lowercase hex chars");
  }

  const signingString = buildRuntimeKeyPopSigningString({
    audience: input.audience,
    runtimeKeyId: input.runtimeKeyId,
    timestamp,
    nonce,
    method: request.method,
    pathAndQuery: request.pathAndQuery,
    rawBodySha256: request.rawBodySha256,
  });

  let valid = false;
  try {
    valid = ed25519Verify(
      null,
      Buffer.from(signingString, "utf8"),
      ed25519PublicKeyFromHex(input.signingPubkeyHex),
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw popError("PoP signature verification failed");
  }

  // Consume the nonce LAST so a request rejected earlier never burns it.
  // Prune expired rows in the same transaction; the PK rejects replays.
  const consumeNonce = db.transaction(() => {
    db.prepare(
      `DELETE FROM agent_runtime_key_nonces WHERE seen_at < ?`,
    ).run(
      new Date(
        input.now.getTime() - RUNTIME_KEY_POP_NONCE_RETENTION_SECONDS * 1000,
      ).toISOString(),
    );
    db.prepare(
      `INSERT INTO agent_runtime_key_nonces (runtime_key_id, nonce, seen_at)
       VALUES (?, ?, ?)`,
    ).run(input.runtimeKeyId, nonce, input.now.toISOString());
  });
  try {
    consumeNonce.immediate();
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    ) {
      throw popError("PoP nonce already used (replay)");
    }
    throw err;
  }
}

/** Read the optional PoP pubkey out of an already-parsed gateway policy. */
export function signingPubkeyFromPolicy(policy: unknown): string | null {
  if (
    policy !== null &&
    typeof policy === "object" &&
    "signing_pubkey" in policy &&
    typeof (policy as { signing_pubkey?: unknown }).signing_pubkey === "string"
  ) {
    return (policy as { signing_pubkey: string }).signing_pubkey;
  }
  return null;
}
