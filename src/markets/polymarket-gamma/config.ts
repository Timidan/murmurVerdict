import { z } from "zod";

import { ResolutionClassSchema, type ResolutionClass } from "../../verdict/schema.js";
import { normalizeOutcomeLabel } from "./clob-transform.js";
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
    /** Human question text from Gamma (e.g. "Will Argentina win…?"). */
    question: z.string().optional(),
    slug: z.string().min(1),
    outcomes: z.array(z.string()).length(2),
    /** Immutable `normalized outcome label → CLOB token_id` map, persisted
     *  at registration when Gamma supplies valid `clobTokenIds`. The CLOB
     *  resolution fallback prefers this identity over label matching. */
    clobTokenIds: z.record(z.string()).optional(),
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
  > & {
    /** Gamma forward-compat field; projected into config when present. */
    readonly question?: unknown;
    /** Gamma JSON-encoded string of the two CLOB token ids; projected into
     *  the `clobTokenIds` label→id map when parseable. */
    readonly clobTokenIds?: unknown;
  };
  resolutionClass?: ResolutionClass;
}

export function polymarketGammaMarketConfig(
  input: PolymarketGammaMarketConfigInput,
): PolymarketGammaMarketConfig {
  const slug = typeof input.snapshot.slug === "string" && input.snapshot.slug.length > 0
    ? input.snapshot.slug
    : input.conditionId.slice(0, 10);
  const question = input.snapshot.question;
  const clobTokenIds = clobTokenIdMapForConfig(
    input.snapshot.outcomes,
    input.snapshot.clobTokenIds,
  );
  return {
    conditionId: input.conditionId,
    ...(typeof question === "string" && question.length > 0 ? { question } : {}),
    slug,
    outcomes: gammaOutcomeLabelsForConfig(input.snapshot.outcomes),
    ...(clobTokenIds !== null ? { clobTokenIds } : {}),
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
    ...(typeof config.question === "string" ? { question: config.question } : {}),
    ...(typeof config.slug === "string" ? { slug: config.slug } : {}),
    ...(Array.isArray(config.outcomes) ? { outcomes: config.outcomes } : {}),
    ...(typeof config.endDate === "string" ? { endDate: config.endDate } : {}),
    ...(typeof config.gamma_url === "string" ? { gamma_url: config.gamma_url } : {}),
  };
}

/**
 * Build the immutable `normalized label → CLOB token_id` map. Gamma's
 * `clobTokenIds` is documented as index-aligned with `outcomes`. Fail-closed:
 * any parse failure, wrong cardinality, empty id, or non-unique normalized
 * label yields null and the market falls back to label matching at resolve
 * time (same behavior as pre-hardening rows).
 */
function clobTokenIdMapForConfig(
  outcomes: unknown,
  clobTokenIds: unknown,
): Record<string, string> | null {
  const labels = parseOutcomeLabels(typeof outcomes === "string" ? outcomes : undefined);
  if (labels === null || labels.length !== 2) return null;
  const ids = parseOutcomeLabels(
    typeof clobTokenIds === "string" ? clobTokenIds : undefined,
  );
  if (ids === null || ids.length !== 2) return null;
  if (ids.some((id) => id.length === 0) || ids[0] === ids[1]) return null;
  const normalized = labels.map((label) => normalizeOutcomeLabel(label));
  if (normalized.some((label) => label.length === 0)) return null;
  if (normalized[0] === normalized[1]) return null;
  return { [normalized[0]!]: ids[0]!, [normalized[1]!]: ids[1]! };
}

function gammaOutcomeLabelsForConfig(outcomes: unknown): string[] {
  const labels = parseOutcomeLabels(typeof outcomes === "string" ? outcomes : undefined);
  return labels !== null &&
    labels.length === 2 &&
    labels.every((label) => typeof label === "string")
    ? labels
    : ["YES", "NO"];
}
