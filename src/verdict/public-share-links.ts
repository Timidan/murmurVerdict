import {
  dashboardWebOrigin,
  type MurmurPublicOrigin,
} from "./public-origin.js";

export interface PublicShareLinks {
  slug: string;
  ogPng: string;
  dashboardOrigin: string;
  dashHash: string;
}

export function publicShareLinks(input: {
  slug: unknown;
  publicOrigin: MurmurPublicOrigin;
  apiOrigin: string;
}): PublicShareLinks {
  const slug = String(input.slug ?? "");
  const dashboardOrigin = dashboardWebOrigin(input.publicOrigin);
  const apiOrigin = input.apiOrigin.replace(/\/+$/, "");
  const encodedSlug = encodeURIComponent(slug);
  const dashHash = dashboardOrigin
    ? `${dashboardOrigin}/#/agents/${encodedSlug}`
    : "";

  return {
    slug,
    ogPng: `${apiOrigin}/v1/og/${encodedSlug}.png`,
    dashboardOrigin,
    dashHash,
  };
}
