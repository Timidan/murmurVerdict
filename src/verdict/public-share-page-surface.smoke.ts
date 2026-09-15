import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  publicSharePageResponse,
  sendPublicSharePageResponse,
} from "./public-share-page-surface.js";
import { agentsRepo } from "./repos/agents-repo.js";

class FakePublicSharePageResponse {
  headers: Record<string, string> = {};
  statusCode: number | null = null;
  body: string | null = null;

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  status(code: number): { send: (body: string) => void } {
    this.statusCode = code;
    return {
      send: (body: string) => {
        this.body = body;
      },
    };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-public-share-page-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur public share page surface smoke\n");
  const db = openDb({ path: dbPath });

  agentsRepo.insert(db, {
    agent_id: randomUUID(),
    display_slug: "share-smoke",
    kind: "agent",
    display_name: `Alpha <Trader> & "Co"`,
    bio: "Share page smoke fixture",
    created_at: "2026-05-27T10:00:00Z",
  });

  const known = publicSharePageResponse({
    db,
    slug: "share-smoke",
    ref: " ally! ",
    publicOrigin: {
      publicApiUrl: "https://api.murmur.example",
      dashboardUrl: "https://dashboard.murmur.example/app",
    },
    apiOrigin: "https://api.murmur.example/",
  });
  assert.equal(known.status, 200);
  assert.equal(known.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(
    known.headers["Cache-Control"],
    "public, max-age=60, stale-while-revalidate=300",
  );
  assert.match(
    known.body,
    /<title>Alpha &lt;Trader&gt; &amp; &quot;Co&quot; - Murmur Verdict<\/title>/,
  );
  assert.doesNotMatch(known.body, /Alpha <Trader>/);
  assert.match(
    known.body,
    /<meta property="og:image" content="https:\/\/api\.murmur\.example\/v1\/og\/share-smoke\.png" \/>/,
  );
  assert.match(
    known.body,
    /https:\/\/dashboard\.murmur\.example\/#\/share\/share-smoke\?ref=ally/,
  );
  assert.match(known.body, /murmur\.verdict &middot; agent/);
  const knownRes = new FakePublicSharePageResponse();
  sendPublicSharePageResponse(knownRes, known);
  assert.equal(knownRes.statusCode, 200);
  assert.equal(knownRes.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(
    knownRes.headers["Cache-Control"],
    "public, max-age=60, stale-while-revalidate=300",
  );
  assert.match(knownRes.body ?? "", /murmur\.verdict &middot; agent/);

  const missing = publicSharePageResponse({
    db,
    slug: "missing<script>",
    ref: "!!!",
    publicOrigin: {
      publicApiUrl: null,
      dashboardUrl: null,
    },
    apiOrigin: "https://request.example/",
  });
  assert.match(
    missing.body,
    /<title>missing&lt;script&gt; - Murmur Verdict<\/title>/,
  );
  assert.doesNotMatch(missing.body, /missing<script>/);
  assert.match(
    missing.body,
    /<meta property="og:image" content="https:\/\/request\.example\/v1\/og\/missing%3Cscript%3E\.png" \/>/,
  );
  assert.doesNotMatch(missing.body, /property="og:url"/);
  assert.doesNotMatch(missing.body, /http-equiv="refresh"/);
  // A visitor never sees operator configuration advice.
  assert.doesNotMatch(missing.body, /MURMUR_PUBLIC_URL/);
  assert.match(missing.body, /murmur\.verdict &middot; share/);
  const missingRes = new FakePublicSharePageResponse();
  sendPublicSharePageResponse(missingRes, missing);
  assert.equal(missingRes.statusCode, 200);
  assert.equal(missingRes.headers["Content-Type"], "text/html; charset=utf-8");
  assert.match(missingRes.body ?? "", /murmur\.verdict &middot; share/);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("  ok share page links, escaping, ref policy, and fallback copy stay together\n");
