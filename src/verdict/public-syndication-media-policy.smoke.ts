import { strict as assert } from "node:assert";

import {
  publicSyndicationMediaEndpoints,
  publicSyndicationMediaPolicy,
} from "./public-syndication-media-policy.js";

process.stdout.write("murmur public syndication media policy smoke\n");

assert.deepEqual(
  publicSyndicationMediaPolicy({ variant: "badge", format: "svg" }),
  {
    cacheControl: "public, max-age=30, stale-while-revalidate=300",
    contentType: "image/svg+xml; charset=utf-8",
  },
);
assert.deepEqual(
  publicSyndicationMediaPolicy({ variant: "badge", format: "png" }),
  {
    cacheControl: "public, max-age=30, stale-while-revalidate=300",
    contentType: "image/png",
    pngWidth: 640,
  },
);
assert.deepEqual(
  publicSyndicationMediaPolicy({ variant: "og", format: "svg" }),
  {
    cacheControl: "public, max-age=120, stale-while-revalidate=600",
    contentType: "image/svg+xml; charset=utf-8",
  },
);
assert.deepEqual(
  publicSyndicationMediaPolicy({ variant: "og", format: "png" }),
  {
    cacheControl: "public, max-age=120, stale-while-revalidate=600",
    contentType: "image/png",
    pngWidth: 1200,
  },
);
assert.deepEqual(publicSyndicationMediaEndpoints(), [
  { path: "/v1/badge/:slug.svg", variant: "badge", format: "svg" },
  { path: "/v1/og/:slug.svg", variant: "og", format: "svg" },
  { path: "/v1/badge/:slug.png", variant: "badge", format: "png" },
  { path: "/v1/og/:slug.png", variant: "og", format: "png" },
]);

process.stdout.write("public syndication media policy smoke ok\n");
