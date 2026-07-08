import type Database from "better-sqlite3";

import type { VerdictEventBus } from "./events.js";
import { getTodayFeed } from "./feed.js";
import {
  publicLeaderboardCsv,
  publicLeaderboardMarkdown,
  publicLeaderboardSnapshot,
  publicStatsSnapshot,
} from "./public-ranking-snapshot.js";
import type {
  PublicLeaderboardCsvReadQuery,
  PublicLeaderboardReadQuery,
} from "./public-ranking-query.js";

const PUBLIC_STATS_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
const PUBLIC_MARKDOWN_CACHE_CONTROL = "public, max-age=120, stale-while-revalidate=600";
const PUBLIC_CSV_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

export interface PublicRankingSurfaceDeps {
  db: Database.Database;
  events?: VerdictEventBus;
}

export interface PublicRankingSurfaceReadInput
  extends PublicRankingSurfaceDeps {
  servedAt: Date;
}

export interface PublicRankingSurfaceResponse<TBody> {
  status: 200;
  headers?: Record<string, string>;
  body: TBody;
}

export interface PublicRankingJsonResponseTarget<TBody> {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: TBody): unknown };
}

export interface PublicRankingBodyResponseTarget {
  setHeader(name: string, value: string): unknown;
  status(code: number): { send(body: string): unknown };
}

export function sendPublicRankingJsonResponse<TBody>(
  res: PublicRankingJsonResponseTarget<TBody>,
  result: PublicRankingSurfaceResponse<TBody>,
): void {
  applyPublicRankingHeaders(res, result.headers);
  res.status(result.status).json(result.body);
}

export function sendPublicRankingBodyResponse(
  res: PublicRankingBodyResponseTarget,
  result: PublicRankingSurfaceResponse<string>,
): void {
  applyPublicRankingHeaders(res, result.headers);
  res.status(result.status).send(result.body);
}

export function publicLeaderboardResponse(input: PublicRankingSurfaceReadInput & {
  query: PublicLeaderboardReadQuery;
}): PublicRankingSurfaceResponse<ReturnType<typeof publicLeaderboardSnapshot>> {
  return {
    status: 200,
    body: publicLeaderboardSnapshot({
      db: input.db,
      servedAt: input.servedAt,
      query: input.query,
    }),
  };
}

export function publicTodayFeedResponse(
  input: PublicRankingSurfaceReadInput,
): PublicRankingSurfaceResponse<ReturnType<typeof getTodayFeed>> {
  return {
    status: 200,
    body: getTodayFeed(input.db, input.servedAt),
  };
}

export function publicStatsResponse(
  input: PublicRankingSurfaceReadInput,
): PublicRankingSurfaceResponse<ReturnType<typeof publicStatsSnapshot>> {
  return {
    status: 200,
    headers: {
      "Cache-Control": PUBLIC_STATS_CACHE_CONTROL,
    },
    body: publicStatsSnapshot({
      db: input.db,
      events: input.events,
      servedAt: input.servedAt,
    }),
  };
}

export function publicLeaderboardMarkdownResponse(
  input: PublicRankingSurfaceReadInput,
): PublicRankingSurfaceResponse<string> {
  const markdown = publicLeaderboardMarkdown({
    db: input.db,
    servedAt: input.servedAt,
  });
  return {
    status: 200,
    headers: {
      "Content-Type": markdown.contentType,
      "Cache-Control": PUBLIC_MARKDOWN_CACHE_CONTROL,
    },
    body: markdown.body,
  };
}

export function publicLeaderboardCsvResponse(input: PublicRankingSurfaceDeps & {
  query: PublicLeaderboardCsvReadQuery;
}): PublicRankingSurfaceResponse<string> {
  const csv = publicLeaderboardCsv({
    db: input.db,
    query: input.query,
  });
  return {
    status: 200,
    headers: {
      "Content-Type": csv.contentType,
      "Cache-Control": PUBLIC_CSV_CACHE_CONTROL,
      "Content-Disposition": `inline; filename="${csv.filename}"`,
    },
    body: csv.body,
  };
}

function applyPublicRankingHeaders(
  res: { setHeader(name: string, value: string): unknown },
  headers: Record<string, string> | undefined,
): void {
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}
