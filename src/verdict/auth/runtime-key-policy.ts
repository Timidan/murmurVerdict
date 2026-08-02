import { z } from "zod";

import { MarketIdSchema } from "../schema.js";

function runtimeKeyPolicyFields(notesMaxLength: number) {
  return {
    allowed_market_ids: z.array(MarketIdSchema).max(64).optional(),
    max_calls_per_hour: z.number().int().min(1).max(1000).optional(),
    max_calls_per_day: z.number().int().min(1).max(10000).optional(),
    feed_packets: z.boolean().optional(),
    notes: z.string().max(notesMaxLength).optional(),
    // Ed25519 public key (32 bytes, lowercase hex) generated client-side at
    // mint time and covered by the controller-wallet signature via
    // policy_hash. Presence upgrades the key to proof-of-possession: gateway
    // requests must carry a valid X-Murmur-Key-Signature or fail closed.
    // Absent on keys minted before PoP; those stay bearer-only. No default —
    // materializing one would change canonical policy hashes of old keys.
    signing_pubkey: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  };
}

export const RuntimeKeyPolicySchema = z
  .object(runtimeKeyPolicyFields(240))
  .strict();

export const RuntimeKeyGatewayPolicySchema = z
  .object(runtimeKeyPolicyFields(280))
  .passthrough();

export type RuntimeKeyPolicy = z.infer<typeof RuntimeKeyPolicySchema>;
export type RuntimeKeyGatewayPolicy = z.infer<typeof RuntimeKeyGatewayPolicySchema>;

export function parseRuntimeKeyGatewayPolicyJson(
  raw: string,
): RuntimeKeyGatewayPolicy {
  return RuntimeKeyGatewayPolicySchema.parse(JSON.parse(raw) as unknown);
}
