import { z } from "zod";

import { Hex32Schema } from "../verdict/fhenix-common.js";
import { CommitmentSchema } from "../verdict/markets-core.js";
import {
  FeedPacketKindSchema,
  MarketIdSchema,
} from "../verdict/schema.js";

export const COFHE_EUINT8_UTYPE = 2;
export const COFHE_EUINT16_UTYPE = 3;

export const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

const BytesHexSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);

export const CofheInputSchema = z
  .object({
    ct_hash: Hex32Schema,
    security_zone: z.number().int().min(0).max(255),
    utype: z.number().int().min(0).max(255),
    signature: BytesHexSchema,
  })
  .strict();

export const GatewaySealedCallBodySchema = z
  .object({
    marketRef: CommitmentSchema.shape.marketRef,
    client_order_id: z.string().min(8).max(128),
    client_nonce: Hex32Schema,
    rationale: z.string().max(240).optional(),
    strategy_tag: z.string().min(2).max(32).optional(),
    submitted_at: z.string().datetime({ offset: false }).optional(),
    privacy_mode: z.literal("sealed_fhenix"),
    binary_index_input: CofheInputSchema.refine(
      (value) => value.utype === COFHE_EUINT8_UTYPE,
      "binary_index_input.utype must be CoFHE euint8",
    ),
    confidence_input: CofheInputSchema.refine(
      (value) => value.utype === COFHE_EUINT16_UTYPE,
      "confidence_input.utype must be CoFHE euint16",
    ),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.rationale && !v.strategy_tag) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rationale or strategy_tag is required",
        path: ["rationale"],
      });
    }
  });

export const GatewayFeedPacketBodySchema = z
  .object({
    packet_kind: FeedPacketKindSchema,
    // Required: the contract takes reveal time from the market's embargo; no market reverts MarketNotFound.
    market_id: MarketIdSchema,
    sequence: z.number().int().positive().optional(),
    payload_schema: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9_.-]+$/)
      .default("murmur-feed-packet-v1"),
    client_order_id: z.string().min(8).max(128),
    client_nonce: Hex32Schema,
    submitted_at: z.string().datetime({ offset: false }).optional(),
    delivery_deadline_at: z.string().datetime({ offset: false }).optional(),
    privacy_mode: z.literal("sealed_fhenix"),
    action_input: CofheInputSchema.refine(
      (value) => value.utype === COFHE_EUINT8_UTYPE,
      "action_input.utype must be CoFHE euint8",
    ),
    signal_input: CofheInputSchema.refine(
      (value) => value.utype === COFHE_EUINT16_UTYPE,
      "signal_input.utype must be CoFHE euint16",
    ),
  })
  .strict();

export type GatewaySealedCallBody = z.infer<typeof GatewaySealedCallBodySchema>;
export type GatewayFeedPacketBody = z.infer<typeof GatewayFeedPacketBodySchema>;
export type CofheInput = z.infer<typeof CofheInputSchema>;
