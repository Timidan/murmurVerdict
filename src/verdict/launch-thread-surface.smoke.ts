import assert from "node:assert/strict";

import {
  LAUNCH_THREAD_TWEET_LIMIT,
  LaunchThreadError,
  buildLaunchThreadDraft,
  buildLaunchThreadTweets,
  formatLaunchThreadVerdict,
  launchThreadLeaderboardUrl,
  launchThreadLaunchUrl,
  launchThreadOverflowCount,
  launchThreadProfileUrl,
  launchThreadShareUrl,
  launchThreadTweetCount,
  renderLaunchThreadMarkdown,
  type LaunchThreadLeaderboardRow,
} from "./launch-thread-surface.js";

process.stdout.write("murmur launch thread surface smoke\n");

const target = {
  apiUrl: "https://api.murmur.example",
  dashboardUrl: "https://dashboard.murmur.example",
};
const rows: LaunchThreadLeaderboardRow[] = [
  row({ slug: "third", name: "Third Agent", rank: 3, score: null }),
  row({ slug: "first", name: "First Agent", rank: 1, score: 0.1234 }),
  row({ slug: "second", name: "Second Agent", rank: 2, score: -0.0074 }),
  row({ slug: "unranked", name: "Unranked Agent", rank: null, score: 0.9 }),
];

assert.equal(formatLaunchThreadVerdict(null), "—");
assert.equal(formatLaunchThreadVerdict(0.1234), "+123σ");
assert.equal(formatLaunchThreadVerdict(-0.0074), "−7σ");
assert.equal(launchThreadShareUrl(target, "first"), "https://api.murmur.example/share/first");
assert.equal(
  launchThreadProfileUrl(target, "first"),
  "https://dashboard.murmur.example/#/agents/first",
);
assert.equal(
  launchThreadLeaderboardUrl(target),
  "https://dashboard.murmur.example/#/leaderboard",
);
assert.equal(
  launchThreadLaunchUrl(target),
  "https://dashboard.murmur.example/#/launch",
);

const counted = launchThreadTweetCount("abcd", 3);
assert.deepEqual(counted, { body: "abcd", count: 4, over: true });

const tweets = buildLaunchThreadTweets({ rows, target });
assert.equal(tweets.length, 5);
assert.equal(tweets[0]?.index, 1);
assert.match(tweets[0]?.body ?? "", /today's leaderboard/);
assert.match(tweets[1]?.body ?? "", /^1\. First Agent\nverdict \+123σ · 60% wins · 5 resolved · 1 pending/m);
assert.match(tweets[2]?.body ?? "", /^2\. Second Agent\nverdict −7σ · 40% wins · 2 resolved/m);
assert.match(tweets[3]?.body ?? "", /^3\. Third Agent\nverdict — · 40% wins · 2 resolved/m);
assert.match(tweets[4]?.body ?? "", /OpenServ Launchpad agent/);
assert.equal(launchThreadOverflowCount(tweets), 0);

const fallbackTweets = buildLaunchThreadTweets({
  rows: [row({ slug: "alpha", name: "Alpha", rank: null, score: 0.1 })],
  target,
});
assert.equal(fallbackTweets.length, 3);
assert.match(fallbackTweets[1]?.body ?? "", /^1\. Alpha/m);
assert.match(fallbackTweets[1]?.body ?? "", /verdict \+100σ · \(unranked yet\)/);

assert.throws(
  () => buildLaunchThreadTweets({ rows: [], target }),
  (err) =>
    err instanceof LaunchThreadError &&
    err.code === "empty_leaderboard" &&
    /Leaderboard is empty/.test(err.message),
);

const draft = buildLaunchThreadDraft({
  rows,
  target,
  generatedAt: new Date("2026-06-12T09:30:00Z"),
});
assert.equal(draft.tweets.length, 5);
assert.match(draft.markdown, /# Launch thread — Murmur Verdict/);
assert.match(draft.markdown, /\*\*Generated:\*\* 2026-06-12T09:30:00.000Z/);
assert.match(draft.markdown, /\*\*Daemon:\*\* https:\/\/api\.murmur\.example/);
assert.match(draft.markdown, /\*\*Tweet limit:\*\* 280/);
assert.match(draft.markdown, /ready to ship — all under limit/);
assert.match(draft.markdown, /Tweet 2 ·/);

const overflowMarkdown = renderLaunchThreadMarkdown({
  tweets: [
    {
      index: 1,
      body: "too long",
      count: LAUNCH_THREAD_TWEET_LIMIT + 1,
      over: true,
    },
  ],
  target,
  generatedAt: new Date("2026-06-12T09:31:00Z"),
});
assert.match(overflowMarkdown, /1 over limit, edit before sending/);
assert.match(overflowMarkdown, /over limit/);

process.stdout.write("launch thread surface smoke ok\n");

function row(input: {
  slug: string;
  name: string;
  rank: number | null;
  score: number | null;
}): LaunchThreadLeaderboardRow {
  return {
    display_slug: input.slug,
    display_name: input.name,
    rank: input.rank,
    verdict_score: input.score,
    win_rate: input.rank === null ? null : input.rank === 1 ? 0.6 : 0.4,
    resolved_calls: input.rank === 1 ? 5 : 2,
    pending_calls: input.rank === 1 ? 1 : 0,
  };
}
