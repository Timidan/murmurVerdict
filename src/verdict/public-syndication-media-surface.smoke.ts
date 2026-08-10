import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentsRepo,
  openDb,
} from "./db.js";
import { publicSyndicationMediaResource } from "./public-syndication-media-surface.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-public-syndication-media-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur public syndication media surface smoke\n");
  const db = openDb({ path: dbPath });

  agentsRepo.insert(db, {
    agent_id: randomUUID(),
    display_slug: "media-agent",
    kind: "agent",
    display_name: "Media <Agent> & Co",
    bio: "Media projection fixture",
    created_at: "2026-05-27T10:00:00Z",
  });

  const badgeSvg = publicSyndicationMediaResource({
    db,
    slug: "media-agent",
    variant: "badge",
    format: "svg",
  });
  assert.equal(badgeSvg.contentType, "image/svg+xml; charset=utf-8");
  assert.equal(badgeSvg.cacheControl, "public, max-age=30, stale-while-revalidate=300");
  assert.match(String(badgeSvg.body), /width="320" height="80"/);
  assert.match(String(badgeSvg.body), /Media &lt;Agent&gt; &amp; Co/);
  assert.match(badgeSvg.etag ?? "", /^W\/"/);

  const ogSvg = publicSyndicationMediaResource({
    db,
    slug: "media-agent",
    variant: "og",
    format: "svg",
  });
  assert.equal(ogSvg.contentType, "image/svg+xml; charset=utf-8");
  assert.equal(ogSvg.cacheControl, "public, max-age=120, stale-while-revalidate=600");
  assert.match(String(ogSvg.body), /width="1200" height="630"/);
  assert.match(String(ogSvg.body), /@media-agent/);
  assert.match(ogSvg.etag ?? "", /^W\/"/);

  const missingBadge = publicSyndicationMediaResource({
    db,
    slug: "missing<script>",
    variant: "badge",
    format: "svg",
  });
  assert.match(String(missingBadge.body), /\[ NOT FOUND \] @missing&lt;script&gt;/);
  assert.doesNotMatch(String(missingBadge.body), /missing<script>/);

  const badgePng = publicSyndicationMediaResource({
    db,
    slug: "media-agent",
    variant: "badge",
    format: "png",
  });
  assert.equal(badgePng.contentType, "image/png");
  assert.equal(badgePng.cacheControl, "public, max-age=30, stale-while-revalidate=300");
  assert.equal(Buffer.isBuffer(badgePng.body), true);
  assert.equal((badgePng.body as Buffer).subarray(1, 4).toString("ascii"), "PNG");
  assert.match(badgePng.etag ?? "", /^W\/".+-\d+"$/);

  const ogPng = publicSyndicationMediaResource({
    db,
    slug: "media-agent",
    variant: "og",
    format: "png",
  });
  assert.equal(ogPng.contentType, "image/png");
  assert.equal(ogPng.cacheControl, "public, max-age=120, stale-while-revalidate=600");
  assert.equal(Buffer.isBuffer(ogPng.body), true);
  assert.equal((ogPng.body as Buffer).subarray(1, 4).toString("ascii"), "PNG");
  assert.match(ogPng.etag ?? "", /^W\/".+-\d+"$/);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("  ok media variant, format, cache, ETag, and raster behavior stay together\n");
