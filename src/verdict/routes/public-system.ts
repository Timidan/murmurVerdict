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
  } | null;
  liveCanaries?: LiveCanaryProvider | null;
  now: () => Date;
  oracleProbe?: () => Promise<string | null>;
  publicOrigin: MurmurPublicOrigin;
  requireLiveCanaries?: boolean;
}

export function publicSystemRouter(deps: PublicSystemRouterDeps): Router {
  const router = Router();

  router.get("/v1/openapi.json", (req, res) => {
    const publicUrl = publicApiUrlForRequest(deps.publicOrigin, req);
    sendPublicSystemResource(req, res, publicOpenApiResource(publicUrl));
  });

  router.get("/v1/skill.md", (req, res) => {
    const apiBase = publicApiUrlForRequest(deps.publicOrigin, req);
    sendPublicSystemResource(req, res, publicSkillResource(apiBase));
  });

  router.get("/embed.js", (req, res) => {
    const publicUrl = publicApiUrlForRequest(deps.publicOrigin, req);
    sendPublicSystemResource(req, res, publicEmbedResource(publicUrl));
  });

  router.get("/v1/health", (_req, res) => {
    sendPublicSystemJsonResponse(res, publicHealthResponse({
      servedAt: deps.now(),
    }));
  });

  router.get("/v1/readyz", asyncHandler(async (_req, res) => {
    sendPublicSystemJsonResponse(res, await publicReadinessSurface({
      db: deps.db,
      now: deps.now,
      oracleProbe: deps.oracleProbe,
      liveCanaries: deps.liveCanaries,
      requireLiveCanaries: deps.requireLiveCanaries,
    }));
  }));

  router.get("/v1/meta", (_req, res) => {
    sendPublicSystemJsonResponse(res, publicMetaResponse({
      db: deps.db,
      servedAt: deps.now(),
      fhenixChain: deps.fhenixChain,
    }));
  });

  return router;
}
