import { xmlEscape } from "./public-escaping.js";
import type { PublicRssDashboardLinks } from "./public-rss-links.js";

export interface PublicRssAgent {
  agent_id: string;
  display_slug: string;
  display_name: string;
}

interface PublicRssCallRowBase {
  call_id: string;
  status: string;
  submitted_at: string;
  accepted_at: string;
  adapter_id?: string;
  market_family?: string;
  outcome: string | null;
  call_score: number | null;
  signed_return: string | null;
  resolved_at: string | null;
}

export interface PublicSealedRssCallRow extends PublicRssCallRowBase {
  is_sealed_scrubbed: true;
}

// There is no plaintext submission mode — every row is operator-blind and
// sealed-scrubbed. `publicRssCallRow` (the sole constructor) always sets
// `is_sealed_scrubbed: true`, so the RSS feed only ever renders sealed items.
export type PublicRssCallRow = PublicSealedRssCallRow;

export function rssEmpty(slug: string, reason: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Murmur Verdict · ${xmlEscape(slug)}</title>
    <description>${xmlEscape(reason)}</description>
  </channel>
</rss>`;
}

export function rssAgentFeed(
  agent: PublicRssAgent,
  rows: PublicRssCallRow[],
  links: PublicRssDashboardLinks,
): string {
  const channelLink = links.agent(agent.display_slug);
  const items = rows
    .map((r) => {
      const itemLink = links.call(r.call_id);
      const isResolved = r.outcome !== null && r.resolved_at !== null;
      const titleAction = isResolved ? r.outcome!.toUpperCase() : "PENDING";
      const title = `[SEALED] ${titleAction}`;
      const description = isResolved
        ? `sealed call · outcome ${r.outcome} · score ${r.call_score?.toFixed(3) ?? "—"}`
        : `sealed call · pending reveal/resolution`;
      const pubDate = new Date(r.resolved_at ?? r.accepted_at).toUTCString();
      return `    <item>
      <title>${xmlEscape(title)}</title>
      <link>${xmlEscape(itemLink)}</link>
      <guid isPermaLink="false">murmur:${xmlEscape(r.call_id)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${xmlEscape(description)}</description>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Murmur Verdict · ${xmlEscape(agent.display_name)}</title>
    <link>${xmlEscape(channelLink)}</link>
    <description>Calls submitted by ${xmlEscape(agent.display_name)} (@${xmlEscape(agent.display_slug)}) and scored against canonical Chainlink + Pyth feeds.</description>
    <generator>murmur-verdict v0.1</generator>
    <ttl>60</ttl>
${items}
  </channel>
</rss>`;
}
