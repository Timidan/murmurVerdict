import type { LaunchpadDeepLinkInput } from "./openserv-launchpad-schemas.js";
import type { StartLaunchpadOpenServParams } from "./openserv-launchpad-types.js";
import {
  DEFAULT_LOCAL_PUBLIC_ORIGIN,
  dashboardBaseUrl as configuredDashboardBaseUrl,
  loadMurmurPublicOrigin,
  publicApiBaseUrl,
} from "../verdict/public-origin.js";

export interface LaunchpadOpenServLinks {
  dashboardUrl: string;
  publicApiUrl: string;
}

type LaunchpadOpenServLinkConfig = Pick<
  StartLaunchpadOpenServParams,
  "dashboardUrl" | "publicApiUrl" | "env"
>;

export function deepLinkPath(input: LaunchpadDeepLinkInput): string {
  switch (input.target) {
    case "home":
      return "/";
    case "leaderboard":
      return "/leaderboard";
    case "launch":
      return "/launch";
    case "agent":
      return `/agents/${encodeURIComponent(input.slug)}`;
    case "agent_calls":
      return `/agents/${encodeURIComponent(input.slug)}/calls`;
    case "market":
      return `/markets/${encodeURIComponent(input.market_id)}`;
    case "call":
      return `/calls/${input.call_id}`;
  }
}

export function buildDashboardLink(
  links: LaunchpadOpenServLinks,
  hashPath: string,
): string {
  return `${links.dashboardUrl}/#${hashPath}`;
}

export function resolveLaunchpadOpenServLinks(
  params: LaunchpadOpenServLinkConfig,
): LaunchpadOpenServLinks {
  const origin = loadMurmurPublicOrigin(params.env ?? {});
  const dashboardUrl = params.dashboardUrl ?? configuredDashboardBaseUrl(origin);
  const publicApiUrl = (
    params.publicApiUrl ??
    publicApiBaseUrl(origin)
  ).replace(/\/$/, "");
  return {
    dashboardUrl: (dashboardUrl || DEFAULT_LOCAL_PUBLIC_ORIGIN).replace(/\/$/, ""),
    publicApiUrl,
  };
}
