export const LAUNCH_THREAD_TWEET_LIMIT = 280;

export interface LaunchThreadTarget {
  apiUrl: string;
  dashboardUrl: string;
}

export interface LaunchThreadLeaderboardRow {
  display_slug: string;
  display_name: string;
  rank: number | null;
  verdict_score: number | null;
  win_rate: number | null;
  resolved_calls: number;
  pending_calls: number;
}

export interface LaunchThreadTweet {
  index: number;
  body: string;
  count: number;
  over: boolean;
}

export interface LaunchThreadDraft {
  tweets: LaunchThreadTweet[];
  markdown: string;
}

export class LaunchThreadError extends Error {
  readonly code: "empty_leaderboard";

  constructor(message: string) {
    super(message);
    this.name = "LaunchThreadError";
    this.code = "empty_leaderboard";
  }
}

export function buildLaunchThreadDraft(input: {
  rows: LaunchThreadLeaderboardRow[];
  target: LaunchThreadTarget;
  generatedAt: Date;
  tweetLimit?: number;
}): LaunchThreadDraft {
  const tweetLimit = input.tweetLimit ?? LAUNCH_THREAD_TWEET_LIMIT;
  const tweets = buildLaunchThreadTweets({
    rows: input.rows,
    target: input.target,
    tweetLimit,
  });
  return {
    tweets,
    markdown: renderLaunchThreadMarkdown({
      tweets,
      target: input.target,
      generatedAt: input.generatedAt,
      tweetLimit,
    }),
  };
}

export function buildLaunchThreadTweets(input: {
  rows: LaunchThreadLeaderboardRow[];
  target: LaunchThreadTarget;
  tweetLimit?: number;
}): LaunchThreadTweet[] {
  if (input.rows.length === 0) {
    throw new LaunchThreadError(
      "Leaderboard is empty - no thread to draft. Seed agents first.",
    );
  }

  const tweetLimit = input.tweetLimit ?? LAUNCH_THREAD_TWEET_LIMIT;
  const ranked = input.rows
    .filter((r) => r.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const top = ranked.length > 0 ? ranked.slice(0, 3) : input.rows.slice(0, 3);
  const bodies: string[] = [];

  bodies.push(
    [
      "the public referee for autonomous market agents is live.",
      "",
      "every call scored against the external venue's own resolution.",
      "every receipt independently verifiable.",
      "",
      "today's leaderboard ↓",
      launchThreadLeaderboardUrl(input.target),
    ].join("\n"),
  );

  top.forEach((row, i) => {
    const place = i === 0 ? "1." : i === 1 ? "2." : "3.";
    const verdict = formatLaunchThreadVerdict(row.verdict_score);
    const wins =
      row.win_rate === null
        ? "(unranked yet)"
        : `${Math.round(row.win_rate * 100)}% wins · ${row.resolved_calls} resolved`;
    const live = row.pending_calls > 0 ? ` · ${row.pending_calls} pending` : "";

    bodies.push(
      [
        `${place} ${row.display_name}`,
        `verdict ${verdict} · ${wins}${live}`,
        "",
        launchThreadShareUrl(input.target, row.display_slug),
      ].join("\n"),
    );
  });

  bodies.push(
    [
      "wire it into your stack:",
      "→ public REST API + OpenAPI",
      "→ OpenServ Launchpad agent (public discovery capabilities)",
      "→ live SVG/PNG embed badges + per-agent RSS",
      "",
      `install in 60s: ${launchThreadLaunchUrl(input.target)}`,
      `top sharers: ${launchThreadRecruitersUrl(input.target)}`,
    ].join("\n"),
  );

  return bodies.map((body, i) => {
    const meta = launchThreadTweetCount(body, tweetLimit);
    return {
      index: i + 1,
      body: meta.body,
      count: meta.count,
      over: meta.over,
    };
  });
}

export function renderLaunchThreadMarkdown(input: {
  tweets: LaunchThreadTweet[];
  target: LaunchThreadTarget;
  generatedAt: Date;
  tweetLimit?: number;
}): string {
  const tweetLimit = input.tweetLimit ?? LAUNCH_THREAD_TWEET_LIMIT;
  const overCount = launchThreadOverflowCount(input.tweets);
  const lines: string[] = [
    "# Launch thread — Murmur Verdict",
    "",
    `**Generated:** ${input.generatedAt.toISOString()}  `,
    `**Daemon:** ${input.target.apiUrl}  `,
    `**Dashboard:** ${input.target.dashboardUrl}  `,
    `**Tweet limit:** ${tweetLimit}  `,
    `**Status:** ${
      overCount === 0
        ? "ready to ship — all under limit"
        : `${overCount} over limit, edit before sending`
    }`,
    "",
    "---",
    "",
  ];

  input.tweets.forEach((t) => {
    lines.push(
      `## Tweet ${t.index} · ${t.count}/${tweetLimit}${
        t.over ? "  ⚠️ over limit" : ""
      }`,
    );
    lines.push("");
    lines.push("```");
    lines.push(t.body);
    lines.push("```");
    lines.push("");
  });

  lines.push("---");
  lines.push("");
  lines.push(
    "> Re-run `tsx tools/operations/launch-thread.ts` before sending so verdict scores and rank are current.",
  );
  lines.push(
    "> The /share/<slug> URLs in tweets 2-4 are the daemon's OG-meta interceptor - X scrapers will unfurl the per-agent PNG card inline.",
  );
  lines.push("");
  return lines.join("\n");
}

export function launchThreadTweetCount(
  body: string,
  limit: number = LAUNCH_THREAD_TWEET_LIMIT,
): { body: string; count: number; over: boolean } {
  const count = [...body].length;
  return { body, count, over: count > limit };
}

export function launchThreadOverflowCount(tweets: LaunchThreadTweet[]): number {
  return tweets.filter((t) => t.over).length;
}

export function formatLaunchThreadVerdict(score: number | null): string {
  if (score === null) return "—";
  const sign = score >= 0 ? "+" : "−";
  return `${sign}${Math.round(Math.abs(score) * 1000)}σ`;
}

export function launchThreadShareUrl(
  target: LaunchThreadTarget,
  slug: string,
): string {
  return `${target.apiUrl}/share/${slug}`;
}

export function launchThreadProfileUrl(
  target: LaunchThreadTarget,
  slug: string,
): string {
  return `${target.dashboardUrl}/#/agents/${slug}`;
}

export function launchThreadLeaderboardUrl(target: LaunchThreadTarget): string {
  return `${target.dashboardUrl}/#/leaderboard`;
}

export function launchThreadRecruitersUrl(target: LaunchThreadTarget): string {
  return `${target.dashboardUrl}/#/recruiters`;
}

export function launchThreadLaunchUrl(target: LaunchThreadTarget): string {
  return `${target.dashboardUrl}/#/launch`;
}
