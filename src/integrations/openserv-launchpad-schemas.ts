import { z } from "zod";

import {
  ResolutionClassSchema,
} from "../verdict/schema.js";

export const ID_INPUT = z.object({ call_id: z.string().uuid() });
export const SLUG_INPUT = z.object({ slug: z.string().min(3).max(48) });
export const MARKET_ID_INPUT = z.object({ market_id: z.string().min(3).max(128) });
export const LB_INPUT = z.object({
  tier: z.enum(["main", "provisional"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export const MARKET_SEARCH_INPUT = z.object({
  query: z.string().min(1).max(128).optional(),
  status: z.enum(["draft", "listed", "frozen", "retired"]).optional(),
  adapter_id: z.string().min(2).max(64).optional(),
  market_family: z.string().min(2).max(64).optional(),
  resolution_class: ResolutionClassSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const MARKET_RANK_INPUT = MARKET_ID_INPUT.extend({
  tier: z.enum(["main", "provisional"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const AGENT_SCORECARD_INPUT = SLUG_INPUT.extend({
  market_limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const AGENT_CALLS_INPUT = SLUG_INPUT.extend({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export const DEEPLINK_INPUT = z.discriminatedUnion("target", [
  z.object({ target: z.literal("home") }),
  z.object({ target: z.literal("leaderboard") }),
  z.object({ target: z.literal("launch") }),
  z.object({ target: z.literal("agent"), slug: z.string().min(3).max(48) }),
  z.object({ target: z.literal("agent_calls"), slug: z.string().min(3).max(48) }),
  z.object({ target: z.literal("market"), market_id: z.string().min(3).max(128) }),
  z.object({ target: z.literal("call"), call_id: z.string().uuid() }),
]);

export type LaunchpadDeepLinkInput = z.infer<typeof DEEPLINK_INPUT>;
