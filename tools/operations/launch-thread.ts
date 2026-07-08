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
 * Output: artifacts/launch-thread.md by default (gitignored).
 * Override with LAUNCH_THREAD_OUTPUT=/path/to/thread.md.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LAUNCH_THREAD_TWEET_LIMIT,
  buildLaunchThreadDraft,
  launchThreadOverflowCount,
  type LaunchThreadLeaderboardRow,
  type LaunchThreadTarget,
} from "../../src/verdict/launch-thread-surface.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const TARGET: LaunchThreadTarget = {
  apiUrl: (process.env.PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, ""),
  dashboardUrl: (process.env.PUBLIC_DASHBOARD_URL ?? "http://127.0.0.1:5176").replace(/\/$/, ""),
};
const OUTPUT = resolve(
  REPO_ROOT,
  process.env.LAUNCH_THREAD_OUTPUT ?? "artifacts/launch-thread.md",
);

async function fetchLeaderboard(): Promise<LaunchThreadLeaderboardRow[]> {
  const res = await fetch(`${TARGET.apiUrl}/v1/leaderboard?limit=20`);
  if (!res.ok) throw new Error(`/v1/leaderboard returned ${res.status}`);
  const json = (await res.json()) as { rows: LaunchThreadLeaderboardRow[] };
  return json.rows;
}

function printHelp(): void {
  console.log(
    [
      "launch-thread",
      "",
      "Builds a launch thread markdown draft from the live Murmur leaderboard.",
      "",
      "Env:",
      "  PUBLIC_API_URL",
      "  PUBLIC_DASHBOARD_URL",
      "  LAUNCH_THREAD_OUTPUT",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    printHelp();
    return;
  }

  const rows = await fetchLeaderboard();
  const draft = buildLaunchThreadDraft({
    rows,
    target: TARGET,
    generatedAt: new Date(),
  });
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, draft.markdown, "utf8");
  const overflows = launchThreadOverflowCount(draft.tweets);
  console.log(`Wrote ${OUTPUT}`);
  console.log(`  ${draft.tweets.length} tweets · ${overflows} over limit`);
  draft.tweets.forEach((t) => {
    const flag = t.over ? "⚠️ " : "  ";
    console.log(`  ${flag}tweet ${t.index} · ${t.count}/${LAUNCH_THREAD_TWEET_LIMIT}`);
  });
  process.exit(overflows === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
