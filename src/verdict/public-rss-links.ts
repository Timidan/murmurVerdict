// No invented default. `murmur.verdict` used to sit here, and `.verdict` is
// not a real TLD — every RSS item emitted without an Origin/Referer header
// (which is every feed reader, since they are not browsers) carried a link to
// a domain that cannot resolve. The configured dashboard origin is the honest
// source; a request's own headers refine it; nothing else is guessed.

export interface PublicRssDashboardLinks {
  agent(slug: string): string;
  call(callId: string): string;
}

export function publicRssDashboardLinks(input: {
  originHeader?: string;
  refererHeader?: string;
  /** Configured dashboard origin (MURMUR_DASHBOARD_URL, else the public API
   *  url) — what a feed reader gets, since it sends no Origin or Referer. */
  configuredOrigin?: string | null;
} = {}): PublicRssDashboardLinks {
  const dashboardOrigin = publicRssDashboardOrigin(input);
  return {
    agent: (slug) => `${dashboardOrigin}/#/agents/${encodeURIComponent(slug)}`,
    call: (callId) => `${dashboardOrigin}/#/calls/${encodeURIComponent(callId)}`,
  };
}

export function publicRssDashboardOrigin(input: {
  originHeader?: string;
  refererHeader?: string;
  configuredOrigin?: string | null;
} = {}): string {
  // Configured origin FIRST: it is the deployment's own statement of where the
  // dashboard lives, and it is the only one a feed reader will ever get.
  // Headers refine it for a browser-issued request. An unconfigured deploy
  // yields relative links rather than links to somewhere that does not exist.
  const chosen =
    input.configuredOrigin ?? input.originHeader ?? input.refererHeader ?? "";
  return chosen.replace(/\/$/, "");
}
