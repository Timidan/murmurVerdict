// ─── public-rss-links — absolute dashboard links for the agent RSS feed ─────
//
// RSS 2.0 requires <link> to start with a registered URI scheme, and the
// channel <link> is mandatory. So these MUST be absolute: a relative href is
// invalid RSS, not merely ugly.
//
// Two things this deliberately does NOT do:
//
//   · No invented default. `https://murmur.verdict` used to sit here as a
//     fallback, and `.verdict` is not a TLD — every item in every feed pointed
//     at a domain that cannot resolve. Feed readers are not browsers.
//
//   · No Origin/Referer sniffing. Those headers are caller-controlled, and the
//     feed is served `public, max-age=60` with no `Vary`, so honouring them
//     would let one request bake attacker-chosen links into a shared cache
//     that every later reader gets.
//
// The origin is therefore supplied by the caller: the configured dashboard
// URL, else the origin the request was actually served on.

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
