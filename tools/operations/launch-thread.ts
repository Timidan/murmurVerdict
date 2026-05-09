#!/usr/bin/env tsx
/**
 * Launch-thread auto-generator.
 *
 * Pulls the live leaderboard from the running daemon and produces a
 * 5-tweet thread, ready to copy-paste into X / Buffer / Typefully.
 * Each tweet referencing an agent embeds the daemon's /share/:slug
 * URL so X scrapers pull the per-slug OG card inline.
 *
 * Usage:
 *   PUBLIC_API_URL=https://murmur.verdict \\
 *   PUBLIC_DASHBOARD_URL=https://murmur.app \\
 *   tsx tools/operations/launch-thread.ts
 *
 * Output: docs/launchpad/launch-thread.md (gitignored under /docs/).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const PUBLIC_API_URL = (process.env.PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const PUBLIC_DASHBOARD_URL = (process.env.PUBLIC_DASHBOARD_URL ?? "http://127.0.0.1:5176").replace(/\/$/, "");
const OUTPUT = resolve(REPO_ROOT, "docs/launchpad/launch-thread.md");
const TWEET_LIMIT = 280;

interface LeaderboardRow {
  display_slug: string;
  display_name: string;
  rank: number | null;
  verdict_score: number | null;
  win_rate: number | null;
  resolved_calls: number;
  pending_calls: number;
}

async function fetchLeaderboard(): Promise<LeaderboardRow[]> {
  const res = await fetch(`${PUBLIC_API_URL}/v1/leaderboard?limit=20`);
  if (!res.ok) throw new Error(`/v1/leaderboard → ${res.status}`);
  const json = (await res.json()) as { rows: LeaderboardRow[] };
  return json.rows;
}

function shareUrl(slug: string): string {
  return `${PUBLIC_API_URL}/share/${slug}`;
}

function profileUrl(slug: string): string {
  return `${PUBLIC_DASHBOARD_URL}/#/agents/${slug}`;
}

function leaderboardUrl(): string {
  return `${PUBLIC_DASHBOARD_URL}/#/leaderboard`;
}

function recruitersUrl(): string {
  return `${PUBLIC_DASHBOARD_URL}/#/recruiters`;
}

function launchUrl(): string {
  return `${PUBLIC_DASHBOARD_URL}/#/launch`;
}

function formatVerdict(s: number | null): string {
  if (s === null) return "—";
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(s) * 1000)}σ`;
}

function withTweetCount(body: string, limit: number = TWEET_LIMIT): { body: string; count: number; over: boolean } {
  const count = [...body].length; // grapheme-aware enough for our text
  return { body, count, over: count > limit };
}

interface Tweet {
  index: number;
  body: string;
  count: number;
  over: boolean;
}

function buildThread(rows: LeaderboardRow[]): Tweet[] {
  const ranked = rows.filter((r) => r.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const top = ranked.length > 0 ? ranked.slice(0, 3) : rows.slice(0, 3);

  const tweets: string[] = [];

  // 1 — hook + leaderboard
  tweets.push(
    [
      `the public referee for autonomous market agents is live.`,
      ``,
      `every call scored against canonical Chainlink + Pyth.`,
      `every receipt independently verifiable.`,
      ``,
      `today's leaderboard ↓`,
      leaderboardUrl(),
    ].join("\n"),
  );

  // 2-4 — top three
  top.forEach((row, i) => {
    const place = i === 0 ? "1." : i === 1 ? "2." : "3.";
    const verdict = formatVerdict(row.verdict_score);
    const wins =
      row.win_rate === null
        ? "(unranked yet)"
        : `${Math.round(row.win_rate * 100)}% wins · ${row.resolved_calls} resolved`;
    const live = row.pending_calls > 0 ? ` · ${row.pending_calls} pending` : "";

    tweets.push(
      [
        `${place} ${row.display_name}`,
        `verdict ${verdict} · ${wins}${live}`,
        ``,
        shareUrl(row.display_slug),
      ].join("\n"),
    );
  });

  // 5 — install CTA + recruiters
  tweets.push(
    [
      `wire it into your stack:`,
      `→ MCP server (Claude / Cursor / Goose / Continue)`,
      `→ OpenServ adapter (5 capabilities)`,
      `→ live SVG/PNG embed badges + per-agent RSS`,
      ``,
      `install in 60s: ${launchUrl()}`,
      `top sharers: ${recruitersUrl()}`,
    ].join("\n"),
  );

  return tweets.map((body, i) => {
    const meta = withTweetCount(body);
    return { index: i + 1, body: meta.body, count: meta.count, over: meta.over };
  });
}

function renderMarkdown(tweets: Tweet[]): string {
  const overCount = tweets.filter((t) => t.over).length;
  const lines: string[] = [
    `# Launch thread — Murmur Verdict`,
    ``,
    `**Generated:** ${new Date().toISOString()}  `,
    `**Daemon:** ${PUBLIC_API_URL}  `,
    `**Dashboard:** ${PUBLIC_DASHBOARD_URL}  `,
    `**Tweet limit:** ${TWEET_LIMIT}  `,
    `**Status:** ${overCount === 0 ? "ready to ship — all under limit" : `${overCount} over limit, edit before sending`}`,
    ``,
    `---`,
    ``,
  ];

  tweets.forEach((t) => {
    lines.push(`## Tweet ${t.index} · ${t.count}/${TWEET_LIMIT}${t.over ? "  ⚠️ over limit" : ""}`);
    lines.push(``);
    lines.push("```");
    lines.push(t.body);
    lines.push("```");
    lines.push(``);
  });

  lines.push(`---`);
  lines.push(``);
  lines.push(`> Re-run \`tsx tools/operations/launch-thread.ts\` before sending so verdict scores and rank are current.`);
  lines.push(`> The /share/<slug> URLs in tweets 2–4 are the daemon's OG-meta interceptor — X scrapers will unfurl the per-agent PNG card inline.`);
  lines.push(``);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const rows = await fetchLeaderboard();
  if (rows.length === 0) {
    console.error("Leaderboard is empty — no thread to draft. Seed agents first.");
    process.exit(1);
  }
  const thread = buildThread(rows);
  const md = renderMarkdown(thread);
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, md, "utf8");
  const overflows = thread.filter((t) => t.over).length;
  console.log(`Wrote ${OUTPUT}`);
  console.log(`  ${thread.length} tweets · ${overflows} over limit`);
  thread.forEach((t) => {
    const flag = t.over ? "⚠️ " : "  ";
    console.log(`  ${flag}tweet ${t.index} · ${t.count}/${TWEET_LIMIT}`);
  });
  process.exit(overflows === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
