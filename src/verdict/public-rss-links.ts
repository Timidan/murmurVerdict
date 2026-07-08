export const DEFAULT_RSS_DASHBOARD_ORIGIN = "https://murmur.verdict";

export interface PublicRssDashboardLinks {
  agent(slug: string): string;
  call(callId: string): string;
}

export function publicRssDashboardLinks(input: {
  originHeader?: string;
  refererHeader?: string;
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
} = {}): string {
  return (
    input.originHeader ??
    input.refererHeader ??
    DEFAULT_RSS_DASHBOARD_ORIGIN
  ).replace(/\/$/, "");
}
