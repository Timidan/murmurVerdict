export interface ParsedRoute {
  name:
    | "landing"
    | "dashboard"
    | "leaderboard"
    | "today"
    | "agent"
    | "agent_calls"
    | "call"
    | "launch"
    | "share"
    | "recruiters"
    | "admin_refs"
    | "admin_gateway"
    | "admin_overview"
    | "market"
    | "account"
    | "account_login"
    | "account_agent_settings"
    | "account_agent_integrate"
    | "agent_onboard"
    | "logo"
    | "spec"
    | "not_found";
  params?: Record<string, string>;
}

interface LocationLike {
  pathname: string;
  hash: string;
  search?: string;
}

/**
 * Read the active route's query params, resolving whichever routing mode is
 * live: hash-mode links (`#/leaderboard?tier=main`) carry the query inside the
 * hash, while path-mode URLs (`/leaderboard?tier=main`) carry it in
 * `location.search`. Never throws — a malformed query resolves to an empty set.
 */
export function readRouteQuery(location: LocationLike): URLSearchParams {
  let qs = "";
  if (location.hash.startsWith("#/")) {
    const qIdx = location.hash.indexOf("?");
    qs = qIdx >= 0 ? location.hash.slice(qIdx + 1) : "";
  } else {
    qs = (location.search ?? "").replace(/^\?/, "");
  }
  try {
    return new URLSearchParams(qs);
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Build a same-route URL carrying `params` as its query string, preserving the
 * active routing mode so we never produce a doubled `/leaderboard#/leaderboard`
 * address. Feed the result to `history.replaceState`: it updates the address
 * bar for bookmarking/sharing without a navigation, reload, or scroll jump
 * (replaceState fires neither `popstate` nor `hashchange`).
 */
export function buildRouteQueryUrl(location: LocationLike, params: URLSearchParams): string {
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : "";
  if (location.hash.startsWith("#/")) {
    const base = location.hash.slice(1).split("?")[0];
    return `#${base}${suffix}`;
  }
  return `${location.pathname}${suffix}`;
}

/** Resolve normal browser paths, while keeping legacy #/ links working. */
export function parseLocation(location: LocationLike): ParsedRoute {
  const hashPath = location.hash.startsWith("#/") ? location.hash.slice(1) : "";
  const raw = hashPath || location.pathname || "/";
  const qIdx = raw.indexOf("?");
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;

  if (path === "/" || path === "" || path === "/landing") return { name: "landing" };
  if (path === "/dashboard") return { name: "dashboard" };
  if (path === "/today") return { name: "today" };
  if (path === "/leaderboard") return { name: "leaderboard" };
  // /install is the canonical path (matches the "install" label everywhere
  // in the UI); /launch survives as an alias so old links keep working.
  if (path === "/install" || path === "/launch") return { name: "launch" };
  if (path === "/recruiters") return { name: "recruiters" };
  if (path === "/admin/refs") return { name: "admin_refs" };
  if (path === "/admin/gateway") return { name: "admin_gateway" };
  if (path === "/admin/overview") return { name: "admin_overview" };
  // /spec and /logo are dev-only scaffolding pages — production builds
  // resolve them to the existing 404 route (import.meta.env.DEV is
  // statically false in `vite build`).
  if (path === "/spec") {
    return import.meta.env.DEV ? { name: "spec" } : { name: "not_found", params: { path } };
  }
  if (path === "/logo") {
    return import.meta.env.DEV ? { name: "logo" } : { name: "not_found", params: { path } };
  }
  if (path === "/account") return { name: "account" };
  if (path === "/account/login") return { name: "account_login" };
  if (path === "/agent/onboard") return { name: "agent_onboard" };

  const agentIntegrateMatch = /^\/account\/agent\/([^/]+)\/integrate$/.exec(path);
  if (agentIntegrateMatch) {
    return { name: "account_agent_integrate", params: { slug: agentIntegrateMatch[1] } };
  }

  const agentSettingsMatch = /^\/account\/agent\/([^/]+)(?:\/(payout|wallet|runtime|keys))?$/.exec(path);
  if (agentSettingsMatch) {
    return {
      name: "account_agent_settings",
      params: { slug: agentSettingsMatch[1], tab: agentSettingsMatch[2] ?? "payout" },
    };
  }

  const shareMatch = /^\/share\/([^/]+)$/.exec(path);
  if (shareMatch) return { name: "share", params: { slug: shareMatch[1] } };

  // Bare /markets (with or without trailing slash) has no detail id — land on
  // the dashboard grid rather than falling through to the marketing page.
  if (path === "/markets" || path === "/markets/") return { name: "dashboard" };

  const marketMatch = /^\/markets\/(.+)$/.exec(path);
  if (marketMatch) {
    try {
      return { name: "market", params: { market_id: decodeURIComponent(marketMatch[1]) } };
    } catch {
      // Malformed percent-encoding in the id — a broken link, not a landing visit.
      return { name: "not_found", params: { path } };
    }
  }

  const callMatch = /^\/calls\/(.+)$/.exec(path);
  if (callMatch) return { name: "call", params: { call_id: callMatch[1] } };
  const agentCalls = /^\/agents\/([^/]+)\/calls$/.exec(path);
  if (agentCalls) return { name: "agent_calls", params: { slug: agentCalls[1] } };
  const agent = /^\/agents\/([^/]+)$/.exec(path);
  if (agent) return { name: "agent", params: { slug: agent[1] } };
  // Unknown URL → real 404 (carrying the unmatched path) instead of silently
  // rendering the landing page under a bad address.
  return { name: "not_found", params: { path } };
}
