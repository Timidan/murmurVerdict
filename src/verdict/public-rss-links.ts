// ─── public-rss-links — absolute dashboard links for the agent RSS feed ─────
//
// RSS 2.0 requires absolute <link>s. The caller supplies the origin (configured dashboard URL,
// else the served origin): no invented default, and no Origin/Referer sniffing, since the feed
// is publicly cached without `Vary`.

export interface PublicRssDashboardLinks {
  agent(slug: string): string;
  call(callId: string): string;
}

export function publicRssDashboardLinks(origin: string): PublicRssDashboardLinks {
  const base = origin.trim().replace(/\/+$/, "");
  return {
    agent: (slug) => `${base}/#/agents/${encodeURIComponent(slug)}`,
    call: (callId) => `${base}/#/calls/${encodeURIComponent(callId)}`,
  };
}
