const BADGE_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=300";
const OG_CACHE_CONTROL = "public, max-age=120, stale-while-revalidate=600";
const SVG_CONTENT_TYPE = "image/svg+xml; charset=utf-8";
const PNG_CONTENT_TYPE = "image/png";
const BADGE_PNG_WIDTH = 640;
const OG_PNG_WIDTH = 1200;

export type PublicSyndicationMediaVariant = "badge" | "og";
export type PublicSyndicationMediaFormat = "svg" | "png";

export interface PublicSyndicationMediaPolicy {
  cacheControl: string;
  contentType: string;
  pngWidth?: number;
}

export interface PublicSyndicationMediaEndpoint {
  path: string;
  variant: PublicSyndicationMediaVariant;
  format: PublicSyndicationMediaFormat;
}

const PUBLIC_SYNDICATION_MEDIA_ENDPOINTS: ReadonlyArray<PublicSyndicationMediaEndpoint> = [
  { path: "/v1/badge/:slug.svg", variant: "badge", format: "svg" },
  { path: "/v1/og/:slug.svg", variant: "og", format: "svg" },
  { path: "/v1/badge/:slug.png", variant: "badge", format: "png" },
  { path: "/v1/og/:slug.png", variant: "og", format: "png" },
];

export function publicSyndicationMediaEndpoints(): ReadonlyArray<PublicSyndicationMediaEndpoint> {
  return PUBLIC_SYNDICATION_MEDIA_ENDPOINTS;
}

export function publicSyndicationMediaPolicy(input: {
  variant: PublicSyndicationMediaVariant;
  format: PublicSyndicationMediaFormat;
}): PublicSyndicationMediaPolicy {
  return {
    cacheControl: input.variant === "badge"
      ? BADGE_CACHE_CONTROL
      : OG_CACHE_CONTROL,
    contentType: input.format === "svg" ? SVG_CONTENT_TYPE : PNG_CONTENT_TYPE,
    ...(input.format === "png"
      ? { pngWidth: input.variant === "badge" ? BADGE_PNG_WIDTH : OG_PNG_WIDTH }
      : {}),
  };
}
