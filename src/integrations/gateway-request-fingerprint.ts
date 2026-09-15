// ─── Gateway request fingerprints (murmur-idem-v1) ───────────────────────────
// Any changed parameter = a new request: duplicate exits compare the reserving request's
// fingerprint (canonical validated body, domain-prefixed by route kind and feed id) with
// the replay's; a mismatch is 409. Owned sealing HMACs the original body before sealing.
// Null legacy fingerprints are non-comparable.

import { createHash, createHmac } from "node:crypto";

import { canonicalize } from "../receipts/canonical.js";
import { ERROR_CODES, VerdictError } from "../verdict/schema.js";

export type GatewayFingerprintRouteKind =
  | "sealed_call"
  | "owned_sealed_call"
  | "feed_packet";

export interface GatewayFingerprintHmacKey {
  id: string;
  key: Buffer;
}

export interface GatewayFingerprintHmacKeyring {
  active: GatewayFingerprintHmacKey;
  previous: readonly GatewayFingerprintHmacKey[];
}

export interface GatewayRequestFingerprintOptions {
  feedId?: string;
  hmacKeyring?: GatewayFingerprintHmacKeyring;
}

export interface GatewayRequestFingerprints {
  stored: string;
  comparisons: readonly string[];
}

const HMAC_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseGatewayFingerprintHmacKeyring(
  input: string | null | undefined,
): GatewayFingerprintHmacKeyring | null {
  const raw = input?.trim();
  if (!raw) return null;
  const entries = raw.split(",").map((entry) => entry.trim());
  const keys: GatewayFingerprintHmacKey[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    const id = separator === -1 ? "" : entry.slice(0, separator);
    const keyHex = separator === -1 ? "" : entry.slice(separator + 1);
    if (!HMAC_KEY_ID.test(id)) {
      throw new Error(
        "entries must use key-id:64-hex-key with a 1-64 character key id",
      );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error(`key '${id}' must be exactly 256 bits encoded as 64 hex characters`);
    }
    if (ids.has(id)) {
      throw new Error(`duplicate key id '${id}'`);
    }
    ids.add(id);
    keys.push({ id, key: Buffer.from(keyHex, "hex") });
  }
  return { active: keys[0], previous: keys.slice(1) };
}

function fingerprintInput(
  routeKind: GatewayFingerprintRouteKind,
  parsedBody: unknown,
  opts?: GatewayRequestFingerprintOptions,
): string {
  const domain = ["murmur-idem-v1", routeKind];
  if (opts?.feedId) domain.push(opts.feedId);
  return `${domain.join("\n")}\n${canonicalize(parsedBody)}`;
}

export function gatewayRequestFingerprints(
  routeKind: GatewayFingerprintRouteKind,
  parsedBody: unknown,
  opts?: GatewayRequestFingerprintOptions,
): GatewayRequestFingerprints {
  const input = fingerprintInput(routeKind, parsedBody, opts);
  if (routeKind === "owned_sealed_call") {
    const ring = opts?.hmacKeyring;
    if (!ring) {
      throw new Error(
        "MURMUR_GATEWAY_FINGERPRINT_HMAC_KEYS is required for Murmur-owned sealing",
      );
    }
    const keys = [ring.active, ...ring.previous];
    const ids = new Set<string>();
    for (const entry of keys) {
      if (!HMAC_KEY_ID.test(entry.id) || !Buffer.isBuffer(entry.key) || entry.key.length !== 32) {
        throw new Error("gateway fingerprint HMAC keys require a valid id and exactly 256 bits");
      }
      if (ids.has(entry.id)) {
        throw new Error(`duplicate gateway fingerprint HMAC key id '${entry.id}'`);
      }
      ids.add(entry.id);
    }
    const comparisons = keys.map((entry) =>
      `v1:hmac-sha256:${entry.id}:${createHmac("sha256", entry.key)
        .update(input, "utf8")
        .digest("hex")}`
    );
    return { stored: comparisons[0], comparisons };
  }
  const digest = createHash("sha256").update(input, "utf8").digest("hex");
  const stored = `v1:sha256:unkeyed:${digest}`;
  return { stored, comparisons: [stored, digest] };
}

export function gatewayRequestFingerprint(
  routeKind: GatewayFingerprintRouteKind,
  parsedBody: unknown,
  opts?: GatewayRequestFingerprintOptions,
): string {
  return gatewayRequestFingerprints(routeKind, parsedBody, opts).stored;
}

export function assertGatewayFingerprintMatch(
  stored: string | null | undefined,
  current: string | readonly string[],
  context: Record<string, unknown>,
): void {
  if (stored == null) return; // Legacy row — nothing to compare.
  const candidates = typeof current === "string" ? [current] : current;
  if (!candidates.includes(stored)) {
    throw new VerdictError(
      "client_order_id is already bound to a different gateway request",
      ERROR_CODES.duplicate,
      409,
      context,
    );
  }
}
