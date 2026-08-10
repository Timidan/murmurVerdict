import type Database from "better-sqlite3";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";

import { get24hVerifiedVolume } from "./leaderboard.js";
import { marketTaxonomyResponse } from "./market-taxonomy.js";
import { buildOpenApiSpec } from "./openapi.js";
import {
  sendCacheablePublicResource,
  type CacheablePublicResource,
  type CacheablePublicResourceRequest,
  type CacheablePublicResourceResponse,
  type CacheablePublicResourceResult,
} from "./public-cache-response.js";
import { publicEmbedScript } from "./public-embed.js";
import { buildAgentOperatePrompt, buildSkillMarkdown } from "./public-rendering.js";
import {
  COMMERCIAL_TEMPLATES,
  EDGE_CLASSES,
  FEED_PACKET_KINDS,
  REGISTERED_STRATEGY_TAGS,
  RESOLUTION_CLASSES,
  SCHEMA_VERSION,
  SCORING_VERSION,
} from "./schema.js";
import { nowIso } from "./time.js";

export interface PublicSystemClock {
  now: () => Date;
}

export interface PublicSystemReadInstant {
  servedAt: Date;
}

export interface PublicSystemFhenixChain {
  chainId: number;
  sealedVerdictsAddress: string | null;
}

export type PublicSystemResource = CacheablePublicResource;
export type PublicSystemResourceRequest = CacheablePublicResourceRequest;
export type PublicSystemResourceResponse = CacheablePublicResourceResponse;

export interface PublicSystemJsonResponse<TBody = unknown> {
  status: 200 | 503;
  body: TBody;
}

export interface PublicSystemJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export interface PublicReadinessDeps extends PublicSystemClock {
  db: Database.Database;
  liveCanaries?: LiveCanaryProvider | null;
  requireLiveCanaries?: boolean;
}

export interface PublicMetaDeps extends PublicSystemReadInstant {
  db: Database.Database;
  nanopayX402Mounted?: boolean;
  fhenixChain?: PublicSystemFhenixChain | null;
}

export interface PublicReadinessResponse {
  status: 200 | 503;
  body: {
    ready: boolean;
    now: string;
    db: { ok: boolean; latency_ms: number; error: string | null };
    canaries: {
      required: boolean;
      ok: boolean;
      served_at: string | null;
      checks: Array<{
        name: string;
        status: string;
        checked_at: string;
        latency_ms: number | null;
        error: string | null;
      }>;
    };
    privacy: {
      mode: "sealed_fhenix";
      threshold_network: "fhenix";
      submit_contract: "external";
      reveal_ingest: "/v1/admin/fhenix/reveals";
    };
  };
}

export function sendPublicSystemJsonResponse(
  res: PublicSystemJsonResponseTarget,
  result: PublicSystemJsonResponse,
): void {
  res.status(result.status).json(result.body);
}

export function publicOpenApiResource(input: {
  publicUrl: string;
  nanopayX402Mounted?: boolean;
}): PublicSystemResource {
  return publicSystemResource(
    "application/json; charset=utf-8",
    buildOpenApiSpec({
      publicUrl: input.publicUrl,
      nanopayX402Mounted: input.nanopayX402Mounted,
    }),
  );
}

export function publicSkillResource(
  apiBase: string,
  /** This deployment's verified PoP audience — see buildSkillMarkdown. */
  popAudience?: string,
): PublicSystemResource {
  return publicSystemResource(
    "text/markdown; charset=utf-8",
    buildSkillMarkdown(apiBase, popAudience),
  );
}

export function publicAgentSkillResource(
  apiBase: string,
  slug: string,
): PublicSystemResource {
  return publicSystemResource(
    "text/markdown; charset=utf-8",
    buildAgentOperatePrompt(apiBase, slug),
  );
}

export function publicEmbedResource(publicUrl: string): PublicSystemResource {
  return publicSystemResource(
    "application/javascript; charset=utf-8",
    publicEmbedScript({ publicUrl }),
  );
}

export function sendPublicSystemResource(
  req: PublicSystemResourceRequest,
  res: PublicSystemResourceResponse,
  resource: PublicSystemResource,
): CacheablePublicResourceResult {
  return sendCacheablePublicResource(req, res, resource);
}

export function publicHealthResponse(
  input: PublicSystemReadInstant,
): PublicSystemJsonResponse<ReturnType<typeof publicHealthSurface>> {
  return {
    status: 200,
    body: publicHealthSurface(input),
  };
}

export function publicHealthSurface(input: PublicSystemReadInstant) {
  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    scoring_version: SCORING_VERSION,
    now: nowIso(input.servedAt),
    privacy: {
      mode: "sealed_fhenix",
      pending_verdicts_private: true,
      public_reveal_after_horizon: true,
    },
  };
}

export async function publicReadinessSurface(
  deps: PublicReadinessDeps,
): Promise<PublicReadinessResponse> {
  const dbProbe = probeDatabase(deps.db, deps.now);
  const canariesRequired = deps.requireLiveCanaries ?? false;
  const canarySnapshot = deps.liveCanaries?.snapshot() ?? null;
  const canariesOk = !canariesRequired || Boolean(canarySnapshot?.ok);
  // Readiness is DB writeability + the live canaries. There is no price-oracle
  // leg any more: Murmur never reads a price, so a probe of one could only ever
  // fail readiness for a dependency no code path uses.
  const ready = dbProbe.ok && canariesOk;

  return {
    status: ready ? 200 : 503,
    body: {
      ready,
      now: nowIso(deps.now()),
      db: dbProbe,
      canaries: canarySnapshot
        ? {
            required: canariesRequired,
            ok: canarySnapshot.ok,
            served_at: canarySnapshot.served_at,
            checks: canarySnapshot.checks.map((check) => ({
              name: check.name,
              status: check.status,
              checked_at: check.checked_at,
              latency_ms: check.latency_ms,
              // The admin canary surface retains the raw diagnostic. This
              // unauthenticated endpoint emits only stable codes because
              // provider errors commonly embed credential-bearing URLs.
              error: check.error === null
                ? null
                : check.status === "disabled"
                  ? "canary_disabled"
                  : "canary_probe_failed",
            })),
          }
        : {
            required: canariesRequired,
            ok: !canariesRequired,
            served_at: null,
            checks: [],
          },
      privacy: publicReadinessPrivacy(),
    },
  };
}

export function publicMetaResponse(
  deps: PublicMetaDeps,
): PublicSystemJsonResponse<ReturnType<typeof publicMetaSurface>> {
  return {
    status: 200,
    body: publicMetaSurface(deps),
  };
}

export function publicMetaSurface(deps: PublicMetaDeps) {
  const fhenixChain = deps.fhenixChain
    ? {
        chain_id: `eip155:${deps.fhenixChain.chainId}`,
        chain_id_numeric: deps.fhenixChain.chainId,
        contract_address: deps.fhenixChain.sealedVerdictsAddress,
      }
    : null;
  return {
    schema_version: SCHEMA_VERSION,
    scoring_version: SCORING_VERSION,
    strategy_tags: REGISTERED_STRATEGY_TAGS,
    // Murmur referees EXTERNAL markets; it lists no assets of its own. The
    // field stays for wire compatibility and now names the venues whose
    // markets the daemon can seal calls against.
    assets: [],
    venues: ["polymarket-gamma"],
    verified_volume_24h: get24hVerifiedVolume(deps.db, deps.servedAt),
    paid_inference: {
      current_venue: "polymarket-gamma",
      nanopay: deps.nanopayX402Mounted === true
        ? {
            protocol: "x402",
            gateway: "circle",
            endpoint: "/v2/nanopay/infer/{pipelineId}",
            mounted: true,
          }
        : null,
      market_taxonomy: marketTaxonomyResponse(),
      resolution_classes: RESOLUTION_CLASSES,
      edge_classes: EDGE_CLASSES,
      commercial_templates: COMMERCIAL_TEMPLATES,
      feed_packet_kinds: FEED_PACKET_KINDS,
    },
    privacy: {
      mode: "sealed_fhenix",
      threshold_network: "fhenix",
      pending_verdicts_private: true,
      public_reveal_after_horizon: true,
    },
    ...(fhenixChain ? { fhenix: fhenixChain } : {}),
  };
}

function probeDatabase(
  db: Database.Database,
  now: () => Date,
): PublicReadinessResponse["body"]["db"] {
  const startedAt = now().getTime();
  let ok = false;
  let error: string | null = null;
  try {
    db.prepare(
      `INSERT INTO schema_meta(key, value) VALUES('readyz_probe', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(nowIso(now()));
    ok = true;
  } catch (err) {
    void err;
    error = "database_probe_failed";
  }
  return { ok, latency_ms: Math.max(0, now().getTime() - startedAt), error };
}

function publicReadinessPrivacy(): PublicReadinessResponse["body"]["privacy"] {
  return {
    mode: "sealed_fhenix",
    threshold_network: "fhenix",
    submit_contract: "external",
    reveal_ingest: "/v1/admin/fhenix/reveals",
  };
}

function publicSystemResource(
  contentType: string,
  body: unknown,
): PublicSystemResource {
  return {
    contentType,
    cacheControl: "public, max-age=300, stale-while-revalidate=900",
    accessControlAllowOrigin: "*",
    bodyMode: contentType.startsWith("application/json") ? "json" : "raw",
    body,
  };
}
