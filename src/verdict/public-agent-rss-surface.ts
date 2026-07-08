import type Database from "better-sqlite3";

import {
  rssAgentFeed,
  rssEmpty,
} from "./public-rendering.js";
import type { PublicAgentRssQuery } from "./public-agent-query.js";
import type { PublicRssDashboardLinks } from "./public-rss-links.js";
import {
  agentsRepo,
} from "./repos/agents-repo.js";
import {
  listPublicAgentCallProjections,
  publicRssCallRow,
} from "./sealed-call-public-projection.js";

const PUBLIC_AGENT_RSS_CONTENT_TYPE = "application/rss+xml; charset=utf-8";
const PUBLIC_AGENT_RSS_EMPTY_CONTENT_TYPE = "application/xml";
const PUBLIC_AGENT_RSS_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

export type PublicAgentRssResponse =
  | {
      status: 200;
      headers: {
        "Content-Type": typeof PUBLIC_AGENT_RSS_CONTENT_TYPE;
        "Cache-Control": typeof PUBLIC_AGENT_RSS_CACHE_CONTROL;
      };
      body: string;
    }
  | {
      status: 404;
      headers: {
        "Content-Type": typeof PUBLIC_AGENT_RSS_EMPTY_CONTENT_TYPE;
      };
      body: string;
    };

export interface PublicAgentRssResponseTarget {
  setHeader(name: string, value: string): unknown;
  status(code: number): { send(body: string): unknown };
}

export function sendPublicAgentRssResponse(
  res: PublicAgentRssResponseTarget,
  result: PublicAgentRssResponse,
): void {
  for (const [name, value] of Object.entries(result.headers)) {
    res.setHeader(name, value);
  }
  res.status(result.status).send(result.body);
}

export function publicAgentRssResponse(input: {
  db: Database.Database;
  slug: string;
  query: PublicAgentRssQuery;
  dashboardLinks: PublicRssDashboardLinks;
}): PublicAgentRssResponse {
  const slug = String(input.slug ?? "");
  const agent = agentsRepo.bySlug(input.db, slug);
  if (!agent) {
    return {
      status: 404,
      headers: {
        "Content-Type": PUBLIC_AGENT_RSS_EMPTY_CONTENT_TYPE,
      },
      body: rssEmpty(slug, "agent not found"),
    };
  }

  const rows = listPublicAgentCallProjections({
    db: input.db,
    agent_id: agent.agent_id,
    limit: input.query.limit,
  }).map(publicRssCallRow);

  return {
    status: 200,
    headers: {
      "Content-Type": PUBLIC_AGENT_RSS_CONTENT_TYPE,
      "Cache-Control": PUBLIC_AGENT_RSS_CACHE_CONTROL,
    },
    body: rssAgentFeed(
      agent,
      rows,
      input.dashboardLinks,
    ),
  };
}
