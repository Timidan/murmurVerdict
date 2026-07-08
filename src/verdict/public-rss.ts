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

export interface PublicPlaintextRssCallRow extends PublicRssCallRowBase {
  is_sealed_scrubbed?: false;
  asset_id: string;
  side: "BUY" | "SELL";
  horizon_hours: number;
  confidence: number;
}

export type PublicRssCallRow =
  | PublicSealedRssCallRow
  | PublicPlaintextRssCallRow;

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
      if (r.is_sealed_scrubbed) {
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
      }
      const adapterId = r.adapter_id ?? "native-price";
      const isNativePrice = adapterId === "native-price";
      const subjectAsset = r.asset_id.split(":").pop() ?? r.asset_id;
      const title = `${r.side} ${subjectAsset} ${r.horizon_hours}h · ${titleAction}`;
      const pubDate = new Date(r.resolved_at ?? r.accepted_at).toUTCString();
      const returnSegment =
        isResolved && isNativePrice
          ? ` · signed_return ${r.signed_return ?? "—"}`
          : "";
      const description = isResolved
        ? `${r.side} ${subjectAsset} ${r.horizon_hours}h @ ${(r.confidence * 100).toFixed(0)}% conf · outcome ${r.outcome}${returnSegment} · score ${r.call_score?.toFixed(3) ?? "—"}`
        : `${r.side} ${subjectAsset} ${r.horizon_hours}h @ ${(r.confidence * 100).toFixed(0)}% conf · pending t1`;
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
