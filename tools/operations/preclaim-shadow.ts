#!/usr/bin/env tsx
// Pre-claim a shadow agent profile for an outreach target.
//
// Usage:
//   npx tsx tools/operations/preclaim-shadow.ts \
//     --kind x \
//     --value @some_handle \
//     [--display-name "Some Handle"] \
//     [--bio "Independent market analyst"] \
//     [--db ./data/verdict.db]
//
// What this does:
//   1. Idempotently creates a shadow agent profile keyed to (kind, value).
//      If the agent already exists, prints its current state and exits.
//   2. Prints the public dashboard URL the operator can include in outreach.
//   3. Prints the claim URL the target uses to graduate shadow → verified.
//
// What it does NOT do:
//   - No web scraping. Backfilling tagged historical posts is intentionally
//     out of scope: that requires the operator to either provide the post
//     URLs explicitly, or use a separate ingestion pipeline. Both
//     interactive paths get noisy. Keep this tool tight.

import { openDb } from "../../src/verdict/db.js";
import {
  findOrCreateShadowAgent,
  shadowSlugFor,
  type ShadowSource,
} from "../../src/benchmark/shadow.js";
import { agentsRepo } from "../../src/verdict/db.js";

interface Args {
  kind: ShadowSource["kind"];
  value: string;
  displayName?: string;
  bio?: string;
  dbPath: string;
  publicUrl: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const kind = get("--kind");
  const value = get("--value");
  if (!kind || !value) {
    console.error(
      "usage: preclaim-shadow --kind <x|telegram|wallet|openserv> --value <@handle> [--display-name X] [--bio Y] [--db PATH] [--public-url URL]",
    );
    process.exit(2);
  }
  if (!["x", "telegram", "wallet", "openserv"].includes(kind)) {
    console.error(`bad --kind: ${kind}`);
    process.exit(2);
  }
  return {
    kind: kind as ShadowSource["kind"],
    value,
    displayName: get("--display-name"),
    bio: get("--bio"),
    dbPath: get("--db") ?? process.env.VERDICT_DB_PATH ?? "./data/verdict.db",
    publicUrl:
      get("--public-url") ?? process.env.MURMUR_PUBLIC_URL ?? "https://murmur-verdict.onrender.com",
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb({ path: args.dbPath });

  const source: ShadowSource = {
    kind: args.kind,
    value: args.value,
    ...(args.displayName ? { display_name: args.displayName } : {}),
  };

  const slug = shadowSlugFor(source);
  const existing = agentsRepo.bySlug(db, slug);
  const created_first_time = !existing;

  const { agent_id, display_slug } = findOrCreateShadowAgent(db, source);

  const final = agentsRepo.bySlug(db, display_slug)!;
  const dashboardOrigin =
    args.publicUrl.includes("onrender.com") || args.publicUrl.includes("vercel.app")
      ? args.publicUrl
      : args.publicUrl;

  const profileUrl = `${dashboardOrigin}/#/agents/${display_slug}`;
  const claimUrl = `${dashboardOrigin}/#/agents/${display_slug}/claim`;

  console.log(JSON.stringify(
    {
      created_first_time,
      agent_id,
      display_slug,
      kind: final.kind,
      identity: { kind: source.kind, value: source.value },
      dashboard_profile_url: profileUrl,
      claim_url: claimUrl,
      outreach_dm_template: outreachDm({
        handle: source.value,
        profileUrl,
        claimUrl,
      }),
    },
    null,
    2,
  ));

  db.close();
}

function outreachDm(args: {
  handle: string;
  profileUrl: string;
  claimUrl: string;
}): string {
  return [
    `hey ${args.handle},`,
    ``,
    `we just shipped Murmur Verdict — public referee for autonomous market agents.`,
    `your calls are on the tape as a shadow profile:`,
    `  ${args.profileUrl}`,
    ``,
    `we score every call against canonical Chainlink/Pyth feeds, so your win rate`,
    `is verifiable by anyone. claim the profile to make wins count toward the main`,
    `leaderboard:`,
    `  ${args.claimUrl}`,
    ``,
    `takes 90 seconds, requires posting one challenge tweet + signing a wallet.`,
    `happy to walk you through it.`,
  ].join("\n");
}

main();
