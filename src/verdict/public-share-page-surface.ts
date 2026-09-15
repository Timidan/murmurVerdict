import type Database from "better-sqlite3";

import type { MurmurPublicOrigin } from "./public-origin.js";
import { escapeHtml } from "./public-rendering.js";
import {
  publicShareLinks,
} from "./public-share-links.js";
import { agentsRepo, type AgentRow } from "./repos/agents-repo.js";

const PUBLIC_SHARE_PAGE_CONTENT_TYPE = "text/html; charset=utf-8";
const PUBLIC_SHARE_PAGE_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

export interface PublicSharePageResponse {
  status: 200;
  headers: {
    "Content-Type": typeof PUBLIC_SHARE_PAGE_CONTENT_TYPE;
    "Cache-Control": typeof PUBLIC_SHARE_PAGE_CACHE_CONTROL;
  };
  body: string;
}

export interface PublicSharePageResponseTarget {
  setHeader(name: string, value: string): unknown;
  status(code: number): { send(body: string): unknown };
}

export function sendPublicSharePageResponse(
  res: PublicSharePageResponseTarget,
  result: PublicSharePageResponse,
): void {
  for (const [name, value] of Object.entries(result.headers)) {
    res.setHeader(name, value);
  }
  res.status(result.status).send(result.body);
}

export function publicSharePageResponse(input: {
  db: Database.Database;
  slug: string;
  ref: unknown;
  publicOrigin: MurmurPublicOrigin;
  apiOrigin: string;
}): PublicSharePageResponse {
  const links = publicShareLinks(input);
  const agent = agentsRepo.bySlug(input.db, links.slug);

  return {
    status: 200,
    headers: {
      "Content-Type": PUBLIC_SHARE_PAGE_CONTENT_TYPE,
      "Cache-Control": PUBLIC_SHARE_PAGE_CACHE_CONTROL,
    },
    body: renderPublicSharePage({
      agent,
      slug: links.slug,
      ogPng: links.ogPng,
      dashboardOrigin: links.dashboardOrigin,
      dashHash: links.dashHash,
    }),
  };
}

function renderPublicSharePage(input: {
  agent: AgentRow | null;
  slug: string;
  ogPng: string;
  dashboardOrigin: string;
  dashHash: string;
}): string {
  const title = input.agent
    ? `${input.agent.display_name} - Murmur Verdict`
    : `${input.slug} - Murmur Verdict`;
  const description = input.agent
    ? `Live verdict for ${input.agent.display_name} (@${input.agent.display_slug}) - scored against the external venue's own resolution.`
    : "The public referee for autonomous market agents.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />

  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:image" content="${escapeHtml(input.ogPng)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:type" content="image/png" />
  ${input.dashboardOrigin ? `<meta property="og:url" content="${escapeHtml(input.dashHash)}" />` : ""}

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(input.ogPng)}" />

  ${input.dashboardOrigin ? `<meta http-equiv="refresh" content="0; url=${escapeHtml(input.dashHash)}" />` : ""}
  <style>
    html, body { margin:0; padding:0; background:#000; color:#fff; font-family: ui-monospace, "SF Mono", monospace; }
    body { display:flex; min-height:100dvh; align-items:center; justify-content:center; padding:48px; }
    a { color:#fff; }
    img { max-width:100%; height:auto; display:block; margin:24px auto; }
    .meta { text-transform:uppercase; letter-spacing:0.16em; font-size:11px; color:#888; }
  </style>
</head>
<body>
  <div>
    <div class="meta">murmur.verdict &middot; ${input.agent ? "agent" : "share"}</div>
    <h1 style="font-weight:500;font-size:24px;margin:8px 0 0;">${escapeHtml(title)}</h1>
    <img src="${escapeHtml(input.ogPng)}" alt="${escapeHtml(title)}" width="1200" height="630" />
    <p style="font-size:13px;color:#999;">
      ${input.dashboardOrigin
        ? `Redirecting to <a href="${escapeHtml(input.dashHash)}">${escapeHtml(input.dashHash)}</a> ...`
        : ""}
    </p>
  </div>
</body>
</html>`;
}
