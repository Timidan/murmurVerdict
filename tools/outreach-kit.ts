#!/usr/bin/env tsx
/**
 * Outreach kit generator.
 *
 * Hits the running Murmur daemon for each seeded shadow agent in
 * RECRUITING.md, pulls their current state (rank, score, verified
 * identity), and writes one ready-to-paste DM markdown file per
 * candidate to docs/launchpad/outreach/.
 *
 * Output filenames are stable so re-runs idempotently overwrite —
 * keep running before each outreach push so the rank / score in the
 * DMs is current.
 *
 * Usage:
 *   PUBLIC_API_URL=https://murmur.verdict \\
 *   PUBLIC_DASHBOARD_URL=https://murmur.app \\
 *   SENDER_REF=timidan \\
 *   tsx tools/outreach-kit.ts
 *
 * Defaults (when env not set): localhost dev URLs, sender "timidan".
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const PUBLIC_API_URL = (process.env.PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const PUBLIC_DASHBOARD_URL = (process.env.PUBLIC_DASHBOARD_URL ?? "http://127.0.0.1:5176").replace(/\/$/, "");
const SENDER_REF = (process.env.SENDER_REF ?? "timidan").trim();
const OUTPUT_DIR = resolve(REPO_ROOT, "docs/launchpad/outreach");

// Candidate list mirrors RECRUITING.md cohort A (CT personalities).
// Each entry maps the X handle to the seeded shadow slug + a one-line
// hook that should land in the opener of the DM.
interface Candidate {
  handle: string;
  slug: string;
  hook: string;
  channel: "x" | "telegram";
}

const CANDIDATES: Candidate[] = [
  {
    handle: "@HsakaTrades",
    slug: "shadow-x-hsakatrades",
    hook: "your 4h ETH calls are exactly the cohort I built Murmur to score",
    channel: "x",
  },
  {
    handle: "@CryptoCred",
    slug: "shadow-x-cryptocred",
    hook: "your range-top reject + bearish OB stuff has the structure that scores cleanly",
    channel: "x",
  },
  {
    handle: "@CryptoDonAlt",
    slug: "shadow-x-cryptodonalt",
    hook: "your TA threads paired with Cred are exactly the call cohort the leaderboard tracks",
    channel: "x",
  },
  {
    handle: "@CredibleCrypto",
    slug: "shadow-x-crediblecrypto",
    hook: "your high-conviction ETH long calls are already being shadow-tracked here",
    channel: "x",
  },
  {
    handle: "@CrypNuevo",
    slug: "shadow-x-crypnuevo",
    hook: "your liquidity-zone calls are the most parseable in CT — perfect fit",
    channel: "x",
  },
  {
    handle: "@52kskew",
    slug: "shadow-x-52kskew",
    hook: "your derivs / vol pieces are about to get a verdict score with receipts",
    channel: "x",
  },
  {
    handle: "@CryptoHayes",
    slug: "shadow-x-cryptohayes",
    hook: "Murmur is the public referee for macro/quant calls — you're already shadowed",
    channel: "x",
  },
  {
    handle: "@lookonchain",
    slug: "shadow-x-lookonchain",
    hook: "your whale-flow alerts can carry a verdict score now — independently verifiable",
    channel: "x",
  },
  {
    handle: "@spotonchain",
    slug: "shadow-x-spotonchain",
    hook: "your structured on-chain alerts are already shadow-tracked on the leaderboard",
    channel: "x",
  },
];

interface AgentSnapshot {
  agent_id: string;
  display_slug: string;
  display_name: string;
  rank: number | null;
  verdict_score: number | null;
  win_rate: number | null;
  resolved_calls: number;
  pending_calls: number;
}

async function fetchSnapshot(slug: string): Promise<AgentSnapshot> {
  const profile = (await getJson(`/v1/agents/${slug}`)) as {
    agent_id: string;
    display_slug: string;
    display_name: string;
  };
  // Read the leaderboard once — cheap, and includes shadow rows when present.
  const rows = ((await getJson(`/v1/leaderboard?limit=200`)) as {
    rows: Array<{ display_slug: string } & Partial<AgentSnapshot>>;
  }).rows;
  const row = rows.find((r) => r.display_slug === slug);
  return {
    agent_id: profile.agent_id,
    display_slug: profile.display_slug,
    display_name: profile.display_name,
    rank: row?.rank ?? null,
    verdict_score: row?.verdict_score ?? null,
    win_rate: row?.win_rate ?? null,
    resolved_calls: row?.resolved_calls ?? 0,
    pending_calls: row?.pending_calls ?? 0,
  };
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${PUBLIC_API_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return await res.json();
}

function formatScore(s: number | null): string {
  if (s === null) return "unranked — submit a tagged call to start scoring";
  const sign = s >= 0 ? "+" : "−";
  return `verdict ${sign}${Math.round(Math.abs(s) * 1000)}σ`;
}

interface RenderedDm {
  candidate: Candidate;
  snapshot: AgentSnapshot;
  shareUrl: string;
  ogUrl: string;
  badgeUrl: string;
  claimUrl: string;
  agentUrl: string;
  body: string;
}

function renderDm(candidate: Candidate, snapshot: AgentSnapshot): RenderedDm {
  const shareUrl = `${PUBLIC_DASHBOARD_URL}/#/share/${snapshot.display_slug}?ref=${encodeURIComponent(SENDER_REF)}`;
  const ogUrl = `${PUBLIC_API_URL}/v1/og/${snapshot.display_slug}.svg`;
  const badgeUrl = `${PUBLIC_API_URL}/v1/badge/${snapshot.display_slug}.svg`;
  const agentUrl = `${PUBLIC_DASHBOARD_URL}/#/agents/${snapshot.display_slug}`;
  const claimUrl = `${PUBLIC_DASHBOARD_URL}/#/agents/${snapshot.display_slug}/claim`;

  const dm = [
    `${candidate.handle} —`,
    ``,
    `${candidate.hook}.`,
    ``,
    `i built Murmur Verdict — public referee for autonomous market agents — and your shadow profile is already on the leaderboard:`,
    `${agentUrl}`,
    ``,
    `(${formatScore(snapshot.verdict_score)}, ${snapshot.resolved_calls} resolved, ${snapshot.pending_calls} pending)`,
    ``,
    `every call scored against canonical Chainlink + Pyth, every receipt independently verifiable. claim the profile to lock in the wallet, get an API key, and import history:`,
    `${claimUrl}`,
    ``,
    `share card: ${shareUrl}`,
  ].join("\n");

  return {
    candidate,
    snapshot,
    shareUrl,
    ogUrl,
    badgeUrl,
    claimUrl,
    agentUrl,
    body: dm,
  };
}

function renderDmFile(rendered: RenderedDm): string {
  const { candidate, snapshot, shareUrl, ogUrl, badgeUrl, claimUrl, agentUrl, body } = rendered;
  return [
    `# Outreach: ${candidate.handle}`,
    ``,
    `**Channel:** ${candidate.channel.toUpperCase()}  `,
    `**Slug:** \`${snapshot.display_slug}\`  `,
    `**Verdict:** ${formatScore(snapshot.verdict_score)}  `,
    `**Resolved / pending:** ${snapshot.resolved_calls} / ${snapshot.pending_calls}  `,
    `**Generated:** ${new Date().toISOString()}  `,
    `**Sender ref:** \`${SENDER_REF}\``,
    ``,
    `## Live preview`,
    ``,
    `![${snapshot.display_name} on Murmur](${badgeUrl})`,
    ``,
    `## Links`,
    ``,
    `- **Agent profile:** ${agentUrl}`,
    `- **Share page:** ${shareUrl}`,
    `- **Claim flow:** ${claimUrl}`,
    `- **OG card SVG:** ${ogUrl}`,
    ``,
    `## DM body — copy-paste`,
    ``,
    "```",
    body,
    "```",
    ``,
    `---`,
    ``,
    `> Auto-generated by \`tools/outreach-kit.ts\`. Re-run before each push so rank / score is current. This file is gitignored under \`/docs/\`.`,
    ``,
  ].join("\n");
}

function renderIndex(rendered: RenderedDm[]): string {
  const lines: string[] = [
    `# Outreach Index — Murmur Verdict (cohort A)`,
    ``,
    `**Generated:** ${new Date().toISOString()}  `,
    `**Daemon:** ${PUBLIC_API_URL}  `,
    `**Dashboard:** ${PUBLIC_DASHBOARD_URL}  `,
    `**Sender ref:** \`${SENDER_REF}\``,
    ``,
    `| Handle | Slug | Verdict | Resolved · Pending | DM file |`,
    `|---|---|---|---|---|`,
  ];
  for (const r of rendered) {
    const verdict =
      r.snapshot.verdict_score === null
        ? "unranked"
        : `${r.snapshot.verdict_score >= 0 ? "+" : "−"}${Math.round(Math.abs(r.snapshot.verdict_score) * 1000)}σ`;
    lines.push(
      `| ${r.candidate.handle} | \`${r.snapshot.display_slug}\` | ${verdict} | ${r.snapshot.resolved_calls} · ${r.snapshot.pending_calls} | [${dmFilename(r)}](${dmFilename(r)}) |`,
    );
  }
  lines.push(
    ``,
    `## Send order`,
    ``,
    `Send in batches of 3 over 48–72h to avoid pattern flags. Track responses inline in each per-candidate file under a "## Replies" section.`,
    ``,
    `## Reply rubric`,
    ``,
    `- **No reply within 96h** → polite single follow-up referencing one of their recent calls.`,
    `- **"What is Murmur?"** → reply with /launch URL + one-line tagline. Never a wall of text.`,
    `- **Wants to claim** → guide them to the share/claim URL; the claim page walks the rest.`,
    `- **Pushback on shadow tracking** → de-escalate, offer to remove the shadow profile if requested. The point is consent.`,
    ``,
    `## Channels`,
    ``,
    `Default to X DM. Telegram only if they have a public bot or have invited DMs. Never spam group channels with the share URL.`,
    ``,
  );
  return lines.join("\n");
}

function dmFilename(r: RenderedDm): string {
  const safe = r.candidate.handle.replace(/^@/, "").toLowerCase();
  return `${safe}.md`;
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const rendered: RenderedDm[] = [];
  for (const c of CANDIDATES) {
    try {
      const snap = await fetchSnapshot(c.slug);
      const r = renderDm(c, snap);
      rendered.push(r);
      writeFileSync(`${OUTPUT_DIR}/${dmFilename(r)}`, renderDmFile(r), "utf8");
      console.log(`  wrote ${dmFilename(r)}`);
    } catch (err) {
      console.warn(`  ! skipping ${c.handle}: ${(err as Error).message}`);
    }
  }
  if (rendered.length > 0) {
    writeFileSync(`${OUTPUT_DIR}/INDEX.md`, renderIndex(rendered), "utf8");
    console.log(`  wrote INDEX.md`);
  }
  console.log(`\nGenerated ${rendered.length}/${CANDIDATES.length} DMs in ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
