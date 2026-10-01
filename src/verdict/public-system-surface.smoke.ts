import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveCanaryProvider, LiveCanarySnapshot } from "../integrations/live-canaries.js";

import { openDb } from "./db.js";
import {
  publicEmbedResource,
  publicHealthResponse,
  publicHealthSurface,
  publicMetaResponse,
  publicMetaSurface,
  publicOpenApiResource,
  publicReadinessSurface,
  sendPublicSystemJsonResponse,
  sendPublicSystemResource,
  publicSkillResource,
  type PublicSystemResourceResponse,
} from "./public-system-surface.js";
import { makeUsageEvent } from "./usage-event.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { usageRepo } from "./repos/usage-events-repo.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-public-system-surface-"));
const dbPath = join(tmp, "test.db");

class FakeResourceResponse implements PublicSystemResourceResponse {
  statusCode = 200;
  headers = new Map<string, string>();
  jsonBody: unknown = null;
  sentBody: unknown = null;
  ended = false;

  status(code: number): PublicSystemResourceResponse {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  json(body: unknown): void {
    this.jsonBody = body;
  }

  send(body: unknown): void {
    this.sentBody = body;
  }

  end(): void {
    this.ended = true;
  }
}

class FakeJsonResponse {
  statusCode: number | null = null;
  body: unknown = null;

  status(code: number): { json: (body: unknown) => void } {
    this.statusCode = code;
    return {
      json: (body: unknown) => {
        this.body = body;
      },
    };
  }
}

try {
  process.stdout.write("murmur public system surface smoke\n");
  const db = openDb({ path: dbPath });
  const now = () => new Date("2026-06-12T09:30:00Z");
  const servedAt = now();
  const agentId = randomUUID();
  const staleAgentId = randomUUID();
  const internalAgentId = randomUUID();

  const health = publicHealthSurface({ servedAt, revealWorkerConfigured: false, acceptsPlaintextSubmission: false });
  assert.equal(health.ok, true);
  assert.equal(health.schema_version, 1);
  assert.equal(health.scoring_version, 1);
  assert.equal(health.now, "2026-06-12T09:30:00Z");
  assert.equal(health.privacy.pending_verdicts_private, true);
  // Not publicly readable holds even with owned sealing; operator blindness is what changes.
  {
    const owned = publicHealthSurface({
      servedAt,
      revealWorkerConfigured: false,
      acceptsPlaintextSubmission: true,
    }).privacy;
    assert.equal(owned.pending_verdicts_private, true, "still not public");
    assert.equal(
      owned.operator_holds_plaintext,
      "on_owned_sealing_path",
      "owned sealing on: murmur must not claim operator blindness",
    );
  }
  assert.equal(health.privacy.operator_holds_plaintext, "never_on_sealed_fhenix");
  // The reveal guarantee tracks the worker; both directions pinned.
  assert.equal(
    health.privacy.public_reveal_after_horizon,
    false,
    "no worker declared: /v1/health must not claim a reveal guarantee",
  );
  assert.equal(
    publicHealthSurface({ servedAt, revealWorkerConfigured: true, acceptsPlaintextSubmission: false })
      .privacy.public_reveal_after_horizon,
    true,
    "worker running: the guarantee is real and is published",
  );
  assert.equal(
    publicHealthSurface({ servedAt, revealWorkerConfigured: false, acceptsPlaintextSubmission: false })
      .privacy.public_reveal_after_horizon,
    false,
  );
  const healthResponse = publicHealthResponse({ servedAt, revealWorkerConfigured: false, acceptsPlaintextSubmission: false });
  const healthRes = new FakeJsonResponse();
  sendPublicSystemJsonResponse(healthRes, healthResponse);
  assert.equal(healthRes.statusCode, 200);
  assert.equal((healthRes.body as typeof health).now, "2026-06-12T09:30:00Z");

  const openapi = publicOpenApiResource({
    publicUrl: "https://api.murmur.example",
    nanopayX402Mounted: true,
  });
  assert.equal(openapi.contentType, "application/json; charset=utf-8");
  assert.equal(openapi.cacheControl, "public, max-age=300, stale-while-revalidate=900");
  assert.equal(openapi.accessControlAllowOrigin, "*");
  assert.equal((openapi.body as { servers?: Array<{ url: string }> }).servers?.[0]?.url, "https://api.murmur.example");
  assert.equal(
    Boolean((openapi.body as { paths?: Record<string, unknown> }).paths?.["/v2/nanopay/infer/{pipelineId}"]),
    true,
  );
  const defaultOpenapi = publicOpenApiResource({
    publicUrl: "https://api.murmur.example",
  });
  assert.equal(
    Boolean((defaultOpenapi.body as { paths?: Record<string, unknown> }).paths?.["/v2/nanopay/infer/{pipelineId}"]),
    false,
  );
  const openapiRes = new FakeResourceResponse();
  assert.equal(
    sendPublicSystemResource({ header: () => undefined }, openapiRes, openapi),
    "sent",
  );
  assert.equal(openapiRes.statusCode, 200);
  assert.equal(openapiRes.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(openapiRes.headers.get("Cache-Control"), "public, max-age=300, stale-while-revalidate=900");
  assert.equal(openapiRes.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(openapiRes.jsonBody, openapi.body);
  assert.equal(openapiRes.sentBody, null);

  const skill = publicSkillResource("https://api.murmur.example");
  assert.equal(skill.contentType, "text/markdown; charset=utf-8");
  assert.equal(String(skill.body).includes("https://api.murmur.example"), true);
  const skillRes = new FakeResourceResponse();
  sendPublicSystemResource({ header: () => undefined }, skillRes, skill);
  assert.equal(skillRes.jsonBody, null);
  assert.equal(skillRes.sentBody, skill.body);

  const embed = publicEmbedResource("https://api.murmur.example");
  assert.equal(embed.contentType, "application/javascript; charset=utf-8");
  assert.equal(String(embed.body).includes("__PUBLIC_URL__"), false);
  assert.equal(String(embed.body).includes("https://api.murmur.example"), true);
  assert.equal(String(embed.body).includes("Date.now"), false);
  assert.equal(String(embed.body).includes("data-version"), true);

  const ready = await publicReadinessSurface({
    db,
    now,
    liveCanaries: canaries(true),
    requireLiveCanaries: true,
  });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ready, true);
  assert.equal(ready.body.db.ok, true);
  assert.equal(ready.body.db.latency_ms, 0);
  assert.equal(ready.body.canaries.required, true);
  assert.equal(ready.body.canaries.checks[0]?.name, "fhenix_rpc");
  assert.equal(
    db.prepare("SELECT value FROM schema_meta WHERE key = ?")
      .pluck()
      .get("readyz_probe"),
    "2026-06-12T09:30:00Z",
  );
  const readyRes = new FakeJsonResponse();
  sendPublicSystemJsonResponse(readyRes, ready);
  assert.equal(readyRes.statusCode, 200);
  assert.equal((readyRes.body as typeof ready.body).ready, true);

  // Readiness is DB writeability plus live canaries; the body names no oracle.
  assert.equal(Object.prototype.hasOwnProperty.call(ready.body, "oracle"), false);

  const canaryFailure = await publicReadinessSurface({
    db,
    now,
    liveCanaries: canaries(false),
    requireLiveCanaries: true,
  });
  assert.equal(canaryFailure.status, 503);
  assert.equal(canaryFailure.body.canaries.ok, false);
  assert.equal(canaryFailure.body.canaries.checks[0]?.error, "canary_probe_failed");
  assert.equal(
    JSON.stringify(canaryFailure.body).includes("SUPERSECRET"),
    false,
    "public readiness must not expose provider URLs or credentials from canary errors",
  );

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "public-meta-volume",
    kind: "agent",
    display_name: "Public Meta Volume",
    created_at: "2026-06-12T09:00:00Z",
  });
  agentsRepo.insert(db, {
    agent_id: staleAgentId,
    display_slug: "public-meta-stale",
    kind: "agent",
    display_name: "Public Meta Stale",
    created_at: "2026-06-10T09:00:00Z",
  });
  agentsRepo.insert(db, {
    agent_id: internalAgentId,
    display_slug: "public-meta-internal",
    kind: "internal_test",
    display_name: "Public Meta Internal",
    created_at: "2026-06-12T09:00:00Z",
  });
  usageRepo.emit(db, makeUsageEvent({
    agent_id: agentId,
    kind: "submission_accepted",
    occurredAt: new Date("2026-06-12T09:00:00Z"),
  }));
  usageRepo.emit(db, makeUsageEvent({
    agent_id: staleAgentId,
    kind: "submission_accepted",
    occurredAt: new Date("2026-06-10T09:00:00Z"),
  }));
  usageRepo.emit(db, makeUsageEvent({
    agent_id: internalAgentId,
    kind: "submission_accepted",
    occurredAt: new Date("2026-06-12T09:00:00Z"),
  }));

  const meta = publicMetaSurface({
    db,
    servedAt,
    revealWorkerConfigured: false,
    acceptsPlaintextSubmission: false,
    nanopayX402Mounted: true,
    fhenixChain: {
      chainId: 84532,
      sealedVerdictsAddress: `0x${"a".repeat(40)}`,
      relayerAddress: `0x${"b".repeat(40)}`,
    },
  });
  assert.equal(meta.schema_version, 1);
  assert.equal(meta.fhenix?.chain_id, "eip155:84532");
  assert.equal(meta.fhenix?.relayer_address, `0x${"b".repeat(40)}`);
  assert.equal(meta.paid_inference.current_venue, "polymarket-gamma");
  assert.equal(meta.paid_inference.nanopay?.protocol, "x402");
  assert.equal(meta.paid_inference.nanopay?.gateway, "circle");
  assert.equal(meta.paid_inference.nanopay?.endpoint, "/v2/nanopay/infer/{pipelineId}");
  assert.equal(meta.paid_inference.nanopay?.mounted, true);
  assert.deepEqual(meta.verdict_bounds, { binary_index: { min: 0, max: 1 }, confidence_bps: { min: 5100, max: 9500 } });
  assert.equal(meta.paid_inference.market_taxonomy.live_resolution_classes.includes("price_direction"), true);
  assert.deepEqual(meta.verified_volume_24h, {
    count: 1,
    since_iso: "2026-06-11T09:30:00Z",
  });
  assert.equal(meta.privacy.pending_verdicts_private, true);
  assert.equal(meta.privacy.plaintext_submission_path, false);
  {
    const plaintext = publicMetaSurface({
      db,
      servedAt,
      revealWorkerConfigured: false,
      acceptsPlaintextSubmission: true,
    }).privacy;
    assert.equal(plaintext.pending_verdicts_private, true, "still not public");
    assert.equal(plaintext.operator_holds_plaintext, "on_owned_sealing_path");
    assert.equal(
      plaintext.plaintext_submission_path,
      true,
      "owned sealing on: /v1/meta must say so, not repeat the manifest's false",
    );
  }
  // /v1/meta's reveal guarantee tracks the worker too; both directions pinned.
  assert.equal(
    meta.privacy.public_reveal_after_horizon,
    false,
    "no worker declared: /v1/meta must not advertise a reveal guarantee",
  );
  assert.equal(
    publicMetaSurface({ db, servedAt, revealWorkerConfigured: true, acceptsPlaintextSubmission: false })
      .privacy.public_reveal_after_horizon,
    true,
    "worker running: the guarantee is real and is advertised",
  );
  assert.equal(
    publicMetaSurface({ db, servedAt, revealWorkerConfigured: false, acceptsPlaintextSubmission: false })
      .privacy.public_reveal_after_horizon,
    false,
  );
  const metaResponse = publicMetaResponse({
    db,
    servedAt,
    revealWorkerConfigured: false,
    acceptsPlaintextSubmission: false,
    nanopayX402Mounted: true,
    fhenixChain: {
      chainId: 84532,
      sealedVerdictsAddress: `0x${"a".repeat(40)}`,
      relayerAddress: `0x${"b".repeat(40)}`,
    },
  });
  const metaRes = new FakeJsonResponse();
  sendPublicSystemJsonResponse(metaRes, metaResponse);
  assert.equal(metaRes.statusCode, 200);
  assert.equal((metaRes.body as typeof meta).fhenix?.chain_id, "eip155:84532");

  const defaultMeta = publicMetaSurface({
    db,
    servedAt,
    revealWorkerConfigured: false,
    acceptsPlaintextSubmission: false,
  });
  assert.equal(defaultMeta.paid_inference.nanopay, null);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("public system surface smoke ok\n");

function canaries(ok: boolean): LiveCanaryProvider {
  const snapshot: LiveCanarySnapshot = {
    schema_version: 1,
    served_at: "2026-06-12T09:29:00Z",
    ok,
    checks: [
      {
        name: "fhenix_rpc",
        status: ok ? "ok" : "fail",
        checked_at: "2026-06-12T09:29:00Z",
        latency_ms: ok ? 12 : null,
        details: {},
        error: ok ? null : "request failed: http://127.0.0.1:1/SUPERSECRET",
      },
    ],
  };
  return {
    snapshot: () => snapshot,
    runNow: async () => snapshot,
    hasEnabledChecks: () => true,
  };
}
