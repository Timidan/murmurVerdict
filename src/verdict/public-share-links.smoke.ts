import { strict as assert } from "node:assert";

import {
  publicShareLinks,
} from "./public-share-links.js";

process.stdout.write("murmur public share links smoke\n");

assert.deepEqual(
  publicShareLinks({
    slug: "share/slash",
    ref: " ally! ",
    publicOrigin: {
      publicApiUrl: "https://api.example",
      dashboardUrl: "https://dashboard.example/app/",
    },
    apiOrigin: "https://request.example/",
  }),
  {
    slug: "share/slash",
    ogPng: "https://request.example/v1/og/share%2Fslash.png",
    dashboardOrigin: "https://dashboard.example",
    dashHash: "https://dashboard.example/#/share/share%2Fslash?ref=ally",
  },
);

assert.deepEqual(
  publicShareLinks({
    slug: "missing<script>",
    ref: "!!!",
    publicOrigin: {
      publicApiUrl: null,
      dashboardUrl: null,
    },
    apiOrigin: "https://request.example///",
  }),
  {
    slug: "missing<script>",
    ogPng: "https://request.example/v1/og/missing%3Cscript%3E.png",
    dashboardOrigin: "",
    dashHash: "",
  },
);

process.stdout.write("public share links smoke ok\n");
