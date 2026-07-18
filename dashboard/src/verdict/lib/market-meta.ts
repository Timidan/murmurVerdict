// Shared venue-adapter market metadata helpers.
//
// Venue markets (Polymarket-Gamma imports: adapter_id "polymarket-gamma",
// market_family "prediction-market-binary", settlement_model "venue_adapter")
// carry their human-readable definition in a `config_json` string on the
// MarketRow. Native price markets (eth.1h …) carry no config_json. Both the
// markets grid and the market detail page parse this same blob, so the parser
// + display-name derivation live here rather than being duplicated per view.

import type { MarketRow } from "../api.js";

/**
 * Parsed `config_json` for a venue-adapter market. Every field is optional:
 * native markets have no config_json (parse returns null), and a partial or
 * legacy venue blob still yields whatever keys it does carry. Prices/odds are
 * intentionally absent — those arrive on a later wire in a separate task.
 */
export interface MarketConfig {
  /** Human question, e.g. "Will Argentina win the 2026 FIFA World Cup?". */
  question?: string;
  /** Venue slug, e.g. "will-argentina-win-the-2026-fifa-world-cup-245". */
  slug?: string;
  /** Outcome names in venue order, e.g. ["Yes", "No"]. */
  outcomes?: string[];
  /** ISO close timestamp (UTC), e.g. "2026-07-20T00:00:00Z". */
  endDate?: string;
  /** Canonical venue event URL (external link target). */
  gamma_url?: string;
  /** UMA dispute bond (decimal string), e.g. "500". */
  umaBond?: string;
  /** Resolver address (0x…), the account UMA settles against. */
  resolvedBy?: string;
}

/**
 * Parse a market row's `config_json`. Returns null for native price markets
 * (no config_json present) or when the JSON is malformed. Each field is
 * validated independently so one bad key doesn't discard the rest of the blob.
 */
export function parseMarketConfig(m: MarketRow): MarketConfig | null {
  const raw = m["config_json"];
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const outcomes = Array.isArray(parsed.outcomes)
    ? parsed.outcomes.filter((o): o is string => typeof o === "string")
    : undefined;
  return {
    question: typeof parsed.question === "string" ? parsed.question : undefined,
    slug: typeof parsed.slug === "string" ? parsed.slug : undefined,
    outcomes: outcomes && outcomes.length > 0 ? outcomes : undefined,
    endDate: typeof parsed.endDate === "string" ? parsed.endDate : undefined,
    gamma_url: typeof parsed.gamma_url === "string" ? parsed.gamma_url : undefined,
    umaBond: typeof parsed.umaBond === "string" ? parsed.umaBond : undefined,
    resolvedBy: typeof parsed.resolvedBy === "string" ? parsed.resolvedBy : undefined,
  };
}

/**
 * Human display name for a market: Gamma question > humanized slug > raw
 * market id. The slug fallback drops a trailing "-<n>" disambiguator and
 * title-cases the first word, matching the venue's own presentation.
 */
export function marketDisplayName(m: MarketRow): string {
  const cfg = parseMarketConfig(m);
  if (cfg?.question) return cfg.question;
  if (cfg?.slug) {
    const words = cfg.slug.replace(/-\d+$/, "").split("-").filter(Boolean);
    if (words.length > 0) {
      const sentence = words.join(" ");
      return sentence.charAt(0).toUpperCase() + sentence.slice(1);
    }
  }
  return m.market_id;
}
