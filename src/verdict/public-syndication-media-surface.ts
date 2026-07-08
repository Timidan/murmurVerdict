import type Database from "better-sqlite3";

import {
  renderBadgeSvg,
  renderOgSvg,
  rasterize,
} from "./badge.js";
import type { CacheablePublicResource } from "./public-cache-response.js";
import {
  publicSyndicationMediaPolicy,
  type PublicSyndicationMediaFormat,
  type PublicSyndicationMediaVariant,
} from "./public-syndication-media-policy.js";

export type {
  PublicSyndicationMediaFormat,
  PublicSyndicationMediaVariant,
} from "./public-syndication-media-policy.js";

export function publicSyndicationMediaResource(input: {
  db: Database.Database;
  slug: string;
  variant: PublicSyndicationMediaVariant;
  format: PublicSyndicationMediaFormat;
}): CacheablePublicResource {
  const slug = String(input.slug ?? "");
  const rendered = input.variant === "badge"
    ? renderBadgeSvg(input.db, slug)
    : renderOgSvg(input.db, slug);
  const policy = publicSyndicationMediaPolicy(input);

  if (input.format === "svg") {
    return {
      body: rendered.svg,
      cacheControl: policy.cacheControl,
      contentType: policy.contentType,
      etag: rendered.etag,
    };
  }

  if (policy.pngWidth === undefined) {
    throw new Error("PNG media policy must include pngWidth");
  }
  const rasterized = rasterize(rendered.svg, policy.pngWidth);
  return {
    body: rasterized.png,
    cacheControl: policy.cacheControl,
    contentType: policy.contentType,
    etag: rasterized.etag,
  };
}
