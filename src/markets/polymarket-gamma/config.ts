import { z } from "zod";

import { ResolutionClassSchema, type ResolutionClass } from "../../verdict/schema.js";
import { parseOutcomeLabels, type GammaMarketSnapshot } from "./transform.js";

export const POLYMARKET_CONDITION_ID_REGEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * Stamped onto `markets.config_json` for Polymarket Gamma rows. Gamma adds
 * undocumented fields constantly, so the adapter-facing schema stays
 * passthrough while this Module owns Murmur's stable stored projection.
 */
export const marketConfigSchema = z
  .object({
    conditionId: z.string().regex(POLYMARKET_CONDITION_ID_REGEX),
    questionID: z.string().regex(POLYMARKET_CONDITION_ID_REGEX).optional(),
    slug: z.string().min(1),
    outcomes: z.array(z.string()).length(2),
    endDate: z.string().nullable(),
    umaBond: z.string().optional(),
    resolvedBy: z.string().optional(),
    resolution_class: ResolutionClassSchema.optional(),
    gamma_url: z.string().url(),
  })
  .passthrough();

export type PolymarketGammaMarketConfig = z.infer<typeof marketConfigSchema>;

export interface PolymarketGammaMarketConfigInput {
  conditionId: string;
  snapshot: Pick<
    GammaMarketSnapshot,
    "slug" | "outcomes" | "endDate" | "umaBond" | "resolvedBy"
  >;
  resolutionClass?: ResolutionClass;
}

export function polymarketGammaMarketConfig(
  input: PolymarketGammaMarketConfigInput,
): PolymarketGammaMarketConfig {
  const slug = typeof input.snapshot.slug === "string" && input.snapshot.slug.length > 0
    ? input.snapshot.slug
    : input.conditionId.slice(0, 10);
  return {
    conditionId: input.conditionId,
    slug,
    outcomes: gammaOutcomeLabelsForConfig(input.snapshot.outcomes),
    endDate: typeof input.snapshot.endDate === "string"
      ? input.snapshot.endDate
      : null,
    ...(typeof input.snapshot.umaBond === "string"
      ? { umaBond: input.snapshot.umaBond }
      : {}),
    ...(typeof input.snapshot.resolvedBy === "string"
      ? { resolvedBy: input.snapshot.resolvedBy }
      : {}),
    ...(input.resolutionClass ? { resolution_class: input.resolutionClass } : {}),
    gamma_url: `https://polymarket.com/event/${slug}`,
  };
}

export function polymarketGammaMarketConfigJson(
  input: PolymarketGammaMarketConfigInput,
): string {
  return JSON.stringify(polymarketGammaMarketConfig(input));
}

export function publicPolymarketGammaMarketConfigSummary(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(typeof config.conditionId === "string" ? { conditionId: config.conditionId } : {}),
    ...(typeof config.slug === "string" ? { slug: config.slug } : {}),
    ...(Array.isArray(config.outcomes) ? { outcomes: config.outcomes } : {}),
    ...(typeof config.endDate === "string" ? { endDate: config.endDate } : {}),
    ...(typeof config.gamma_url === "string" ? { gamma_url: config.gamma_url } : {}),
  };
}

function gammaOutcomeLabelsForConfig(outcomes: unknown): string[] {
  const labels = parseOutcomeLabels(typeof outcomes === "string" ? outcomes : undefined);
  return labels !== null &&
    labels.length === 2 &&
    labels.every((label) => typeof label === "string")
    ? labels
    : ["YES", "NO"];
}
