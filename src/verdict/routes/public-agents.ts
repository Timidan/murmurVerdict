import { Router } from "express";
import type Database from "better-sqlite3";
import {
  listPublicAgentsResponse,
  publicAgentCallsResponse,
  publicAgentCardResponse,
  publicAgentProfileResponse,
  sendPublicAgentJsonResponse,
} from "../public-agent-surface.js";
import {
  publicAgentCallsQuery,
  publicAgentListQuery,
} from "../public-agent-query.js";
import {
  publicApiUrlForRequest,
  type MurmurPublicOrigin,
} from "../public-origin.js";
import {
  publicAgentSkillResource,
  sendPublicSystemResource,
} from "../public-system-surface.js";
import { agentsRepo } from "../repos/agents-repo.js";

export interface PublicAgentRouterDeps {
  db: Database.Database;
  nanopayX402Mounted?: boolean;
  now: () => Date;
  publicOrigin: MurmurPublicOrigin;
  popAudience?: string;
  acceptsPlaintextSubmission: boolean;
}

export function publicAgentRouter(deps: PublicAgentRouterDeps): Router {
  const router = Router();

  router.get("/v1/agents", (req, res) => {
    sendPublicAgentJsonResponse(res, listPublicAgentsResponse({
      db: deps.db,
      servedAt: deps.now(),
      query: publicAgentListQuery(req.query),
    }));
  });

  router.get("/v1/agents/:slug", (req, res) => {
    sendPublicAgentJsonResponse(res, publicAgentProfileResponse({
      db: deps.db,
      slug: String(req.params.slug ?? ""),
    }));
  });

  router.get("/v1/agents/:slug/agent-card", (req, res) => {
    sendPublicAgentJsonResponse(res, publicAgentCardResponse({
      db: deps.db,
      slug: String(req.params.slug ?? ""),
      apiBase: publicApiUrlForRequest(deps.publicOrigin),
      nanopayX402Mounted: deps.nanopayX402Mounted,
      servedAt: deps.now(),
    }));
  });

  router.get("/v1/agents/:slug/calls", (req, res) => {
    sendPublicAgentJsonResponse(res, publicAgentCallsResponse({
      db: deps.db,
      slug: String(req.params.slug ?? ""),
      query: publicAgentCallsQuery(req.query),
    }));
  });

  router.get("/v1/agents/:slug/skill.md", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const agent = agentsRepo.bySlug(deps.db, slug);
    if (!agent) {
      res.status(404).json({ error: "agent_not_found", slug });
      return;
    }
    const apiBase = publicApiUrlForRequest(deps.publicOrigin);
    sendPublicSystemResource(
      req,
      res,
      publicAgentSkillResource(
        apiBase,
        agent.display_slug,
        deps.popAudience,
        deps.acceptsPlaintextSubmission,
      ),
    );
  });

  return router;
}
