import { Router } from "express";
import type Database from "better-sqlite3";
import type { LiveCanaryProvider } from "../../integrations/live-canaries.js";
import {
  publicApiUrlForRequest,
  type MurmurPublicOrigin,
} from "../public-origin.js";
import {
  publicEmbedResource,
  publicHealthResponse,
  publicMetaResponse,
  publicOpenApiResource,
  publicReadinessSurface,
  sendPublicSystemJsonResponse,
  sendPublicSystemResource,
  publicSkillResource,
} from "../public-system-surface.js";
import { asyncHandler } from "./async-handler.js";

export interface PublicSystemRouterDeps {
  db: Database.Database;
  fhenixChain?: {
    chainId: number;
    sealedVerdictsAddress: string | null;
    relayerAddress: string | null;
  } | null;
  liveCanaries?: LiveCanaryProvider | null;
  nanopayX402Mounted?: boolean;
  now: () => Date;
  publicOrigin: MurmurPublicOrigin;
  /** This deployment's PoP audience, published in the skill's signing example; must match the verifier. */
  popAudience?: string;
  requireLiveCanaries?: boolean;
  /** Reveal worker configured, not proven live. Required so it cannot silently default. */
  revealWorkerConfigured: boolean;
  /** Gateway accepts plaintext (owned sealing). Required, same reason. */
  acceptsPlaintextSubmission: boolean;
}

export function publicSystemRouter(deps: PublicSystemRouterDeps): Router {
  const router = Router();

  router.get("/v1/openapi.json", (req, res) => {
    const publicUrl = publicApiUrlForRequest(deps.publicOrigin, req);
    sendPublicSystemResource(req, res, publicOpenApiResource({
      publicUrl,
      nanopayX402Mounted: deps.nanopayX402Mounted,
    }));
  });

  router.get("/v1/skill.md", (req, res) => {
    const apiBase = publicApiUrlForRequest(deps.publicOrigin, req);
    sendPublicSystemResource(req, res, publicSkillResource(apiBase, deps.popAudience));
  });

  router.get("/embed.js", (req, res) => {
    const publicUrl = publicApiUrlForRequest(deps.publicOrigin, req);
    sendPublicSystemResource(req, res, publicEmbedResource(publicUrl));
  });

  router.get("/v1/health", (_req, res) => {
    sendPublicSystemJsonResponse(res, publicHealthResponse({
      servedAt: deps.now(),
      revealWorkerConfigured: deps.revealWorkerConfigured,
      acceptsPlaintextSubmission: deps.acceptsPlaintextSubmission,
    }));
  });

  router.get("/v1/readyz", asyncHandler(async (_req, res) => {
    sendPublicSystemJsonResponse(res, await publicReadinessSurface({
      db: deps.db,
      now: deps.now,
      liveCanaries: deps.liveCanaries,
      requireLiveCanaries: deps.requireLiveCanaries,
    }));
  }));

  router.get("/v1/meta", (_req, res) => {
    sendPublicSystemJsonResponse(res, publicMetaResponse({
      db: deps.db,
      servedAt: deps.now(),
      fhenixChain: deps.fhenixChain,
      nanopayX402Mounted: deps.nanopayX402Mounted,
      revealWorkerConfigured: deps.revealWorkerConfigured,
      acceptsPlaintextSubmission: deps.acceptsPlaintextSubmission,
    }));
  });

  return router;
}
