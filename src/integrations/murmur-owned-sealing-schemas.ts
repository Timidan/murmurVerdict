import { z } from "zod";

import type {
  CofheInput,
  GatewaySealedCallBody,
} from "./fhenix-gateway-schemas.js";
import { Hex32Schema } from "../verdict/fhenix-common.js";
import { CommitmentSchema } from "../verdict/markets-core.js";

export const MurmurOwnedSealedVerdictSchema = z
  .object({
    binary_index: z.number().int().min(0).max(255),
    confidence_bps: z.number().int().min(0).max(10_000),
  })
  .strict();

export const MurmurOwnedSealedCallBodySchema = z
  .object({
    marketRef: CommitmentSchema.shape.marketRef,
    client_order_id: z.string().min(8).max(128),
    client_nonce: Hex32Schema,
    submitted_at: z.string().datetime({ offset: false }).optional(),
    privacy_mode: z.literal("murmur_sealed_fhenix"),
    verdict: MurmurOwnedSealedVerdictSchema,
    public_strategy_tag: z.string().min(2).max(32).optional(),
  })
  .strict();

export type MurmurOwnedSealedVerdict = z.infer<
  typeof MurmurOwnedSealedVerdictSchema
>;
export type MurmurOwnedSealedCallBody = z.infer<
  typeof MurmurOwnedSealedCallBodySchema
>;

export function murmurOwnedSealedCallToGatewayBody(input: {
  body: MurmurOwnedSealedCallBody;
  binaryIndexInput: CofheInput;
  confidenceInput: CofheInput;
}): GatewaySealedCallBody {
  const strategyTag = input.body.public_strategy_tag ?? "murmur-owned";
  return {
    marketRef: input.body.marketRef,
    client_order_id: input.body.client_order_id,
    client_nonce: input.body.client_nonce,
    ...(input.body.submitted_at ? { submitted_at: input.body.submitted_at } : {}),
    strategy_tag: strategyTag,
    privacy_mode: "sealed_fhenix",
    binary_index_input: input.binaryIndexInput,
    confidence_input: input.confidenceInput,
  };
}
