import { z } from "zod";

import { ResolutionClassSchema, type ResolutionClass } from "../../verdict/schema.js";
import { normalizeOutcomeLabel } from "./clob-transform.js";
import { parseOutcomeLabels, type GammaMarketSnapshot } from "./transform.js";

export const POLYMARKET_CONDITION_ID_REGEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * https URLs only. The value lands in a public `<img src>`, so http (mixed
 * content) and javascript:/data: (injection) are dropped, never stored.
 */
export function httpsUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/** Zod mirror of {@link httpsUrlOrNull} for the stored projection. */
const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "icon_url must be an https URL");

/** Stored `markets.config_json` for Gamma rows. Passthrough: Gamma adds fields constantly. */
export const marketConfigSchema = z
  .object({
    conditionId: z.string().regex(POLYMARKET_CONDITION_ID_REGEX),
    questionID: z.string().regex(POLYMARKET_CONDITION_ID_REGEX).optional(),
    question: z.string().optional(),
    slug: z.string().min(1),
    outcomes: z.array(z.string()).length(2),
    /** `normalized label → CLOB token_id`, fixed at registration; the CLOB fallback prefers it over label matching. */
    clobTokenIds: z.record(z.string()).optional(),
    endDate: z.string().nullable(),
    umaBond: z.string().optional(),
    resolvedBy: z.string().optional(),
    resolution_class: ResolutionClassSchema.optional(),
    /** Venue artwork, https-validated. Not backfilled on older markets. */
    icon_url: httpsUrlSchema.optional(),
    /** Top-level Gamma event tag; absent for untagged events (e.g. 5m crypto). */
    venue_category: z.string().min(1).optional(),
    /** Gamma recurring series, e.g. "ETH Up or Down 5m". Display only, not a category. */
    series_title: z.string().min(1).optional(),
    series_slug: z.string().min(1).optional(),
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
    readonly question?: unknown;
    /** JSON-encoded pair of CLOB token ids. */
    readonly clobTokenIds?: unknown;
    /** `icon` wins over `image`. */
    readonly icon?: unknown;
    readonly image?: unknown;
    /** Parent event(s), where tags and series live. */
    readonly events?: unknown;
  };
  resolutionClass?: ResolutionClass;
}

/** Gamma's payload cannot support an honest stored projection. */
export class PolymarketGammaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolymarketGammaConfigError";
  }
}

/**
 * Polymarket top-level categories: tag slug → display label. Gamma exposes no
 * tag hierarchy, so it is named here; other tags leave a market uncategorised.
 * Array order is precedence when a market carries several.
 */
const POLYMARKET_TOP_LEVEL_TAGS: ReadonlyArray<readonly [slug: string, label: string]> = [
  ["sports", "Sports"],
  ["politics", "Politics"],
  ["elections", "Elections"],
  ["geopolitics", "Geopolitics"],
  ["middle-east", "Middle East"],
  ["world", "World"],
  ["crypto", "Crypto"],
  ["finance", "Finance"],
  ["economy", "Economy"],
  ["business", "Business"],
  ["earnings", "Earnings"],
  ["tech", "Tech"],
  ["science", "Science"],
  ["health", "Health"],
  ["entertainment", "Entertainment"],
  ["pop-culture", "Culture"],
];

/** The market's highest-precedence top-level tag, as its canonical label. */
function venueCategoryFromEvents(events: unknown): string | null {
  if (!Array.isArray(events)) return null;
  const event = events[0];
  if (typeof event !== "object" || event === null) return null;
  const tags = (event as Record<string, unknown>).tags;
  if (!Array.isArray(tags)) return null;
  const present = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== "object" || tag === null) continue;
    const slug = (tag as Record<string, unknown>).slug;
    if (typeof slug === "string") present.add(slug.trim().toLowerCase());
  }
  for (const [slug, label] of POLYMARKET_TOP_LEVEL_TAGS) {
    if (present.has(slug)) return label;
  }
  return null;
}

/** Series identity from the embedded parent event, or null. */
function seriesFromEvents(events: unknown): { title: string; slug: string | null } | null {
  if (!Array.isArray(events)) return null;
  const event = events[0];
  if (typeof event !== "object" || event === null) return null;
  const series = (event as Record<string, unknown>).series;
  if (!Array.isArray(series)) return null;
  const first = series[0];
  if (typeof first !== "object" || first === null) return null;
  const title = (first as Record<string, unknown>).title;
  if (typeof title !== "string" || title.trim().length === 0) return null;
  const slug = (first as Record<string, unknown>).slug;
  return {
    title: title.trim(),
    slug: typeof slug === "string" && slug.length > 0 ? slug : null,
  };
}

export function polymarketGammaMarketConfig(
  input: PolymarketGammaMarketConfigInput,
): PolymarketGammaMarketConfig {
  const slug = input.snapshot.slug;
  if (typeof slug !== "string" || slug.length === 0) {
    throw new PolymarketGammaConfigError(
      `Gamma returned no slug for ${input.conditionId}; refusing to invent one ` +
        `(it becomes the public venue URL).`,
    );
  }
  const question = input.snapshot.question;
  const clobTokenIds = clobTokenIdMapForConfig(
    input.snapshot.outcomes,
    input.snapshot.clobTokenIds,
  );
  // One normalized icon: the square `icon`, else the `image` card art.
  const iconUrl =
    httpsUrlOrNull(input.snapshot.icon) ?? httpsUrlOrNull(input.snapshot.image);
  const venueCategory = venueCategoryFromEvents(input.snapshot.events);
  const series = seriesFromEvents(input.snapshot.events);
  return {
    conditionId: input.conditionId,
    ...(typeof question === "string" && question.length > 0 ? { question } : {}),
    slug,
    outcomes: gammaOutcomeLabelsForConfig(input.snapshot.outcomes, input.conditionId),
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
    ...(iconUrl !== null ? { icon_url: iconUrl } : {}),
    ...(venueCategory !== null ? { venue_category: venueCategory } : {}),
    ...(series !== null ? { series_title: series.title } : {}),
    ...(series?.slug ? { series_slug: series.slug } : {}),
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
    // Re-validated on the way out: this is public and the stored blob is passthrough.
    ...(httpsUrlOrNull(config.icon_url) !== null
      ? { icon_url: httpsUrlOrNull(config.icon_url) }
      : {}),
    ...(typeof config.gamma_url === "string" ? { gamma_url: config.gamma_url } : {}),
    ...(typeof config.venue_category === "string" && config.venue_category.length > 0
      ? { venue_category: config.venue_category }
      : {}),
    ...(typeof config.series_title === "string" && config.series_title.length > 0
      ? { series_title: config.series_title }
      : {}),
  };
}

/**
 * `normalized label → CLOB token_id`, index-aligned with `outcomes`. Null on
 * any doubt; resolution then falls back to label matching.
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

/** Gamma's own outcome labels. Throws rather than guessing: the CLOB lookup keys off them. */
function gammaOutcomeLabelsForConfig(outcomes: unknown, conditionId: string): string[] {
  const labels = parseOutcomeLabels(typeof outcomes === "string" ? outcomes : undefined);
  if (
    labels === null ||
    labels.length !== 2 ||
    !labels.every((label) => typeof label === "string" && label.length > 0)
  ) {
    throw new PolymarketGammaConfigError(
      `Gamma returned no usable outcome labels for ${conditionId}; refusing to ` +
        `substitute YES/NO (they are stored and displayed as the real outcomes).`,
    );
  }
  return labels;
}
