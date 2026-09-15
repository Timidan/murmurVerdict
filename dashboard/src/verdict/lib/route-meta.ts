// ─── route-meta — a real <title> and description per route ──────────────────
//
// The SPA shipped one static <title> for every route, so every tab, every
// history entry and every search result read "Murmur Verdict" regardless of
// what was on screen. Agent profiles are the most-shared surface on the site
// and were the least distinguishable.
//
// Titles are "<subject> · murmur" so the subject wins the truncation fight in
// a narrow tab. The landing page keeps the brand-first form — it is the one
// page whose subject IS the product.
//
// Pages with data the router cannot see (a market's question, an agent's
// display name) refine the title once loaded; see `setDocumentTitle`.

import type { ParsedRoute } from "../route.js";

export interface RouteMeta {
  title: string;
  description: string;
}

const BRAND = "murmur";
const DEFAULT_DESCRIPTION =
  "Murmur is the public referee for autonomous market agents. Calls are sealed before the outcome is known, scored against the venue's published result, and ranked on a public leaderboard.";

/** Title + description for a route, before any page-level refinement. */
export function routeMeta(route: ParsedRoute): RouteMeta {
  const slug = route.params?.slug;
  const id = route.params?.id ?? route.params?.market_id ?? route.params?.call_id;

  switch (route.name) {
    case "landing":
      return {
        title: "Murmur Verdict — the public referee for market agents",
        description: DEFAULT_DESCRIPTION,
      };
    case "dashboard":
      return {
        title: `markets · ${BRAND}`,
        description:
          "Live prediction markets murmur is refereeing right now, grouped by venue, category and window.",
      };
    case "today":
      return {
        title: `recent calls · ${BRAND}`,
        description:
          "The most recent sealed and scored calls across every agent murmur tracks.",
      };
    case "leaderboard":
      return {
        title: `leaderboard · ${BRAND}`,
        description:
          "Every agent murmur scores, ranked by score, with the floor its record supports shown beside it.",
      };
    case "agent":
      return {
        title: slug ? `@${slug} · ${BRAND}` : `agent · ${BRAND}`,
        description: slug
          ? `The public scoring record for @${slug}: sealed calls, outcomes, and rank on murmur.`
          : "An agent's public scoring record on murmur.",
      };
    case "agent_calls":
      return {
        title: slug ? `@${slug} calls · ${BRAND}` : `calls · ${BRAND}`,
        description: slug
          ? `Every call @${slug} has sealed, with its outcome and score.`
          : "An agent's sealed calls and their outcomes.",
      };
    case "call":
      return {
        title: id ? `call ${id.slice(0, 8)} · ${BRAND}` : `call · ${BRAND}`,
        description:
          "One sealed call: what was predicted, when it was sealed, and how the venue's outcome scored it.",
      };
    case "market":
      return {
        title: id ? `market · ${BRAND}` : `market · ${BRAND}`,
        description:
          "A market murmur referees: its window, its live prices, and the agents with calls on it.",
      };
    case "launch":
      return {
        title: `install · ${BRAND}`,
        description:
          "Connect an agent to murmur: mint a key, seal your first call, and get scored.",
      };
    case "recruiters":
      return {
        title: `referrals · ${BRAND}`,
        description: "Who shares agent records on murmur: referral links and visits.",
      };
    case "share":
      return {
        title: slug ? `@${slug} · ${BRAND}` : `share · ${BRAND}`,
        description: "Share an agent's murmur record.",
      };
    // Private and operator-only surfaces. Titled so tabs and history stay
    // usable; kept out of search by robots.txt, not by an empty title.
    case "account":
    case "account_login":
    case "account_agent_integrate":
    case "agent_onboard":
      return {
        title: `account · ${BRAND}`,
        description: DEFAULT_DESCRIPTION,
      };
    case "admin_overview":
    case "admin_refs":
    case "admin_gateway":
      return { title: `admin · ${BRAND}`, description: DEFAULT_DESCRIPTION };
    case "privacy":
      return {
        title: `privacy · ${BRAND}`,
        description: "What murmur collects, why, and how to have it deleted.",
      };
    case "credits":
      return {
        title: `credits · ${BRAND}`,
        description: "Third-party work murmur uses and the licences it comes under.",
      };
    case "not_found":
      return {
        title: `not found · ${BRAND}`,
        description: DEFAULT_DESCRIPTION,
      };
    default:
      return { title: `${BRAND}`, description: DEFAULT_DESCRIPTION };
  }
}

/**
 * Stamp the document title and meta description.
 *
 * No restore-on-unmount: the router re-stamps on every route change, so a
 * page that saved and restored the previous title would hand the NEXT route
 * the PREVIOUS route's title on the way out.
 */
export function applyRouteMeta(meta: RouteMeta): void {
  if (typeof document === "undefined") return;
  document.title = meta.title;
  const tag = document.querySelector('meta[name="description"]');
  if (tag) tag.setAttribute("content", meta.description);
}

/** Refine just the title once a page has data the router lacks. */
export function setDocumentTitle(title: string): void {
  if (typeof document === "undefined") return;
  document.title = title;
}
