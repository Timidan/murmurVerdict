import { z } from "zod";

import { MarketIdSchema } from "../schema.js";

function runtimeKeyPolicyFields(notesMaxLength: number) {
  return {
    allowed_market_ids: z.array(MarketIdSchema).max(64).optional(),
    max_calls_per_hour: z.number().int().min(1).max(1000).optional(),
    max_calls_per_day: z.number().int().min(1).max(10000).optional(),
    feed_packets: z.boolean().optional(),
    notes: z.string().max(notesMaxLength).optional(),
    // Ed25519 pubkey (32 bytes, lowercase hex), made client-side and covered by policy_hash.
    // Present = proof-of-possession: requests must be signed or fail closed. Absent = bearer-only.
    // No default: one would change the canonical policy hash of keys minted without it.
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
