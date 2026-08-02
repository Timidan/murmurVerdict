// ─── Gateway request fingerprints (murmur-idem-v1) ───────────────────────────
//
// "Any changed parameter = a new request." Every client_order_id duplicate
// exit on the gateway lanes compares the stored fingerprint of the request
// that RESERVED the attempt against the fingerprint of the request being
// replayed; a mismatch is a hard 409, never a silent idempotent 200 for
// content the agent didn't submit. The fingerprint hashes the VALIDATED
// semantic body (post-zod parse, canonicalized) — the raw-byte hash used by
// runtime-key PoP is a different concern and deliberately a different value.
//
// The domain prefix separates route kinds (and the dynamic feed id) so
// structurally similar bodies in a shared client_order namespace can't
// collide semantically. Owned sealing fingerprints the ORIGINAL client body
// BEFORE randomized CoFHE sealing, so byte-identical retries match even
// though sealing output differs per call.
//
// Rows reserved before migration 060 have no stored fingerprint; those
// replays keep today's 200 (documented legacy exception) because a null
// can't prove a mismatch.

import { createHash } from "node:crypto";

import { canonicalize } from "../receipts/canonical.js";
import { ERROR_CODES, VerdictError } from "../verdict/schema.js";

export type GatewayFingerprintRouteKind =
  | "sealed_call"
  | "owned_sealed_call"
  | "feed_packet";

export function gatewayRequestFingerprint(
  routeKind: GatewayFingerprintRouteKind,
  parsedBody: unknown,
  opts?: { feedId?: string },
): string {
  const domain = ["murmur-idem-v1", routeKind];
  if (opts?.feedId) domain.push(opts.feedId);
  return createHash("sha256")
    .update(`${domain.join("\n")}\n${canonicalize(parsedBody)}`, "utf8")
    .digest("hex");
}

export function assertGatewayFingerprintMatch(
  stored: string | null | undefined,
  current: string,
  context: Record<string, unknown>,
): void {
  if (stored == null) return; // pre-060 legacy row — nothing to compare
  if (stored !== current) {
    throw new VerdictError(
      "client_order_id is already bound to a different gateway request",
      ERROR_CODES.duplicate,
      409,
      context,
    );
  }
}
