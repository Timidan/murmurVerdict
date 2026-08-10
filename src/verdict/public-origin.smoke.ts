import assert from "node:assert/strict";
import type { Request } from "express";

import {
  DEFAULT_LOCAL_PUBLIC_ORIGIN,
  MurmurPublicOriginConfigError,
  dashboardBaseUrl,
  dashboardWebOrigin,
  loadMurmurPublicOrigin,
  publicApiBaseUrl,
  publicApiUrlForRequest,
} from "./public-origin.js";

const empty = loadMurmurPublicOrigin({});
assert.equal(empty.publicApiUrl, null);
assert.equal(empty.dashboardUrl, null);
assert.equal(publicApiBaseUrl(empty), DEFAULT_LOCAL_PUBLIC_ORIGIN);
assert.equal(dashboardBaseUrl(empty), "");

const publicOnly = loadMurmurPublicOrigin({
  MURMUR_PUBLIC_URL: " https://api.murmur.example/v1/ ",
});
assert.equal(publicOnly.publicApiUrl, "https://api.murmur.example/v1");
assert.equal(publicOnly.dashboardUrl, "https://api.murmur.example/v1");

const configured = loadMurmurPublicOrigin({
  MURMUR_DASHBOARD_URL: " https://dashboard.murmur.example/app/ ",
  MURMUR_PUBLIC_URL: " http://api.murmur.example/ ",
});
assert.equal(configured.dashboardUrl, "https://dashboard.murmur.example/app");
assert.equal(configured.publicApiUrl, "http://api.murmur.example");
assert.equal(dashboardWebOrigin(configured), "https://dashboard.murmur.example");

const req = {
  protocol: "https",
  get(name: string) {
    assert.equal(name, "host");
    return "request-origin.example";
  },
} as Request;
assert.equal(
  publicApiUrlForRequest(empty, req),
  "https://request-origin.example",
);

assert.throws(
  () => loadMurmurPublicOrigin({ MURMUR_PUBLIC_URL: "not-a-url" }),
  (err) =>
    err instanceof MurmurPublicOriginConfigError &&
    err.key === "MURMUR_PUBLIC_URL",
);
assert.throws(
  () => loadMurmurPublicOrigin({ MURMUR_DASHBOARD_URL: "ftp://dashboard.example" }),
  (err) =>
    err instanceof MurmurPublicOriginConfigError &&
    err.key === "MURMUR_DASHBOARD_URL",
);

console.log("public-origin smoke ok");
