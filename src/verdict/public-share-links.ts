import {
  dashboardWebOrigin,
  type MurmurPublicOrigin,
} from "./public-origin.js";
import {
  sanitizeRef,
} from "./ref-token.js";

export interface PublicShareLinks {
  slug: string;
  ogPng: string;
  dashboardOrigin: string;
  dashHash: string;
}

export function publicShareLinks(input: {
  slug: unknown;
  ref: unknown;
  publicOrigin: MurmurPublicOrigin;
  apiOrigin: string;
}): PublicShareLinks {
  const slug = String(input.slug ?? "");
  const ref = sanitizeRef(input.ref);
  const dashboardOrigin = dashboardWebOrigin(input.publicOrigin);
  const apiOrigin = input.apiOrigin.replace(/\/+$/, "");
  const encodedSlug = encodeURIComponent(slug);
  const dashHash = dashboardOrigin
    ? `${dashboardOrigin}/#/share/${encodedSlug}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`
    : "";

  return {
    slug,
    ogPng: `${apiOrigin}/v1/og/${encodedSlug}.png`,
    dashboardOrigin,
    dashHash,
  };
}
