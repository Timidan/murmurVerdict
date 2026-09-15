/**
 * `GET /v2/markets/archive?q=&from=&to=&cursor=&limit=`: public read-only search over frozen markets.
 *
 *   q       case-insensitive match on question or slug; LIKE metachars escaped; max 120 chars
 *   from/to inclusive end-time bounds, epoch seconds or ISO-8601
 *   cursor  opaque `next_cursor` from a previous page
 *   limit   1..50, default 50
 *
 * Requires a 2+ char term or a date bound; an unfiltered request is a scrape.
 * No COUNT(*); `has_more` comes from LIMIT n+1.
 * `sealed_window` means a market_clocks row exists; the join is LEFT because most archived markets have none.
 * LIKE scans; move to an FTS5 external-content table past ~100k rows or ~75ms p95.
 */

import type Database from "better-sqlite3";

import { httpsUrlOrNull } from "../markets/polymarket-gamma/config.js";
import { parseMarketConfigJson } from "./market-adapter-config.js";
import { SCHEMA_VERSION } from "./schema.js";

// ─── Limits ─────────────────────────────────────────────────────────────────

export const ARCHIVE_DEFAULT_LIMIT = 50;
export const ARCHIVE_MAX_LIMIT = 50;
/** Longer than any real question on this venue; a longer term is a probe. */
export const ARCHIVE_MAX_QUERY_CHARS = 120;
/** Below this a term matches most of the corpus, so it is not a search. */
export const ARCHIVE_MIN_QUERY_CHARS = 2;

// ─── Result shape ───────────────────────────────────────────────────────────

export interface MarketArchiveRow {
  market_id: string;
  question: string | null;
  slug: string | null;
  /** ISO instant derived from `end_date_epoch_s`. */
  ended_at: string;
  icon_url: string | null;
  /** True when murmur bound a series schedule to this market. */
  sealed_window: boolean;
  /** Provider key ("polymarket-gamma"); Polymarket-only since the query starts from `polymarket_discovery_state`. */
  provider: string;
  /** The venue's own top-level category, or null. Never murmur's taxonomy class, which describes settlement. */
  category_label: string | null;
}

export interface MarketArchiveBody {
  schema_version: number;
  results: MarketArchiveRow[];
  next_cursor: string | null;
  has_more: boolean;
  returned: number;
}

export type MarketArchiveResult =
  | { status: 200; body: MarketArchiveBody }
  | { status: 400; body: { code: string; message: string } };

export interface MarketArchiveQueryInput {
  q?: unknown;
  from?: unknown;
  to?: unknown;
  cursor?: unknown;
  limit?: unknown;
}

// ─── Cursor ─────────────────────────────────────────────────────────────────

interface ArchiveCursor {
  endEpochS: number;
  conditionId: string;
}

/** `end_epoch|condition_id`, base64url. Opaque so clients don't build their own sort keys. */
export function encodeArchiveCursor(cursor: ArchiveCursor): string {
  return Buffer.from(`${cursor.endEpochS}|${cursor.conditionId}`, "utf8")
    .toString("base64url");
}

/** `null` on anything that is not a cursor this route issued. */
export function decodeArchiveCursor(raw: string): ArchiveCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  // Node's base64 decoder is lenient; requiring an exact re-encode keeps one cursor per page.
  if (Buffer.from(decoded, "utf8").toString("base64url") !== raw) return null;
  const split = decoded.indexOf("|");
  if (split <= 0) return null;
  const epochPart = decoded.slice(0, split);
  const conditionId = decoded.slice(split + 1);
  if (!/^\d{1,15}$/.test(epochPart)) return null;
  if (conditionId.length === 0 || conditionId.length > 128) return null;
  // The id is bound, not interpolated; the shape check makes a malformed cursor a 400.
  if (!/^[0-9a-zA-Z_:.-]+$/.test(conditionId)) return null;
  const endEpochS = Number(epochPart);
  if (!Number.isSafeInteger(endEpochS) || endEpochS <= 0) return null;
  return { endEpochS, conditionId };
}

// ─── Input hardening ────────────────────────────────────────────────────────

/** Escape LIKE metacharacters so `%` means a percent sign. Must pair with `ESCAPE '\'` in the SQL. */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Accepted ISO shapes: a calendar date, optionally with a `T…Z` UTC time. No offsets or local times. */
const ISO_BOUND_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z)?$/;

/**
 * Epoch seconds from an integer string or a strict ISO-8601 instant; null if invalid.
 * Zero is accepted (no lower bound). Rejects rolled-over dates, locale forms, pre-epoch and non-zero fractions.
 */
function parseEpochBound(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^\d{1,15}$/.test(trimmed)) {
    const asEpoch = Number(trimmed);
    return Number.isSafeInteger(asEpoch) && asEpoch >= 0 ? asEpoch : null;
  }
  const match = ISO_BOUND_REGEX.exec(trimmed);
  if (match === null) return null;
  // Fractions only when zero; the column is whole seconds, so any other fraction would widen the bound.
  const fraction = match[7];
  if (fraction !== undefined && /[1-9]/.test(fraction)) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(ms)) return null;
  // Round-trip check: `Date.UTC` rolls February 30 into March 2 instead of failing.
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  const epochS = Math.floor(ms / 1000);
  return epochS >= 0 ? epochS : null;
}

function firstScalar(raw: unknown): unknown {
  // Express parses `?q=a&q=b` as an array; take the first.
  return Array.isArray(raw) ? raw[0] : raw;
}

interface ParsedArchiveQuery {
  term: string | null;
  pattern: string | null;
  fromEpochS: number | null;
  toEpochS: number | null;
  cursor: ArchiveCursor | null;
  limit: number;
}

function badRequest(code: string, message: string): MarketArchiveResult {
  return { status: 400, body: { code, message } };
}

export function parseMarketArchiveQuery(
  input: MarketArchiveQueryInput,
): ParsedArchiveQuery | MarketArchiveResult {
  const rawQ = firstScalar(input.q);
  let term: string | null = null;
  if (rawQ !== undefined && rawQ !== null && rawQ !== "") {
    if (typeof rawQ !== "string") {
      return badRequest("archive_query_invalid", "q must be a string");
    }
    if (rawQ.length > ARCHIVE_MAX_QUERY_CHARS) {
      return badRequest(
        "archive_query_invalid",
        `q must be at most ${ARCHIVE_MAX_QUERY_CHARS} characters`,
      );
    }
    const trimmed = rawQ.trim();
    if (trimmed.length > 0) term = trimmed;
  }

  const rawFrom = firstScalar(input.from);
  let fromEpochS: number | null = null;
  if (rawFrom !== undefined && rawFrom !== null && rawFrom !== "") {
    fromEpochS = parseEpochBound(rawFrom);
    if (fromEpochS === null) {
      return badRequest(
        "archive_query_invalid",
        "from must be epoch seconds, YYYY-MM-DD, or YYYY-MM-DDTHH:MM:SSZ " +
          "(whole seconds; this archive is second-granularity)",
      );
    }
  }

  const rawTo = firstScalar(input.to);
  let toEpochS: number | null = null;
  if (rawTo !== undefined && rawTo !== null && rawTo !== "") {
    toEpochS = parseEpochBound(rawTo);
    if (toEpochS === null) {
      return badRequest(
        "archive_query_invalid",
        "to must be epoch seconds, YYYY-MM-DD, or YYYY-MM-DDTHH:MM:SSZ " +
          "(whole seconds; this archive is second-granularity)",
      );
    }
  }

  if (fromEpochS !== null && toEpochS !== null && fromEpochS > toEpochS) {
    return badRequest("archive_query_invalid", "from must not be after to");
  }

  // A one-char term matches most of the corpus; require a real term or a date bound.
  const searchableChars = term === null ? 0 : term.replace(/\s+/g, "").length;
  const hasDateFilter = fromEpochS !== null || toEpochS !== null;
  if (searchableChars < ARCHIVE_MIN_QUERY_CHARS && !hasDateFilter) {
    return badRequest(
      "archive_query_invalid",
      `provide q with at least ${ARCHIVE_MIN_QUERY_CHARS} characters, or a from/to date bound`,
    );
  }
  if (term !== null && searchableChars < ARCHIVE_MIN_QUERY_CHARS) {
    // A date filter carries the request; a too-short term is dropped rather
    // than applied, so "b" plus a day does not return one arbitrary market.
    term = null;
  }

  const rawCursor = firstScalar(input.cursor);
  let cursor: ArchiveCursor | null = null;
  if (rawCursor !== undefined && rawCursor !== null && rawCursor !== "") {
    if (typeof rawCursor !== "string") {
      return badRequest("archive_cursor_invalid", "cursor must be a string");
    }
    cursor = decodeArchiveCursor(rawCursor);
    if (cursor === null) {
      return badRequest(
        "archive_cursor_invalid",
        "cursor is not a page token this endpoint issued",
      );
    }
  }

  const rawLimit = firstScalar(input.limit);
  let limit = ARCHIVE_DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== "") {
    const parsed = Number(rawLimit);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      return badRequest("archive_query_invalid", "limit must be an integer >= 1");
    }
    limit = Math.min(ARCHIVE_MAX_LIMIT, parsed);
  }

  return {
    term,
    pattern: term === null ? null : `%${escapeLikeTerm(term)}%`,
    fromEpochS,
    toEpochS,
    cursor,
    limit,
  };
}

// ─── Query ──────────────────────────────────────────────────────────────────

interface ArchiveDbRow {
  market_id: string;
  question: string | null;
  slug: string | null;
  end_date_epoch_s: number;
  config_json: string | null;
  sealed_window: number;
  adapter_id: string | null;
  market_family: string | null;
  market_kind: string | null;
  scoring_kind: string | null;
}

export function marketArchiveSurface(input: {
  db: Database.Database;
  query: MarketArchiveQueryInput;
}): MarketArchiveResult {
  const parsed = parseMarketArchiveQuery(input.query);
  if ("status" in parsed) return parsed;

  const where: string[] = [
    // Both discovery state and the registry must say frozen; a disagreeing row is mid-transition.
    "p.status = 'frozen'",
    "m.status = 'frozen'",
  ];
  const params: Record<string, string | number> = {};

  if (parsed.fromEpochS !== null) {
    where.push("p.end_date_epoch_s >= @from_epoch_s");
    params.from_epoch_s = parsed.fromEpochS;
  }
  if (parsed.toEpochS !== null) {
    where.push("p.end_date_epoch_s <= @to_epoch_s");
    params.to_epoch_s = parsed.toEpochS;
  }
  if (parsed.pattern !== null) {
    where.push(
      "(p.question LIKE @pattern ESCAPE '\\' COLLATE NOCASE " +
        "OR p.slug LIKE @pattern ESCAPE '\\' COLLATE NOCASE)",
    );
    params.pattern = parsed.pattern;
  }
  if (parsed.cursor !== null) {
    // Keyset, not OFFSET, since the archive grows at the head. Must match ORDER BY for the index seek.
    where.push(
      "(p.end_date_epoch_s < @cursor_epoch_s " +
        "OR (p.end_date_epoch_s = @cursor_epoch_s AND p.condition_id < @cursor_id))",
    );
    params.cursor_epoch_s = parsed.cursor.endEpochS;
    params.cursor_id = parsed.cursor.conditionId;
  }

  // n+1: the extra row answers `has_more` without a COUNT(*), and is discarded.
  params.row_limit = parsed.limit + 1;

  const rows = input.db
    .prepare(
      `SELECT
         p.condition_id                      AS market_id,
         p.question                          AS question,
         p.slug                              AS slug,
         p.end_date_epoch_s                  AS end_date_epoch_s,
         m.config_json                       AS config_json,
         m.adapter_id                        AS adapter_id,
         m.market_family                     AS market_family,
         m.market_kind                       AS market_kind,
         m.scoring_kind                      AS scoring_kind,
         CASE WHEN mc.market_id IS NULL THEN 0 ELSE 1 END AS sealed_window
       FROM polymarket_discovery_state p
       JOIN markets m ON m.market_id = p.condition_id
       LEFT JOIN market_clocks mc ON mc.market_id = p.condition_id
       WHERE ${where.join("\n         AND ")}
       ORDER BY p.end_date_epoch_s DESC, p.condition_id DESC
       LIMIT @row_limit`,
    )
    .all(params) as ArchiveDbRow[];

  const hasMore = rows.length > parsed.limit;
  const page = hasMore ? rows.slice(0, parsed.limit) : rows;
  const last = page[page.length - 1];

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      results: page.map((row) => {
        // Parse once; icon + category both read from it.
        const config = parseMarketConfigJson(row.config_json);
        const categoryLabel =
          typeof config.venue_category === "string" && config.venue_category.length > 0
            ? config.venue_category
            : null;
        return {
          market_id: row.market_id,
          question: typeof row.question === "string" && row.question.length > 0
            ? row.question
            : null,
          slug: typeof row.slug === "string" && row.slug.length > 0 ? row.slug : null,
          ended_at: new Date(row.end_date_epoch_s * 1000).toISOString(),
          // Re-check https; the stored blob is passthrough.
          icon_url: httpsUrlOrNull(config.icon_url),
          sealed_window: row.sealed_window === 1,
          provider: row.adapter_id ?? "polymarket-gamma",
          category_label: categoryLabel,
        };
      }),
      next_cursor:
        hasMore && last
          ? encodeArchiveCursor({
              endEpochS: last.end_date_epoch_s,
              conditionId: last.market_id,
            })
          : null,
      has_more: hasMore,
      returned: page.length,
    },
  };
}
