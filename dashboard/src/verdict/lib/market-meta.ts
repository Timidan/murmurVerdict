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
  /**
   * Venue artwork, https-validated by the daemon at ingestion AND again on the
   * way out (src/markets/polymarket-gamma/config.ts). Absent on every market
   * registered before the field existed — deliberately never backfilled, so
   * renderers must always have a glyph fallback.
   */
  icon_url?: string;
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
    // https only, checked here as well as server-side. This value goes
    // straight into an image source, and the config blob is stored
    // passthrough — a row written before the server-side guard existed must
    // not be able to put anything else there.
    //
    // Parsed, not prefix-matched. `/^https:\/\//` accepts a bare `"https://"`
    // (and `"https://​"` with any junk that never forms a host), which the
    // server's own `new URL()` gate rejects — so the two halves of a
    // belt-and-braces check disagreed, and the browser half was the loose one.
    icon_url: httpsUrl(parsed.icon_url),
    umaBond: typeof parsed.umaBond === "string" ? parsed.umaBond : undefined,
    resolvedBy: typeof parsed.resolvedBy === "string" ? parsed.resolvedBy : undefined,
  };
}

/**
 * An https URL, or undefined. Mirrors `httpsUrlOrNull` in
 * src/markets/polymarket-gamma/config.ts — same parser, same rule, so the
 * client-side re-check can actually back the server up instead of admitting a
 * wider set than it does.
 */
export function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The asset a five-minute venue market is about, as a short uppercase symbol
 * ("BTC", "ETH", "SOL", "XRP", "DOGE").
 *
 * Read from the venue SLUG (`btc-updown-5m-1786340100`) rather than from
 * `asset_id`, because every Polymarket row shares the synthetic asset id
 * `polymarket:event` — the asset only exists in the slug and the question. The
 * question text is the fallback, matched on the venue's own names so a slug
 * scheme change does not blank the whole filter.
 *
 * Returns null when neither says: the caller shows the market without an asset
 * chip rather than guessing one.
 */
export function marketAssetSymbol(m: MarketRow): string | null {
  const cfg = parseMarketConfig(m);
  return assetSymbolFromSlugOrQuestion(cfg?.slug, cfg?.question);
}

/** Same derivation, for rows that carry a bare slug/question (archive search). */
export function assetSymbolFromSlugOrQuestion(
  slug: string | null | undefined,
  question: string | null | undefined,
): string | null {
  if (typeof slug === "string" && slug.length > 0) {
    const head = slug.split("-")[0];
    if (head && SLUG_ASSET_SYMBOLS[head.toLowerCase()]) {
      return SLUG_ASSET_SYMBOLS[head.toLowerCase()]!;
    }
  }
  if (typeof question === "string" && question.length > 0) {
    const lower = question.toLowerCase();
    for (const [name, symbol] of Object.entries(QUESTION_ASSET_NAMES)) {
      if (lower.startsWith(name)) return symbol;
    }
  }
  return null;
}

/** Venue slug prefix → display symbol. */
const SLUG_ASSET_SYMBOLS: Record<string, string> = {
  btc: "BTC",
  eth: "ETH",
  sol: "SOL",
  xrp: "XRP",
  doge: "DOGE",
};

/** The venue's own spelling at the head of a question → display symbol. */
const QUESTION_ASSET_NAMES: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  solana: "SOL",
  xrp: "XRP",
  dogecoin: "DOGE",
};

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
