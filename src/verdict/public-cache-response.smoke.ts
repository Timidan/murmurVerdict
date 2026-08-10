import { strict as assert } from "node:assert";

import {
  sendCacheablePublicResource,
  type CacheablePublicResourceResponse,
} from "./public-cache-response.js";

process.stdout.write("murmur public cache response smoke\n");

class FakeResponse implements CacheablePublicResourceResponse {
  statusCode = 200;
  ended = false;
  body: unknown = null;
  jsonBody: unknown = null;
  headers = new Map<string, string>();

  status(code: number): CacheablePublicResourceResponse {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  send(body: unknown): void {
    this.body = body;
  }

  json(body: unknown): void {
    this.jsonBody = body;
  }

  end(): void {
    this.ended = true;
  }
}

const fresh = new FakeResponse();
assert.equal(
  sendCacheablePublicResource(
    { header: () => undefined },
    fresh,
    {
      body: "<svg />",
      cacheControl: "public, max-age=30, stale-while-revalidate=300",
      contentType: "image/svg+xml; charset=utf-8",
      etag: `W/"abc"`,
    },
  ),
  "sent",
);
assert.equal(fresh.statusCode, 200);
assert.equal(fresh.headers.get("Content-Type"), "image/svg+xml; charset=utf-8");
assert.equal(fresh.headers.get("Cache-Control"), "public, max-age=30, stale-while-revalidate=300");
assert.equal(fresh.headers.get("ETag"), `W/"abc"`);
assert.equal(fresh.body, "<svg />");
assert.equal(fresh.jsonBody, null);
assert.equal(fresh.ended, false);

const json = new FakeResponse();
const jsonBody = { ok: true };
assert.equal(
  sendCacheablePublicResource(
    { header: () => undefined },
    json,
    {
      body: jsonBody,
      bodyMode: "json",
      cacheControl: "public, max-age=300, stale-while-revalidate=900",
      contentType: "application/json; charset=utf-8",
      accessControlAllowOrigin: "*",
    },
  ),
  "sent",
);
assert.equal(json.headers.get("Content-Type"), "application/json; charset=utf-8");
assert.equal(json.headers.get("Cache-Control"), "public, max-age=300, stale-while-revalidate=900");
assert.equal(json.headers.get("Access-Control-Allow-Origin"), "*");
assert.equal(json.jsonBody, jsonBody);
assert.equal(json.body, null);

const cached = new FakeResponse();
assert.equal(
  sendCacheablePublicResource(
    { header: (name) => (name === "If-None-Match" ? `W/"abc"` : undefined) },
    cached,
    {
      body: "<svg />",
      cacheControl: "public, max-age=30, stale-while-revalidate=300",
      contentType: "image/svg+xml; charset=utf-8",
      etag: `W/"abc"`,
    },
  ),
  "not_modified",
);
assert.equal(cached.statusCode, 304);
assert.equal(cached.ended, true);
assert.equal(cached.body, null);
assert.equal(cached.headers.size, 0);

process.stdout.write("  ok cache headers and 304 handling stay together\n");
