import { z } from "zod";

import { ResolutionClassSchema, type ResolutionClass } from "../../verdict/schema.js";
import { normalizeOutcomeLabel } from "./clob-transform.js";
import { parseOutcomeLabels, type GammaMarketSnapshot } from "./transform.js";

export const POLYMARKET_CONDITION_ID_REGEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * `icon_url` is DISPLAY metadata, not scoring config, so adding it does NOT
 * bump `market_config_version`: no resolver, score, or payout reads it, and a
 * market registered before this field existed is scored identically to one
 * registered after. Existing rows simply have no `icon_url` and never get one
 * backfilled — a re-registration picks it up from the venue, nothing else does.
 *
 * https only. The value is rendered as an `<img src>` in the public dashboard,
 * so an `http://` icon would downgrade the page to mixed content (blocked in
 * every current browser) and a `javascript:`/`data:` value is a script-injection
 * surface handed to us by an upstream we do not control. Anything that is not a
 * parseable https URL is DROPPED at ingestion — never stored, never served.
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
    /** Venue artwork, https-validated at ingestion. Absent on every market
     *  registered before this field existed — deliberately NOT backfilled. */
    icon_url: httpsUrlSchema.optional(),
    /** Venue-declared category: first Gamma event tag label. Absent when the
     *  venue does not tag the event (true for the 5m crypto series). */
    venue_category: z.string().min(1).optional(),
    /** Gamma recurring-series identity from the parent event, e.g.
     *  "ETH Up or Down 5m". Display metadata — NOT a category (an
     *  asset-specific series as a grouping key would just restore per-asset
     *  parent groups). */
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
    /** Gamma forward-compat field; projected into config when present. */
    readonly question?: unknown;
    /** Gamma JSON-encoded string of the two CLOB token ids; projected into
     *  the `clobTokenIds` label→id map when parseable. */
    readonly clobTokenIds?: unknown;
    /** Gamma venue artwork. `icon` wins over `image` when both are usable;
     *  see {@link httpsUrlOrNull} for why anything non-https is dropped. */
    readonly icon?: unknown;
    readonly image?: unknown;
    /** Gamma embeds the parent event(s) on market rows; tags + series live
     *  there. Forward-compat unknown — every read is runtime-guarded. */
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
 * Polymarket's top-level categories: tag slug → the label murmur displays.
 *
 * Gamma publishes no hierarchy to read: `/tags` is a flat unsorted list (junk
 * entries included), the tag object carries no parent or level, and `forceShow`
 * is a carousel flag rather than a rank — the broad `crypto` tag has it false
 * while the narrow `up-or-down` has it true. Tag ORDER is not hierarchy either:
 * the same event returns `Up or Down` first on one endpoint and `Crypto Prices`
 * first on another. So the top level has to be named here. Every slug was
 * verified against `/tags/slug/<slug>` before being added; anything not on
 * this list leaves the market uncategorised, which is the honest outcome.
 *
 * ARRAY ORDER IS PRECEDENCE. A market carrying two top-level tags (Politics +
 * Tech) categorises as the earlier entry, deterministically — never by tag id,
 * which is creation order, and never by the tag's own label, which Gamma cases
 * inconsistently ("health", "entertainment"). The label shown is always the
 * canonical one on the right.
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
  // No fabricated slug. The old fallback used the first 10 chars of the
  // conditionId, which is not a slug — it produced a `gamma_url` pointing at a
  // Polymarket event page that does not exist, stored and surfaced as if it
  // were the real venue link. Refuse instead; the caller reports it.
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
  // ONE normalized url, not two raw passthrough fields. Gamma serves `icon`
  // (square mark) and `image` (card art) and they are usually identical; the
  // dashboard wants a single 16px mark, so the choice is made once here rather
  // than in every renderer. `icon` wins; `image` is the fallback for rows that
  // carry only the wide art. A market with neither — or with only non-https
  // values — stores no key at all, which is what the renderer's glyph fallback
  // is for.
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
    // Re-validated on the way OUT as well as on the way in. This summary is
    // served to anonymous browsers, and the stored blob is `.passthrough()` —
    // a row written before the ingestion guard existed, or hand-edited, must
    // not be able to put a non-https url into an <img src> on the public page.
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

/**
 * Outcome labels, exactly as Gamma states them.
 *
 * The old fallback substituted ["YES","NO"] for anything unparseable. Those
 * labels are stored and rendered as the market's real outcomes, so a
 * Up/Down market whose payload glitched was published mislabelled — and the
 * CLOB label→token resolution keys off these strings.
 */
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
