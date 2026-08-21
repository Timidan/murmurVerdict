import type {
  AgentKind,
  LeaderboardTier,
} from "./schema.js";
import { MIN_RESOLVED_CALLS_FOR_MAIN_TIER } from "./schema.js";

/**
 * The single MAIN-tier threshold predicate shared by every leaderboard scope
 * (global, market, family, and cross-family's per-family qualification).
 * Previously this `resolved_calls >= MIN_RESOLVED_CALLS_FOR_MAIN_TIER` check
 * was inlined at 5 sites; centralizing it means a threshold change (or a new
 * tier band) is a one-line edit here.
 */
export function meetsMainTierThreshold(resolved_calls: number): boolean {
  return resolved_calls >= MIN_RESOLVED_CALLS_FOR_MAIN_TIER;
}

export interface LeaderboardSummaryProjection {
  resolved_calls: number;
  verdict_score: number | null;
  verdict_score_lb: number | null;
}

export interface TierAndSort {
  /** resolved_calls >= MAIN threshold. */
  mainTier: boolean;
  /** Value for rankedLeaderboardRows' descending sort. */
  sortKey: number;
}

/**
 * Tier membership + ranking sort key for a scored leaderboard summary.
 * `preferLowerBound` selects the sort metric: false → raw verdict_score
 * (global board); true → verdict_score_lb ?? verdict_score (market / family
 * boards). It does NOT decide the public row's tier field NAME — callers map
 * `mainTier` onto their own `tier` / `market_main_tier` / `family_main_tier`
 * shape, keeping the public row types intact. Cross-family ranking uses a
 * different aggregate metric and stays bespoke.
 */
export function resolveTierAndSort(
  summary: LeaderboardSummaryProjection,
  opts: { preferLowerBound: boolean },
): TierAndSort {
  return {
    mainTier: meetsMainTierThreshold(summary.resolved_calls),
    sortKey: opts.preferLowerBound
      ? summary.verdict_score_lb ?? summary.verdict_score ?? -Infinity
      : summary.verdict_score ?? -Infinity,
  };
}

export interface LeaderboardOptions {
  /** Minimum kind that gets ranked at all (defaults to verified+benchmark). */
  includeKinds?: AgentKind[];
  /** Cap rows returned. Default 200. */
  limit?: number;
  /** "main" -> only ranked agents. "provisional" -> only sub-threshold. omit -> both. */
  tier?: LeaderboardTier;
}

export interface RankedLeaderboardRow {
  _sortKey: number;
}

export interface RankedLeaderboardOptions<Row extends RankedLeaderboardRow> {
  tier?: LeaderboardTier;
  isMain: (row: Row) => boolean;
  onMainRank?: (row: Row, index: number) => void;
}

export function rankedLeaderboardRows<Row extends RankedLeaderboardRow>(
  rows: Row[],
  opts: RankedLeaderboardOptions<Row>,
): Row[] {
  const filtered = opts.tier
    ? rows.filter((row) =>
        opts.tier === "main" ? opts.isMain(row) : !opts.isMain(row),
      )
    : rows;
  const main = filtered
    .filter(opts.isMain)
    .sort((a, b) => b._sortKey - a._sortKey);
  if (opts.onMainRank) {
    main.forEach(opts.onMainRank);
  }
  const provisional = filtered
    .filter((row) => !opts.isMain(row))
    .sort((a, b) => b._sortKey - a._sortKey);
  return [...main, ...provisional];
}

export function publicRankedLeaderboardRows<Row>(
  rows: Array<Row & RankedLeaderboardRow>,
): Row[] {
  return rows.map(({ _sortKey, ...row }) => {
    void _sortKey;
    return row as Row;
  });
}

// The leaderboard's default audience is every kind that
// represents a marketplace-eligible reputation surface: operator-owned agents
// plus benchmarks plus attested agents. `internal_test` stays off the board.
export const DEFAULT_KINDS: AgentKind[] = ["agent", "benchmark", "attested"];
