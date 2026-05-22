import { Router, type Request, type Response, type NextFunction } from "express";
import express from "express";
import type Database from "better-sqlite3";
import {
  agentSecurityEventsRepo,
  agentsRepo,
  feedContractsRepo,
  feedPacketsRepo,
  feedSlaIncidentsRepo,
  fhenixSealedCallsRepo,
  isUniqueViolation,
  marketsRepo,
  refsRepo,
  resolutionsRepo,
  webhooksRepo,
  type FeedContractRow,
  type FeedPacketRow,
  type FeedSlaIncidentRow,
  type FhenixGatewayTxStatus,
  type FhenixRevealStatus,
  type RegistryStatus,
} from "./db.js";
import {
  adapterIdentityForMarket,
} from "./markets.js";
import {
  marketTaxonomyForMarket,
  marketTaxonomyResponse,
} from "./market-taxonomy.js";
import { projectCallRow } from "./projections.js";
import {
  createHmac,
  randomUUID,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  getLeaderboard,
  get24hVerifiedVolume,
  getLeaderboardForMarket,
  getLeaderboardForFamily,
  getCrossFamilyLeaderboard,
  getAgentMarketGrid,
} from "./leaderboard.js";
import type { VerdictEventBus } from "./events.js";
import {
  ERROR_CODES,
  CommercialTemplateSchema,
  COMMERCIAL_TEMPLATES,
  EDGE_CLASSES,
  EdgeClassSchema,
  FEED_PACKET_KINDS,
  FEED_STATUSES,
  FeedPacketKindSchema,
  FeedStatusSchema,
  MarketIdSchema,
  REGISTERED_STRATEGY_TAGS,
  RESOLUTION_CLASSES,
  ResolutionClassSchema,
  SCHEMA_VERSION,
  SCORING_VERSION,
  VerdictError,
} from "./schema.js";
import { getTodayFeed } from "./feed.js";
import {
  classifyFeedPacketSla,
  buildFeedAvailabilityProof,
  feedAvailabilitySummary,
  feedReliabilityEnvelope,
  inferFeedDeliveryDeadline,
  validateFeedCoveredMarkets,
  validateFeedPacketMarket,
} from "./feed-availability.js";
import { runFeedSlaTick } from "./feed-sla.js";
import {
  operatorAlertsSnapshot,
  operatorAlertSinkFromEnv,
  runOperatorAlertTick,
  type OperatorAlertSinkConfig,
} from "./operator-alerts.js";
import { renderBadgeSvg, renderOgSvg, rasterize } from "./badge.js";
import { buildOpenApiSpec } from "./openapi.js";
import { dispatchAuth, type AuthIdentity as DispatchedAuthIdentity } from "./auth/dispatcher.js";
import {
  createFhenixEventVerifierFromEnv,
  type FhenixEventVerifier,
} from "../integrations/fhenix-events.js";
import type { FhenixGatewayBroadcaster } from "../integrations/fhenix-gateway.js";
import { resolveFhenixContractAddress } from "../integrations/deployments.js";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import { z } from "zod";
import {
  FhenixInvalidRevealBodySchema,
  FhenixRevealBodySchema,
  Hex20Schema,
  Hex32Schema,
} from "./fhenix-common.js";
import { acceptSealedCallMetadata } from "./sealed-call-intake.js";
import {
  FhenixRevealStatusSchema,
  GatewayAttemptStatusSchema,
  controllerIdentitySnapshot,
  fhenixLifecycleSnapshot,
  unconfiguredGatewaySnapshot,
} from "./operator-control-plane.js";
import {
  attachInvalidFhenixReveal,
  attachValidFhenixReveal,
} from "./fhenix-reveal-ingestion.js";
import { isoFromMs, nowIso, parseIsoMs } from "./time.js";

const OperatorAlertStatusSchema = z.enum(["open", "resolved"]);
const OperatorAlertDeliveryStatusSchema = z.enum(["pending", "delivered", "failed"]);
const OperatorAlertTickBodySchema = z.object({
  gateway_stuck_after_sec: z.number().int().min(60).max(24 * 60 * 60).optional(),
  fhenix_reveal_grace_sec: z.number().int().min(0).max(7 * 24 * 60 * 60).optional(),
  identity_due_soon_hours: z.number().int().min(1).max(30 * 24).optional(),
}).strict();

// ─── API surface ─────────────────────────────────────────────────────────────
//
// Public routes (no auth):
//   GET  /v1/health
//   GET  /v1/meta
//   GET  /v1/leaderboard?tier=&limit=
//   GET  /v1/agents/:slug
//   GET  /v1/agents/:slug/calls?limit=
//   GET  /v1/calls/:call_id
//
// Authed routes:
//   POST /v2/gateway/calls
//   POST /v2/gateway/feeds/:feed_id/packets
//   POST /v1/admin/fhenix/backfill/calls
//   POST /v1/admin/fhenix/reveals
//   POST /v1/admin/fhenix/invalid-reveals

export interface ApiDeps {
  db: Database.Database;
  /**
   * Probe used by /v1/readyz. Should attempt a real oracle read and return
   * `null` on success or a string describing the failure. When unset, /readyz
   * still checks DB writeability but reports oracle as `disabled`.
   */
  oracleProbe?: () => Promise<string | null>;
  /**
   * Admin bearer token gating administrative routes.
   */
  adminToken?: string;
  /**
   * Optional event bus for live-streaming. When set, exposes `/v1/stream` (SSE).
   * When undefined, that route 404s.
   */
  events?: VerdictEventBus;
  /**
   * Verifies that submitted Fhenix metadata corresponds to real contract
   * events. Tests inject this; production uses FHENIX_RPC_URL when unset.
   */
  fhenixVerifier?: FhenixEventVerifier | null;
  /**
   * Gateway broadcaster for Runtime-Key-authenticated relayed Fhenix submits.
   * When unset, `/v2/gateway/calls` fails closed with 503.
   */
  fhenixGateway?: FhenixGatewayBroadcaster | null;
  /**
   * Optional live operator canaries for external dependencies that are not
   * safe to assume from local process health: Fhenix RPC/contract reachability
   * and Polymarket Gamma live market fetches.
   */
  liveCanaries?: LiveCanaryProvider | null;
  /**
   * When true, /readyz fails unless the latest live-canary snapshot is OK.
   * Defaults false so local/dev environments do not become dependent on
   * external RPC/API availability.
   */
  requireLiveCanaries?: boolean;
  /**
   * Optional admin/operator alert sink. Alerts are always persisted in the
   * local DB; when this sink is configured, `/v1/admin/alerts/tick` and the
   * daemon tick can also POST them to the operator's incident channel.
   */
  operatorAlertSink?: OperatorAlertSinkConfig | null;
  now?: () => Date;
}

export function createVerdictRouter(deps: ApiDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const adminToken = deps.adminToken ?? process.env.VERDICT_ADMIN_TOKEN ?? "";
  const fhenixVerifier = deps.fhenixVerifier ?? createFhenixEventVerifierFromEnv();
  const operatorAlertSink = deps.operatorAlertSink ?? operatorAlertSinkFromEnv();
  const json = express.json({ limit: "32kb" });
  const requireAgentAuth = async (req: Request): Promise<DispatchedAuthIdentity & { agent_id: string }> => {
    const authResult = await dispatchAuth(req, {
      db: deps.db,
      now,
    });
    if (!authResult) {
      throw new VerdictError(
        "auth required: provide Authorization: Bearer <privy> or X-Murmur-Api-Key",
        ERROR_CODES.agent_not_authorized,
        401,
      );
    }
    if (!authResult.agent_id) {
      throw new VerdictError(
        "X-Murmur-Agent-Slug header required: account owns no default agent",
        ERROR_CODES.agent_slug_required,
        400,
      );
    }
    return authResult as DispatchedAuthIdentity & { agent_id: string };
  };
  const requireFhenixVerifier = (): FhenixEventVerifier => {
    if (!fhenixVerifier) {
      throw new VerdictError(
        "Fhenix chain verifier is not configured; set FHENIX_RPC_URL before accepting sealed calls",
        ERROR_CODES.oracle_unavailable,
        503,
      );
    }
    return fhenixVerifier;
  };
  const requireAdmin = (req: Request, res: Response): boolean => {
    if (!adminToken) {
      res.status(503).json({
        code: "admin_disabled",
        message: "VERDICT_ADMIN_TOKEN not set",
      });
      return false;
    }
    const headerToken = req.header("X-Admin-Token");
    const bearer = bearerToken(req);
    if (!safeStrEq(headerToken, adminToken) && !safeStrEq(bearer, adminToken)) {
      res.status(403).json({
        code: "forbidden",
        message: "admin token required",
      });
      return false;
    }
    return true;
  };

  router.post(
    "/v1/calls",
    asyncHandler(async (_req, res) => {
      res.status(410).json({
        code: "endpoint_removed",
        message:
          "/v1/calls is retired. Submit via /v2/gateway/calls with a Runtime Key and already-created CoFHE encrypted inputs.",
        replacement: "/v2/gateway/calls",
      });
    }),
  );

  // Canonical Gateway paths. The daemon never receives verdict/feed plaintext
  // while pending; it accepts CoFHE encrypted inputs, enforces Gateway policy,
  // and relays the Fhenix submit tx itself.
  router.post(
    "/v2/gateway/calls",
    json,
    asyncHandler(async (req, res) => {
      if (!deps.fhenixGateway) {
        throw new VerdictError(
          "Fhenix Gateway broadcaster is not configured; set FHENIX_GATEWAY_ENABLED=true with relayer credentials",
          ERROR_CODES.oracle_unavailable,
          503,
        );
      }
      const authResult = await dispatchAuth(req, {
        db: deps.db,
        allowRuntimeKey: true,
        now,
      });
      if (!authResult) {
        throw new VerdictError(
          "gateway auth required: provide X-Murmur-Runtime-Key",
          ERROR_CODES.agent_not_authorized,
          401,
        );
      }
      const result = await deps.fhenixGateway.submitSealedCall({
        authResult,
        bodyJson: req.body ?? {},
      });
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    "/v2/gateway/feeds/:feed_id/packets",
    json,
    asyncHandler(async (req, res) => {
      if (!deps.fhenixGateway) {
        throw new VerdictError(
          "Fhenix Gateway broadcaster is not configured; set FHENIX_GATEWAY_ENABLED=true with relayer credentials",
          ERROR_CODES.oracle_unavailable,
          503,
        );
      }
      const authResult = await dispatchAuth(req, {
        db: deps.db,
        allowRuntimeKey: true,
        now,
      });
      if (!authResult) {
        throw new VerdictError(
          "gateway auth required: provide X-Murmur-Runtime-Key",
          ERROR_CODES.agent_not_authorized,
          401,
        );
      }
      const result = await deps.fhenixGateway.submitFeedPacket({
        authResult,
        feedId: String(req.params.feed_id ?? ""),
        bodyJson: req.body ?? {},
      });
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    "/v2/calls",
    asyncHandler(async (_req, res) => {
      res.status(410).json({
        code: "endpoint_removed",
        message:
          "/v2/calls is retired as an agent submission path. Submit via /v2/gateway/calls with a Runtime Key.",
        replacement: "/v2/gateway/calls",
      });
    }),
  );

  router.post(
    "/v1/admin/fhenix/backfill/calls",
    express.text({ type: "application/json", limit: "32kb" }),
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const rawBody = typeof req.body === "string" ? req.body : "";
      const slug = req.header("X-Murmur-Agent-Slug");
      if (!slug) {
        throw new VerdictError(
          "X-Murmur-Agent-Slug header required for admin Fhenix backfill",
          ERROR_CODES.agent_slug_required,
          400,
        );
      }
      const agent = agentsRepo.bySlug(deps.db, slug);
      if (!agent) {
        throw new VerdictError("unknown agent slug", ERROR_CODES.unknown_agent, 404);
      }

      let bodyJson: unknown;
      try {
        bodyJson = JSON.parse(rawBody || "{}");
      } catch {
        throw new VerdictError(
          "request body is not valid JSON",
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      const result = await acceptSealedCallMetadata({
        db: deps.db,
        authResult: {
          tier: "casual",
          agent_id: agent.agent_id,
          agent_kind: agent.kind,
        },
        bodyJson,
        fhenixVerifier,
        now,
      });
      if (result.event) deps.events?.emit(result.event);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    "/v1/admin/fhenix/reveals",
    json,
    asyncHandler(async (req, res) => {
      const provided = bearerToken(req);
      if (!adminToken || !safeStrEq(provided, adminToken)) {
        res.status(403).json({
          code: "forbidden",
          message: "valid admin bearer token required",
        });
        return;
      }

      const parsed = FhenixRevealBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new VerdictError(
          "fhenix reveal failed schema validation",
          ERROR_CODES.schema_invalid,
          400,
          { issues: parsed.error.format() },
        );
      }
      const body = parsed.data;

      const result = await attachValidFhenixReveal({
        db: deps.db,
        verifier: requireFhenixVerifier(),
        now,
      }, body);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    "/v1/admin/fhenix/invalid-reveals",
    json,
    asyncHandler(async (req, res) => {
      const provided = bearerToken(req);
      if (!adminToken || !safeStrEq(provided, adminToken)) {
        res.status(403).json({
          code: "forbidden",
          message: "valid admin bearer token required",
        });
        return;
      }

      const parsed = FhenixInvalidRevealBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new VerdictError(
          "fhenix invalid reveal failed schema validation",
          ERROR_CODES.schema_invalid,
          400,
          { issues: parsed.error.format() },
        );
      }
      const body = parsed.data;

      const result = await attachInvalidFhenixReveal({
        db: deps.db,
        verifier: requireFhenixVerifier(),
        now,
      }, body);
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    "/v1/admin/fhenix/lifecycle",
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      res.json({
        schema_version: SCHEMA_VERSION,
        ...fhenixLifecycleSnapshot(deps.db, {
          ...parseFhenixLifecycleQuery(req),
          now,
          verifier_configured: Boolean(fhenixVerifier),
        }),
      });
    }),
  );

  router.get(
    "/v1/admin/fhenix/gateway",
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const query = parseGatewayOperatorQuery(req);
      const snapshot = deps.fhenixGateway
        ? deps.fhenixGateway.operatorSnapshot(query)
        : unconfiguredGatewaySnapshot(deps.db, {
          now,
          status: query.status,
          limit: query.limit,
          stuckAfterMs: query.stuckAfterMs,
        });
      res.json({
        schema_version: SCHEMA_VERSION,
        ...snapshot,
      });
    }),
  );

  router.post(
    "/v1/admin/fhenix/gateway/tick",
    json,
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      if (!deps.fhenixGateway) {
        res.status(503).json({
          code: "gateway_disabled",
          message: "Fhenix Gateway broadcaster is not configured",
        });
        return;
      }
      const result = await deps.fhenixGateway.tick();
      res.json({
        schema_version: SCHEMA_VERSION,
        served_at: nowIso(now()),
        result,
        gateway: {
          schema_version: SCHEMA_VERSION,
          ...deps.fhenixGateway.operatorSnapshot(parseGatewayOperatorQuery(req)),
        },
      });
    }),
  );

  router.post(
    "/v1/admin/fhenix/gateway/attempts/:attempt_id/retry",
    json,
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      if (!deps.fhenixGateway) {
        res.status(503).json({
          code: "gateway_disabled",
          message: "Fhenix Gateway broadcaster is not configured",
        });
        return;
      }
      const attemptId = String(req.params.attempt_id ?? "");
      const result = await deps.fhenixGateway.retryAttemptNow(attemptId);
      res.status(result.status).json({
        schema_version: SCHEMA_VERSION,
        served_at: nowIso(now()),
        ...result.body,
      });
    }),
  );

  router.get(
    "/v1/admin/canaries",
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      if (!deps.liveCanaries) {
        res.status(503).json({
          code: "canaries_disabled",
          message: "Live canary runner is not configured",
        });
        return;
      }
      res.json(deps.liveCanaries.snapshot());
    }),
  );

  router.post(
    "/v1/admin/canaries/tick",
    json,
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      if (!deps.liveCanaries) {
        res.status(503).json({
          code: "canaries_disabled",
          message: "Live canary runner is not configured",
        });
        return;
      }
      res.json(await deps.liveCanaries.runNow());
    }),
  );

  router.get(
    "/v1/admin/identity/controllers",
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      res.json({
        schema_version: SCHEMA_VERSION,
        ...controllerIdentitySnapshot(deps.db, {
          ...parseControllerIdentityQuery(req),
          now,
        }),
      });
    }),
  );

  router.get(
    "/v1/admin/alerts",
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const query = parseOperatorAlertQuery(req);
      res.json({
        schema_version: SCHEMA_VERSION,
        ...operatorAlertsSnapshot(deps.db, {
          ...query,
          sink: operatorAlertSink,
          now,
        }),
      });
    }),
  );

  router.post(
    "/v1/admin/alerts/tick",
    json,
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const parsed = OperatorAlertTickBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new VerdictError(
          "operator alert tick failed schema validation",
          ERROR_CODES.schema_invalid,
          400,
          { issues: parsed.error.format() },
        );
      }
      const result = await runOperatorAlertTick({
        db: deps.db,
        now,
        liveCanaries: deps.liveCanaries,
        gatewayStuckAfterMs: parsed.data.gateway_stuck_after_sec
          ? parsed.data.gateway_stuck_after_sec * 1_000
          : undefined,
        fhenixRevealGraceSec: parsed.data.fhenix_reveal_grace_sec,
        identityDueSoonHours: parsed.data.identity_due_soon_hours,
        sink: operatorAlertSink,
      });
      res.json({
        schema_version: SCHEMA_VERSION,
        ...result,
      });
    }),
  );

  // OpenAPI 3.0 spec — the document an OpenServ catalog crawler / Postman /
  // Swagger UI ingests. Cached lightly so a busy crawler doesn't hammer.
  router.get("/v1/openapi.json", (req, res) => {
    const publicUrl =
      (process.env.MURMUR_PUBLIC_URL?.trim() || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(buildOpenApiSpec({ publicUrl }));
  });

  // /v1/skill.md — Claude-skill-format markdown that lets an agent owner
  // self-onboard through the current Privy account + API-key path.
  router.get("/v1/skill.md", (req, res) => {
    const apiBase = `${req.protocol}://${req.get("host")}`.replace(/\/$/, "");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(buildSkillMarkdown(apiBase));
  });

  // /embed.js — drop-in script that installs a live badge wherever the
  // script tag sits. Subscribes to /v1/stream so the badge refreshes on
  // every leaderboard.update without a page reload. ~2 kB ungzipped.
  router.get("/embed.js", (req, res) => {
    const publicUrl =
      (process.env.MURMUR_PUBLIC_URL?.trim() || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(EMBED_JS.replace(/__BASE__/g, publicUrl));
  });

  router.get("/v1/health", (_req, res) => {
    const privacy = {
      mode: "sealed_fhenix",
      pending_verdicts_private: true,
      public_reveal_after_horizon: true,
    };
    res.json({
      ok: true,
      schema_version: SCHEMA_VERSION,
      scoring_version: SCORING_VERSION,
      now: nowIso(now()),
      privacy,
    });
  });

  router.get("/v1/readyz", asyncHandler(async (_req, res) => {
    // 1. DB write probe — round-trip through schema_meta.
    const dbStart = Date.now();
    let dbOk = false;
    let dbError: string | null = null;
    try {
      deps.db
        .prepare(
          `INSERT INTO schema_meta(key, value) VALUES('readyz_probe', ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        )
        .run(String(Date.now()));
      dbOk = true;
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
    }
    const dbMs = Date.now() - dbStart;

    // 2. Oracle probe (if configured).
    const oracleStart = Date.now();
    let oracleStatus: "ok" | "fail" | "disabled" = "disabled";
    let oracleError: string | null = null;
    if (deps.oracleProbe) {
      try {
        const result = await deps.oracleProbe();
        if (result === null) {
          oracleStatus = "ok";
        } else {
          oracleStatus = "fail";
          oracleError = result;
        }
      } catch (err) {
        oracleStatus = "fail";
        oracleError = err instanceof Error ? err.message : String(err);
      }
    }
    const oracleMs = Date.now() - oracleStart;

    const privacy = {
      mode: "sealed_fhenix",
      threshold_network: "fhenix",
      submit_contract: "external",
      reveal_ingest: "/v1/admin/fhenix/reveals",
    };

    const canarySnapshot = deps.liveCanaries?.snapshot() ?? null;
    const canariesRequired = deps.requireLiveCanaries ?? false;
    const canariesOk = !canariesRequired || Boolean(canarySnapshot?.ok);

    const ready =
      dbOk && (oracleStatus === "ok" || oracleStatus === "disabled") && canariesOk;
    res.status(ready ? 200 : 503).json({
      ready,
      now: nowIso(now()),
      db: { ok: dbOk, latency_ms: dbMs, error: dbError },
      oracle: { status: oracleStatus, latency_ms: oracleMs, error: oracleError },
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
              error: check.error,
            })),
          }
        : {
            required: canariesRequired,
            ok: !canariesRequired,
            served_at: null,
            checks: [],
          },
      privacy,
    });
  }));

  router.get("/v1/meta", (_req, res) => {
    const rawFhenixChainId = process.env.FHENIX_CHAIN_ID?.trim();
    const fhenixChainIdNum = rawFhenixChainId ? Number(rawFhenixChainId) : NaN;
    const fhenixChain =
      Number.isInteger(fhenixChainIdNum) && fhenixChainIdNum > 0
        ? {
            chain_id: `eip155:${fhenixChainIdNum}`,
            chain_id_numeric: fhenixChainIdNum,
            contract_address: resolveFhenixContractAddress(fhenixChainIdNum),
          }
        : null;
    res.json({
      schema_version: SCHEMA_VERSION,
      scoring_version: SCORING_VERSION,
      strategy_tags: REGISTERED_STRATEGY_TAGS,
      assets: ["base:ETH:USD"],
      verified_volume_24h: get24hVerifiedVolume(deps.db),
      paid_inference: {
        current_venue: "polymarket-gamma",
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
    });
  });

  router.get("/v1/leaderboard", (req, res) => {
    const tier = req.query.tier;
    const limit = Number(req.query.limit ?? "200");
    const rows = getLeaderboard(deps.db, {
      tier: tier === "main" || tier === "provisional" ? tier : undefined,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 200,
    });
    res.json({
      schema_version: SCHEMA_VERSION,
      scoring_version: SCORING_VERSION,
      served_at: nowIso(now()),
      rows,
    });
  });

  router.get("/v1/agents", (req, res) => {
    const kind = String(req.query.kind ?? "");
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? "100")));
    const allowed = ["agent", "attested", "benchmark", "internal_test"] as const;
    if (!allowed.includes(kind as (typeof allowed)[number])) {
      res.status(400).json({
        code: "invalid_kind",
        message: `kind must be one of ${allowed.join("|")}`,
      });
      return;
    }
    const rows = agentsRepo.listByKind(deps.db, kind as (typeof allowed)[number], limit);
    res.json({
      schema_version: SCHEMA_VERSION,
      served_at: nowIso(now()),
      kind,
      count: rows.length,
      rows: rows.map((r) => ({
        agent_id: r.agent_id,
        display_slug: r.display_slug,
        display_name: r.display_name,
        kind: r.kind,
        bio: r.bio ?? null,
        created_at: r.created_at,
      })),
    });
  });

  router.get("/v1/agents/:slug", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const row = agentsRepo.bySlug(deps.db, slug);
    if (!row) {
      res.status(404).json({ code: ERROR_CODES.unknown_agent, message: "agent not found" });
      return;
    }
    const { api_key_hash, ...publicProfile } = row;
    void api_key_hash;
    res.json(publicProfile);
  });

  // ── ERC-8004 agent card (Draft) ──
  // Machine-readable agent card discoverable by ERC-8004 indexers and
  // launchpad marketplaces. Shape follows the Draft EIP registration JSON:
  //   { type, name, description, image?, services[], x402Support, active,
  //     registrations, supportedTrust? }
  // - `services` use `endpoint` (NOT `url`) per the canonical spec
  // - `agentWallet` is reserved on-chain metadata in the spec; NOT included
  //   here. Off-chain consumers read /v1/agents/:slug for Murmur's
  //   Controller Wallet binding (top-level wallet_address + chain_id fields).
  // - x402Support stays false until payment middleware is wired end-to-end.
  // - When v0.3 mints Identity Registry NFTs, tokenURI points here so
  //   the on-chain identity and the off-chain card stay in sync.
  router.get("/v1/agents/:slug/agent-card", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const row = agentsRepo.bySlug(deps.db, slug);
    if (!row) {
      res.status(404).json({ code: ERROR_CODES.unknown_agent, message: "agent not found" });
      return;
    }
    const apiBase = `${req.protocol}://${req.get("host")}`.replace(/\/$/, "");
    const card = {
      type: "ERC-8004:AgentCard",
      // Spec is Draft; pin the version we render against so consumers can
      // gate on it. Our compatibility layer follows the EIP shape from
      // late-2025 spec drafts (services use `endpoint`, agentWallet is
      // reserved for on-chain metadata).
      spec_version: "erc-8004-draft-2025",
      name: row.display_name,
      slug: row.display_slug,
      description:
        row.bio ??
        `Autonomous market-prediction agent registered on Murmur Verdict — scored against canonical Chainlink + Pyth oracles.`,
      services: [
        {
          type: "murmur-verdict.score",
          name: "Public Verdict score + call history",
          endpoint: `${apiBase}/v1/agents/${row.display_slug}`,
          // Read-only profile + recent calls + discoverers; no auth.
        },
        {
          type: "murmur-verdict.calls",
          name: "Gateway sealed Fhenix submit",
          endpoint: `${apiBase}/v2/gateway/calls`,
          // /v1/calls and /v2/calls return 410. /v2/gateway/calls is
          // Runtime-Key-only; verified-event backfill is admin-only recovery.
        },
        {
          type: "murmur-verdict.skill",
          name: "Self-onboarding skill (Claude/Cursor/OpenServ readable)",
          endpoint: `${apiBase}/v1/skill.md`,
        },
      ],
      x402Support: false,
      // The public card does not disclose whether active Runtime Keys or API
      // keys exist for this agent.
      active: row.kind === "agent",
      // Per the EIP, `registrations` is an array of (chain_id,
      // registration_id) tuples once an agent is on-chain. v0.2 has no
      // contract deploy yet, so we emit an empty array — consumers know
      // we plan to register but haven't yet.
      registrations: [] as Array<{ chain_id: string; registration_id: string }>,
      privacy: {
        submission_modes: ["sealed_fhenix"],
        threshold_network: "fhenix",
        operator_can_decrypt_pre_horizon: false,
        threat_model_url: `${apiBase}/v1/skill.md#threat-model--privacy-guarantees`,
      },
      // Optional v0.3+ fields surfaced when present. Always included off
      // the agent row so public profiles and the agent card stay consistent.
      ...(row.wallet_address && row.chain_id
        ? {
            // Non-spec sibling field: explicit Controller Wallet binding for
            // off-Murmur consumers that don't want to compose
            // /v1/agents/:slug. ERC-8004 reserves `agentWallet` for
            // on-chain metadata, so we expose it under our own key.
            murmur_wallet: {
              address: row.wallet_address,
              chain_id: row.chain_id,
            },
          }
        : {}),
      // Metadata block: when this card was generated + entry points
      // for crawlers. Wave 4b — the call history endpoint is the
      // canonical evidence trail (receipts subsystem dropped).
      meta: {
        served_at: nowIso(now()),
        call_history_entrypoint: `${apiBase}/v1/agents/${row.display_slug}/calls`,
        openapi: `${apiBase}/v1/openapi.json`,
        manifest: `${apiBase}/.well-known/murmur.json`,
      },
    };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(card);
  });

  router.get("/v1/agents/:slug/calls", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const agent = agentsRepo.bySlug(deps.db, slug);
    if (!agent) {
      res.status(404).json({ code: ERROR_CODES.unknown_agent, message: "agent not found" });
      return;
    }
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? "50")));
    const rawRows = deps.db
      .prepare(
        `SELECT s.call_id, s.status,
                s.submitted_at, s.accepted_at,
                s.privacy_mode, s.commit_hash,
                r.outcome, r.call_score, r.signed_return, r.resolved_at
         FROM submissions s
         LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
         WHERE s.agent_id = ?
         ORDER BY s.accepted_at DESC
         LIMIT ?`,
      )
      .all(agent.agent_id, limit) as Array<Record<string, unknown>>;
    const calls = rawRows.map((row) =>
      projectCallRow(
        {
          call_id: row.call_id as string,
          status: row.status as string,
          accepted_at: row.accepted_at as string,
          privacy_mode: row.privacy_mode as string | null,
          commit_hash: row.commit_hash as string | null,
          // Wave 4b: receipts subsystem dropped; projection always emits null.
          acceptance_receipt_hash: null,
          outcome: row.outcome as string | null,
          call_score: row.call_score as number | null,
          signed_return: row.signed_return as string | null,
          resolved_at: row.resolved_at as string | null,
          submitted_at: row.submitted_at as string | null,
        },
        agent.display_slug,
      ),
    );
    res.json({
      agent_id: agent.agent_id,
      display_slug: agent.display_slug,
      kind: agent.kind,
      calls,
    });
  });

  router.post(
    "/v1/feeds",
    json,
    asyncHandler(async (req, res) => {
      const auth = await requireAgentAuth(req);
      const parsed = FeedCreateBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new VerdictError(
          "feed contract failed schema validation",
          ERROR_CODES.schema_invalid,
          400,
          { issues: parsed.error.format() },
        );
      }
      const body = parsed.data;
      assertVenueSupported(body.venue);
      validateFeedCoveredMarkets(
        deps.db,
        body.covered_market_ids,
        body.venue,
        body.resolution_classes,
      );

      const createdAt = nowIso(now());
      const feedId = randomUUID();
      feedContractsRepo.insert(deps.db, {
        feed_id: feedId,
        agent_id: auth.agent_id,
        name: body.name,
        description: body.description ?? null,
        status: body.status,
        venue: body.venue,
        resolution_classes: body.resolution_classes,
        edge_classes: body.edge_classes,
        covered_market_ids: body.covered_market_ids,
        delivery_cadence_seconds: body.delivery_cadence_seconds ?? null,
        trigger_rules: body.trigger_rules,
        max_latency_seconds: body.max_latency_seconds ?? null,
        subscriber_capacity: body.subscriber_capacity,
        commercial_template: body.commercial_template,
        reveal_policy: body.reveal_policy,
        refund_rule: body.refund_rule,
        slash_rule: body.slash_rule,
        created_at: createdAt,
        updated_at: createdAt,
      });

      const row = feedContractsRepo.byId(deps.db, feedId);
      if (!row) {
        throw new Error(`feed insert did not persist feed_id=${feedId}`);
      }
      res.status(201).json({
        schema_version: SCHEMA_VERSION,
        feed: publicFeed(deps.db, row),
      });
    }),
  );

  router.get(
    "/v1/feeds",
    asyncHandler(async (req, res) => {
      const rawStatus = req.query.status;
      let status: z.infer<typeof FeedStatusSchema> | undefined;
      if (typeof rawStatus === "string" && rawStatus.length > 0) {
        const parsedStatus = FeedStatusSchema.safeParse(rawStatus);
        if (!parsedStatus.success) {
          throw new VerdictError(
            `status must be one of ${FEED_STATUSES.join("|")}`,
            ERROR_CODES.schema_invalid,
            400,
          );
        }
        status = parsedStatus.data;
      }
      const rawVenue = req.query.venue;
      const venue = typeof rawVenue === "string" && rawVenue.length > 0
        ? rawVenue
        : undefined;
      const rawAgentSlug = req.query.agent_slug;
      const agent = typeof rawAgentSlug === "string" && rawAgentSlug.length > 0
        ? agentsRepo.bySlug(deps.db, rawAgentSlug)
        : null;
      if (typeof rawAgentSlug === "string" && rawAgentSlug.length > 0 && !agent) {
        res.status(404).json({ code: ERROR_CODES.unknown_agent, message: "agent not found" });
        return;
      }
      const rawLimit = Number(req.query.limit ?? "100");
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(500, Math.floor(rawLimit)))
        : 100;
      let edgeClass: z.infer<typeof EdgeClassSchema> | null = null;
      if (typeof req.query.edge_class === "string" && req.query.edge_class.length > 0) {
        const parsedEdgeClass = EdgeClassSchema.safeParse(req.query.edge_class);
        if (!parsedEdgeClass.success) {
          throw new VerdictError(
            `edge_class must be one of ${EDGE_CLASSES.join("|")}`,
            ERROR_CODES.schema_invalid,
            400,
          );
        }
        edgeClass = parsedEdgeClass.data;
      }
      let resolutionClass: z.infer<typeof ResolutionClassSchema> | null = null;
      if (typeof req.query.resolution_class === "string" && req.query.resolution_class.length > 0) {
        const parsedResolutionClass = ResolutionClassSchema.safeParse(req.query.resolution_class);
        if (!parsedResolutionClass.success) {
          throw new VerdictError(
            `resolution_class must be one of ${RESOLUTION_CLASSES.join("|")}`,
            ERROR_CODES.schema_invalid,
            400,
          );
        }
        resolutionClass = parsedResolutionClass.data;
      }

      const feeds = feedContractsRepo
        .list(deps.db, {
          status,
          venue,
          agent_id: agent?.agent_id,
          limit,
        })
        .map((row) => publicFeed(deps.db, row))
        .filter((feed) =>
          edgeClass ? feed.edge_classes.includes(edgeClass) : true,
        )
        .filter((feed) =>
          resolutionClass
            ? feed.resolution_classes.includes(resolutionClass)
            : true,
        );

      res.json({
        schema_version: SCHEMA_VERSION,
        served_at: nowIso(now()),
        feeds,
        taxonomy: {
          resolution_classes: RESOLUTION_CLASSES,
          edge_classes: EDGE_CLASSES,
          commercial_templates: COMMERCIAL_TEMPLATES,
        },
      });
    }),
  );

  router.get(
    "/v1/feeds/:feed_id",
    asyncHandler(async (req, res) => {
      const feedId = String(req.params.feed_id ?? "");
      const row = feedContractsRepo.byId(deps.db, feedId);
      if (!row) {
        res.status(404).json({ code: "not_found", message: "feed not found" });
        return;
      }
      const includePackets = String(req.query.include_packets ?? "") === "true";
      res.json({
        schema_version: SCHEMA_VERSION,
        feed: publicFeed(deps.db, row),
        ...(includePackets
          ? {
              packets: feedPacketsRepo
                .listForFeed(deps.db, feedId, 50)
                .map(publicFeedPacket),
            }
          : {}),
      });
    }),
  );

  router.get(
    "/v1/feeds/:feed_id/availability",
    asyncHandler(async (req, res) => {
      const feedId = String(req.params.feed_id ?? "");
      const row = feedContractsRepo.byId(deps.db, feedId);
      if (!row) {
        res.status(404).json({ code: "not_found", message: "feed not found" });
        return;
      }
      res.json({
        schema_version: SCHEMA_VERSION,
        served_at: nowIso(now()),
        proof: buildFeedAvailabilityProof(deps.db, row, {
          now: now(),
          packetLimit: 100,
          incidentLimit: 500,
        }),
      });
    }),
  );

  router.post(
    "/v1/feeds/:feed_id/packets",
    json,
    asyncHandler(async (req, res) => {
      res.status(410).json({
        code: "endpoint_removed",
        message:
          "/v1/feeds/:feed_id/packets is retired as an agent feed path. Submit via /v2/gateway/feeds/:feed_id/packets with a Runtime Key.",
        replacement: "/v2/gateway/feeds/:feed_id/packets",
      });
    }),
  );

  router.post(
    "/v1/admin/fhenix/backfill/feeds/:feed_id/packets",
    json,
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const feedId = String(req.params.feed_id ?? "");
      const feed = feedContractsRepo.byId(deps.db, feedId);
      if (!feed) {
        res.status(404).json({ code: "not_found", message: "feed not found" });
        return;
      }
      if (feed.status === "retired") {
        throw new VerdictError(
          "retired feeds do not accept new sealed packets",
          ERROR_CODES.schema_invalid,
          409,
        );
      }

      const parsed = FeedPacketBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new VerdictError(
          "feed packet failed schema validation",
          ERROR_CODES.schema_invalid,
          400,
          { issues: parsed.error.format() },
        );
      }
      const body = parsed.data;
      validateFeedPacketMarket(deps.db, feed, body.market_id ?? null);

      const fhenixEvent = normalizeFeedFhenixEvent(body.fhenix);
      const existing = feedPacketsRepo.byFhenixEvent(deps.db, {
        chain_id: fhenixEvent.chain_id,
        contract_address: fhenixEvent.contract_address,
        onchain_packet_id: fhenixEvent.onchain_packet_id,
      });
      if (existing) {
        res.status(200).json({
          schema_version: SCHEMA_VERSION,
          packet: publicFeedPacket(existing),
          idempotent_hit: true,
        });
        return;
      }

      const acceptedAtMs = parseIsoMs(fhenixEvent.accepted_at, "fhenix.accepted_at");
      const revealAfterMs = parseIsoMs(fhenixEvent.reveal_after, "fhenix.reveal_after");
      if (revealAfterMs < acceptedAtMs) {
        throw new VerdictError(
          "fhenix.reveal_after must be at or after fhenix.accepted_at",
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      if (acceptedAtMs > now().getTime() + 5 * 60 * 1000) {
        throw new VerdictError(
          "fhenix.accepted_at is too far in the future",
          ERROR_CODES.schema_invalid,
          400,
        );
      }

      let inserted: FeedPacketRow | null = null;
      try {
        inserted = deps.db.transaction(() => {
          const sequence =
            body.sequence ?? feedPacketsRepo.nextSequence(deps.db, feedId);
          const latest = feedPacketsRepo.latestForFeed(deps.db, feedId);
          const deadline =
            body.delivery_deadline_at ??
            inferFeedDeliveryDeadline(feed, latest, sequence);
          const slaStatus = classifyFeedPacketSla(fhenixEvent.accepted_at, deadline);
          const packetId = randomUUID();
          feedPacketsRepo.insert(deps.db, {
            packet_id: packetId,
            feed_id: feedId,
            agent_id: feed.agent_id,
            market_id: body.market_id ?? null,
            packet_kind: body.packet_kind,
            sequence,
            payload_schema: body.payload_schema,
            submitted_at: body.submitted_at ?? fhenixEvent.accepted_at,
            accepted_at: fhenixEvent.accepted_at,
            reveal_after: fhenixEvent.reveal_after,
            delivery_deadline_at: deadline,
            sla_status: slaStatus,
            chain_id: fhenixEvent.chain_id,
            contract_address: fhenixEvent.contract_address,
            onchain_packet_id: fhenixEvent.onchain_packet_id,
            submit_tx_hash: fhenixEvent.submit_tx_hash,
            submit_log_index: fhenixEvent.submit_log_index,
            packet_ct_hash: fhenixEvent.packet_ct_hash,
            binary_index_ct_hash: fhenixEvent.binary_index_ct_hash,
            confidence_ct_hash: fhenixEvent.confidence_ct_hash,
            created_at: nowIso(now()),
          });
          const row = feedPacketsRepo.byFhenixEvent(deps.db, {
            chain_id: fhenixEvent.chain_id,
            contract_address: fhenixEvent.contract_address,
            onchain_packet_id: fhenixEvent.onchain_packet_id,
          });
          if (!row) {
            throw new Error(`feed packet insert did not persist feed_id=${feedId}`);
          }
          return row;
        })();
      } catch (err) {
        if (isUniqueViolation(err)) {
          const duplicate = feedPacketsRepo.byFhenixEvent(deps.db, {
            chain_id: fhenixEvent.chain_id,
            contract_address: fhenixEvent.contract_address,
            onchain_packet_id: fhenixEvent.onchain_packet_id,
          });
          if (duplicate) {
            res.status(200).json({
              schema_version: SCHEMA_VERSION,
              packet: publicFeedPacket(duplicate),
              idempotent_hit: true,
            });
            return;
          }
          throw new VerdictError(
            "duplicate feed packet sequence or Fhenix event",
            ERROR_CODES.duplicate,
            409,
          );
        }
        throw err;
      }

      if (!inserted) {
        throw new Error(`feed packet transaction returned no row for feed_id=${feedId}`);
      }
      res.status(201).json({
        schema_version: SCHEMA_VERSION,
        packet: publicFeedPacket(inserted),
        reliability: feedReliabilityEnvelope(feedContractsRepo.reliability(deps.db, feedId)),
        idempotent_hit: false,
      });
    }),
  );

  router.get(
    "/v1/admin/feeds/sla",
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const rawStatus = typeof req.query.status === "string" ? req.query.status : undefined;
      const parsedStatus = rawStatus
        ? FeedSlaIncidentStatusSchema.safeParse(rawStatus)
        : null;
      if (rawStatus && !parsedStatus?.success) {
        throw new VerdictError(
          "invalid feed SLA incident status",
          ERROR_CODES.schema_invalid,
          400,
          { status: rawStatus },
        );
      }
      const rawLimit = Number(req.query.limit ?? "100");
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(500, Math.floor(rawLimit)))
        : 100;
      const feedId = typeof req.query.feed_id === "string" && req.query.feed_id.length > 0
        ? req.query.feed_id
        : undefined;
      const incidents = feedSlaIncidentsRepo
        .list(deps.db, {
          feed_id: feedId,
          status: parsedStatus?.success ? parsedStatus.data : undefined,
          limit,
        })
        .map(publicFeedSlaIncident);
      const feed_health = feedContractsRepo
        .listCadenceListed(deps.db, { limit: 100 })
        .map((row) => feedAvailabilitySummary(deps.db, row, { now: now() }));
      const refundRecommendations = incidents.reduce(
        (acc, incident) => acc + (incident.refund_action === "none" ? 0 : 1),
        0,
      );
      const slashRecommendations = incidents.reduce(
        (acc, incident) => acc + (incident.slash_action === "none" ? 0 : 1),
        0,
      );
      res.json({
        schema_version: SCHEMA_VERSION,
        served_at: nowIso(now()),
        summary: {
          open_incidents: incidents.filter((incident) => incident.status === "open").length,
          refund_recommendations: refundRecommendations,
          slash_recommendations: slashRecommendations,
          failing_feeds: feed_health.filter((feed) => feed.health_status === "failing").length,
          degraded_feeds: feed_health.filter((feed) => feed.health_status === "degraded").length,
          payment_execution_enabled: false,
        },
        feed_health,
        incidents,
      });
    }),
  );

  router.post(
    "/v1/admin/feeds/sla/tick",
    json,
    asyncHandler(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const parsed = FeedSlaTickBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new VerdictError(
          "feed SLA tick failed schema validation",
          ERROR_CODES.schema_invalid,
          400,
          { issues: parsed.error.format() },
        );
      }
      const result = runFeedSlaTick(deps.db, {
        now,
        maxIncidents: parsed.data.max_incidents,
        feedLimit: parsed.data.feed_limit,
      });
      res.json({
        schema_version: SCHEMA_VERSION,
        result,
        open_incidents: feedSlaIncidentsRepo
          .list(deps.db, { status: "open", limit: 100 })
          .map(publicFeedSlaIncident),
      });
    }),
  );

  router.get("/v1/feed/today", (_req, res) => {
    res.json(getTodayFeed(deps.db, now()));
  });

  // Public aggregates — "Murmur in numbers" for press / dashboards / pitch
  // decks. Cheap aggregates over the existing tables; cached 60s. Never
  // surfaces secrets / URLs / personal handles.
  router.get("/v1/stats", (_req, res) => {
    const totals = deps.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM agents)                                   AS agents_total,
           (SELECT COUNT(*) FROM agents WHERE kind = 'agent')              AS agents_active,
           (SELECT COUNT(*) FROM agents WHERE kind = 'attested')           AS agents_attested,
           (SELECT COUNT(*) FROM agents WHERE kind = 'benchmark')          AS agents_benchmark,
           (SELECT COUNT(*) FROM submissions)                              AS calls_total,
           (SELECT COUNT(*) FROM submissions WHERE status = 'resolved')    AS calls_resolved,
           (SELECT COUNT(*) FROM submissions WHERE status IN ('accepted','pending_t0','pending_t1')) AS calls_pending,
           (SELECT COUNT(*) FROM t1_resolutions WHERE outcome = 'win')     AS wins_total,
           (SELECT COUNT(*) FROM t1_resolutions WHERE outcome = 'loss')    AS losses_total,
           (SELECT COUNT(*) FROM t1_resolutions WHERE outcome IN ('void','oracle_unavailable')) AS void_total,
           (SELECT AVG(call_score) FROM t1_resolutions WHERE call_score IS NOT NULL)             AS mean_call_score,
           (SELECT COUNT(*) FROM webhooks WHERE disabled = 0)              AS webhooks_active,
           (SELECT COUNT(*) FROM ref_clicks)                               AS refs_buckets,
           (SELECT SUM(total) FROM ref_clicks)                             AS refs_clicks_total`,
      )
      .get() as Record<string, number | null>;

    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json({
      schema_version: SCHEMA_VERSION,
      scoring_version: SCORING_VERSION,
      served_at: nowIso(now()),
      stream_subscribers: deps.events?.subscriberCount() ?? 0,
      ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v ?? 0])),
    });
  });

  // Markdown snapshot — daily/weekly digest of the leaderboard formatted
  // for Discord recap channels, blog cross-posts, paste-into-X long-form.
  router.get("/v1/snapshot.md", (_req, res) => {
    const rows = getLeaderboard(deps.db, { limit: 10 });
    const today = getTodayFeed(deps.db, now());
    const lines: string[] = [];
    lines.push(`# Murmur Verdict — daily snapshot`);
    lines.push(``);
    lines.push(`*${nowIso(now())}*`);
    lines.push(``);
    lines.push(
      `**24h:** ${today.totals.accepted_24h} accepted · ${today.totals.resolved_24h} resolved · ${today.totals.wins_24h} wins · ${today.totals.losses_24h} losses · ${today.totals.void_24h} void`,
    );
    lines.push(``);
    lines.push(`## Top 10`);
    lines.push(``);
    lines.push(`| # | Agent | Verdict | Win rate | Resolved | Pending |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const r of rows) {
      const rank = r.rank ? String(r.rank).padStart(2, "0") : "—";
      const verdict =
        r.verdict_score === null
          ? "—"
          : `${r.verdict_score >= 0 ? "+" : "−"}${Math.round(Math.abs(r.verdict_score) * 1000)}σ`;
      const winRate =
        r.win_rate === null ? "—" : `${Math.round(r.win_rate * 100)}%`;
      lines.push(
        `| ${rank} | ${r.display_name} | ${verdict} | ${winRate} | ${r.resolved_calls} | ${r.pending_calls} |`,
      );
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
    lines.push(`*Calls scored against canonical Chainlink + Pyth feeds. Receipts are independently verifiable.*`);
    lines.push(``);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=600");
    res.send(lines.join("\n"));
  });

  // CSV export of the leaderboard for spreadsheet integration. Streams
  // the same data the dashboard renders; no auth, public.
  router.get("/v1/leaderboard.csv", (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? "200")));
    const rows = getLeaderboard(deps.db, { limit });
    const header = "rank,display_slug,display_name,kind,tier,verdict_score,win_rate,resolved_calls,pending_calls,last_resolved_at";
    const body = rows
      .map((r) =>
        [
          r.rank ?? "",
          csvCell(r.display_slug),
          csvCell(r.display_name),
          r.kind,
          r.tier,
          r.verdict_score ?? "",
          r.win_rate ?? "",
          r.resolved_calls,
          r.pending_calls,
          r.last_resolved_at ?? "",
        ].join(","),
      )
      .join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.setHeader("Content-Disposition", "inline; filename=\"leaderboard.csv\"");
    res.send(`${header}\n${body}\n`);
  });

  // ── Webhooks ──
  // Discord / Telegram / Zapier / OpenServ workflows / custom servers
  // can subscribe to call.accepted + call.resolved events for one agent
  // (or all agents). Each delivery is signed HMAC-SHA256(secret, body)
  // — subscribers verify via the X-Murmur-Signature: sha256=<hex> header.
  // No auth on registration in v0.1; abuse handled by failure-count
  // monitoring + manual disable.
  router.post(
    "/v1/webhooks",
    express.json({ limit: "2kb" }),
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { url?: unknown; agent_slug?: unknown };
      if (typeof body.url !== "string") {
        res.status(400).json({ code: "invalid_url", message: "url must be a string" });
        return;
      }
      if (body.url.length > 2048) {
        res.status(400).json({ code: "invalid_url", message: "url too long" });
        return;
      }
      const validation = await validateWebhookUrl(body.url);
      if (!validation.ok) {
        res.status(400).json({ code: "invalid_url", message: validation.reason });
        return;
      }
      let agent_slug: string | null = null;
      if (typeof body.agent_slug === "string" && body.agent_slug.length > 0) {
        agent_slug = body.agent_slug.slice(0, 64);
        if (!agentsRepo.bySlug(deps.db, agent_slug)) {
          res.status(404).json({ code: "unknown_agent", message: "agent_slug not found" });
          return;
        }
      }
      const id = randomUUID();
      const secret = randomBytes(24).toString("base64url");
      const created_at = nowIso(now());
      webhooksRepo.insert(deps.db, { id, agent_slug, url: validation.url, secret, created_at });
      res.status(201).json({
        id,
        agent_slug,
        url: validation.url,
        secret, // returned only once on creation
        created_at,
        verify_signature: {
          algorithm: "sha256",
          header: "X-Murmur-Signature",
          format: "sha256=<hex>",
          body_to_sign: "raw request body",
        },
      });
    }),
  );

  router.get("/v1/webhooks/:id", (req, res) => {
    const id = String(req.params.id ?? "");
    const row = webhooksRepo.byId(deps.db, id);
    if (!row) {
      res.status(404).json({ code: "not_found", message: "webhook not found" });
      return;
    }
    // never echo the secret on read
    const { secret: _ignored, ...publicRow } = row;
    void _ignored;
    res.json({ schema_version: SCHEMA_VERSION, webhook: publicRow });
  });

  router.delete("/v1/webhooks/:id", (req, res) => {
    const id = String(req.params.id ?? "");
    const row = webhooksRepo.byId(deps.db, id);
    if (!row) {
      res.status(404).json({ code: "not_found", message: "webhook not found" });
      return;
    }
    // Soft-auth via the secret on the X-Murmur-Webhook-Secret header so the
    // owner of the secret (which only they have, from the create response)
    // is the one who can delete.
    const provided = req.header("X-Murmur-Webhook-Secret");
    if (!safeStrEq(provided, row.secret)) {
      res.status(403).json({ code: "forbidden", message: "secret mismatch" });
      return;
    }
    webhooksRepo.delete(deps.db, id);
    res.status(204).end();
  });

  // ── Outreach attribution ──
  // The /share/:slug page pings POST /v1/refs/:ref/click on mount when a
  // ?ref=<sender> param is present. Counts are bucketed by (ref, slug)
  // and exposed via /v1/agents/:slug/discoverers (rendered as
  // 'discovered by @sender' on the agent profile) and /v1/refs (admin
  // overview of top recruiters).
  //
  // Conversions are not exposed as a public POST. Account-page attribution
  // is derived from stored ref clicks when the account flow emits a matching
  // usage event.

  router.post(
    "/v1/refs/:ref/click",
    express.json({ limit: "1kb" }),
    (req, res) => {
      const ref = sanitizeRef(req.params.ref);
      if (!ref) {
        res.status(400).json({ code: "invalid_ref", message: "ref must be 1–32 chars [a-zA-Z0-9_.-]" });
        return;
      }
      const body = (req.body ?? {}) as { agent_slug?: unknown };
      let slug: string | null = null;
      if (typeof body.agent_slug === "string" && body.agent_slug.length > 0) {
        slug = body.agent_slug.slice(0, 64);
      }
      refsRepo.bumpClick(deps.db, ref, slug, nowIso(now()));
      res.status(204).end();
    },
  );

  router.get("/v1/refs", (req, res) => {
    if (adminToken && !safeStrEq(req.header("X-Admin-Token"), adminToken)) {
      res.status(403).json({ code: "forbidden", message: "admin token required" });
      return;
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? "50")));
    res.json({
      schema_version: SCHEMA_VERSION,
      served_at: nowIso(now()),
      senders: refsRepo.topSenders(deps.db, limit),
    });
  });

  // Wave 4b — admin upsert for Polymarket conditionId markets. The
  // operator POSTs a conditionId; the daemon fetches it from Gamma,
  // builds a `markets` row via marketsRepo.upsertExternalMarket, and
  // returns the resulting MarketRow JSON.
  //
  // The synthetic anchors seeded by MIGRATION_029 satisfy the
  // markets.asset_id + markets.primary_oracle_id FK constraints
  // ('polymarket:event' asset; 'polymarket-gamma-oracle' oracle).
  // The daemon no longer starts the Gamma sync ticker at boot; this admin
  // path registers the adapter lazily without passing a DB handle.
  //
  // Guard: requires VERDICT_ADMIN_TOKEN, same posture as the other
  // admin-gated endpoints. Body is validated with a Zod schema; any
  // Gamma fetch failure surfaces a 502 (the conditionId is unknown
  // upstream). Idempotent — re-POSTing the same conditionId refreshes
  // the cached metadata.
  router.post(
    "/v1/admin/markets/polymarket",
    express.json(),
    asyncHandler(async (req, res) => {
      if (!adminToken) {
        res.status(503).json({
          code: "admin_disabled",
          message: "VERDICT_ADMIN_TOKEN not set",
        });
        return;
      }
      if (!safeStrEq(req.header("X-Admin-Token"), adminToken)) {
        res.status(403).json({
          code: "forbidden",
          message: "admin token required",
        });
        return;
      }
      const Body = z
        .object({
          conditionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
          // Default 'listed' — operators almost always want a freshly
          // registered Polymarket market to accept submissions immediately.
          status: z
            .enum(["draft", "listed", "frozen", "retired"])
            .default("listed"),
          // Optional override; otherwise derived from the Gamma row's
          // endDate (resolver doesn't anchor t0/t1 on event_binary markets,
          // so the value is bookkeeping only).
          horizon_seconds: z.number().int().positive().optional(),
          // Optional Murmur-native market taxonomy override. This lets a
          // Polymarket binary row identify as sports_match, event_binary, etc.
          // without changing the venue adapter or scoring shape.
          resolution_class: ResolutionClassSchema.optional(),
        })
        .strict();
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: "schema_invalid",
          issues: parsed.error.format(),
        });
        return;
      }
      const { conditionId, status, horizon_seconds, resolution_class } =
        parsed.data;
      const { registerPolymarketGammaAdapter } = await import(
        "../markets/polymarket-gamma/register.js"
      );
      registerPolymarketGammaAdapter();
      const { PolymarketGammaClient } = await import(
        "../markets/polymarket-gamma/client.js"
      );
      const client = new PolymarketGammaClient();
      const fetched = await client.fetchMarketByConditionId(conditionId);
      if (!fetched.snapshot) {
        res.status(502).json({
          code: "gamma_fetch_failed",
          message: `Polymarket Gamma returned no snapshot for ${conditionId}`,
          gamma_error: fetched.error,
        });
        return;
      }
      const snapshot = fetched.snapshot;
      // Pull a few canonical fields off the snapshot for the row;
      // everything else flows through `config_json` for the adapter.
      const endDateMs = snapshot.endDate
        ? Date.parse(snapshot.endDate)
        : Number.NaN;
      // Codex Wave 4b BLOCKER fix — refuse to mark a past-ended Polymarket
      // market `listed`. Without this guard, an operator who upserts a
      // conditionId whose endDate is in the past gets a market that
      // accepts agent submissions but resolves effectively immediately.
      // The acceptable shapes are:
      //   - status='listed' AND endDate is in the future (or absent)
      //   - status='draft' / 'frozen' / 'retired' regardless of endDate
      //     (operator opts in to a non-accepting state)
      const remainingSec = Number.isFinite(endDateMs)
        ? Math.floor((endDateMs - Date.now()) / 1000)
        : Number.NaN;
      const endDatePast = Number.isFinite(remainingSec) && remainingSec <= 0;
      if (endDatePast && status === "listed") {
        res.status(422).json({
          code: "market_already_resolved",
          message:
            "Polymarket endDate is in the past; refuse to upsert as 'listed' (use status='frozen' to register a backfill row).",
          endDate: snapshot.endDate ?? null,
        });
        return;
      }
      const derivedHorizonSec = Number.isFinite(remainingSec)
        ? Math.max(60, remainingSec)
        : 7 * 24 * 60 * 60;
      const horizonSec = horizon_seconds ?? derivedHorizonSec;
      const slugCandidate =
        typeof snapshot.slug === "string" ? snapshot.slug : null;
      const outcomesField = snapshot.outcomes;
      let outcomes: string[] = ["YES", "NO"];
      if (typeof outcomesField === "string") {
        try {
          const parsedOutcomes = JSON.parse(outcomesField) as unknown;
          if (
            Array.isArray(parsedOutcomes) &&
            parsedOutcomes.length === 2 &&
            parsedOutcomes.every((o) => typeof o === "string")
          ) {
            outcomes = parsedOutcomes as string[];
          }
        } catch {
          // Gamma sometimes serializes outcomes oddly; the adapter's
          // marketConfigSchema is the authoritative validator at read time.
        }
      }
      const configJson = JSON.stringify({
        conditionId,
        slug: slugCandidate ?? conditionId.slice(0, 10),
        outcomes,
        endDate: snapshot.endDate ?? null,
        ...(typeof snapshot.umaBond === "string" ? { umaBond: snapshot.umaBond } : {}),
        ...(typeof snapshot.resolvedBy === "string"
          ? { resolvedBy: snapshot.resolvedBy }
          : {}),
        ...(resolution_class ? { resolution_class } : {}),
        gamma_url: `https://polymarket.com/event/${slugCandidate ?? conditionId}`,
      });
      const created_at = nowIso(now());
      // Wave 5 codex review BLOCKER + MINOR — wrap upsert + audit event
      // in a single transaction so a crash between the two cannot land a
      // market mutation without its audit row. Re-read the row inside
      // the txn so the audit payload logs persisted values (closes the
      // horizon_seconds-drift footgun on re-upserts where the SQL's
      // ON CONFLICT clause doesn't refresh every column).
      const row = deps.db.transaction(() => {
        marketsRepo.upsertExternalMarket(deps.db, {
          market_id: conditionId,
          asset_id: "polymarket:event",
          market_kind: "event_binary",
          horizon_seconds: horizonSec,
          primary_oracle_id: "polymarket-gamma-oracle",
          adapter_id: "polymarket-gamma",
          market_family: "prediction-market-binary",
          scoring_kind: "multinomial_brier",
          config_json: configJson,
          void_band: "0",
          status,
          created_at,
        });
        const persisted = marketsRepo.get(deps.db, conditionId);
        agentSecurityEventsRepo.emit(deps.db, {
          event_id: randomUUID(),
          agent_id: null,
          account_id: null,
          kind: "admin_polymarket_upsert",
          actor: "admin_token",
          payload: {
            conditionId,
            status,
            requested_horizon_seconds: horizonSec,
            persisted_horizon_seconds:
              persisted?.horizon_seconds ?? null,
            slug: slugCandidate ?? null,
          },
          created_at,
        });
        return persisted;
      })();
      res.status(201).json({
        schema_version: SCHEMA_VERSION,
        market: row,
      });
    }),
  );

  // Admin-only delete of a sender's ref bucket — used to clear noise / spam
  // from the recruiters board. Requires the same admin token as the full
  // listing.
  router.delete("/v1/refs/:ref", (req, res) => {
    if (!adminToken) {
      res.status(503).json({ code: "admin_disabled", message: "VERDICT_ADMIN_TOKEN not set" });
      return;
    }
    if (!safeStrEq(req.header("X-Admin-Token"), adminToken)) {
      res.status(403).json({ code: "forbidden", message: "admin token required" });
      return;
    }
    const ref = sanitizeRef(req.params.ref);
    if (!ref) {
      res.status(400).json({ code: "invalid_ref" });
      return;
    }
    // Wave 5 codex review BLOCKER — wrap DELETE + audit event in a
    // single transaction so a crash between them cannot delete evidence
    // without recording who did it.
    const deleted_rows = deps.db.transaction(() => {
      const info = deps.db
        .prepare("DELETE FROM ref_clicks WHERE ref = ?")
        .run(ref);
      agentSecurityEventsRepo.emit(deps.db, {
        event_id: randomUUID(),
        agent_id: null,
        account_id: null,
        kind: "admin_ref_delete",
        actor: "admin_token",
        payload: { ref, deleted_rows: info.changes },
        created_at: nowIso(now()),
      });
      return info.changes;
    })();
    res.json({ deleted: deleted_rows });
  });

  // Public mirror of /v1/refs — capped harder so it can never enumerate
  // the full sender set. The recruiters dashboard renders from this.
  router.get("/v1/refs/top", (req, res) => {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? "20")));
    res.json({
      schema_version: SCHEMA_VERSION,
      served_at: nowIso(now()),
      senders: refsRepo.topSenders(deps.db, limit),
    });
  });

  // Per-agent RSS 2.0 feed — Discord bots / RSS readers / OpenServ agents
  // can subscribe to an agent's call activity without polling. Cacheable
  // for 60s; rebuild from the existing agent_calls query.
  router.get("/v1/agents/:slug/calls.xml", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const agent = agentsRepo.bySlug(deps.db, slug);
    if (!agent) {
      res.status(404).type("application/xml").send(rssEmpty(slug, "agent not found"));
      return;
    }
    const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? "20")));
    const raw = deps.db
      .prepare(
        `SELECT s.call_id, s.status, s.submitted_at, s.accepted_at,
                s.privacy_mode, s.commit_hash,
                s.adapter_id, s.market_family,
                r.outcome, r.call_score, r.signed_return, r.resolved_at
         FROM submissions s
         LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
         WHERE s.agent_id = ?
         ORDER BY s.accepted_at DESC
         LIMIT ?`,
      )
      .all(agent.agent_id, limit) as Array<Record<string, unknown>>;
    const rows = raw.map((r) => {
      const projected = projectCallRow({
        call_id: r.call_id as string,
        status: r.status as string,
        accepted_at: r.accepted_at as string,
        privacy_mode: r.privacy_mode as string | null,
        commit_hash: r.commit_hash as string | null,
        submitted_at: r.submitted_at as string | null,
      });
      // Phase 10 / Z4-extra Drift C — adapter/family discriminators flow
      // to the RSS formatter so non-native rows omit signed_return.
      const adapter_id = (r.adapter_id as string | null) ?? "native-price";
      const market_family =
        (r.market_family as string | null) ?? "financial-direction";
      const isNativePrice = adapter_id === "native-price";
      return {
        call_id: projected.call_id,
        status: projected.status,
        privacy_mode: projected.privacy_mode,
        commit_hash: projected.commit_hash,
        // RSS compatibility placeholders. Verdict fields stay absent from
        // the public feed until the post-horizon reveal.
        asset_id: "",
        side: "BUY" as const,
        horizon_hours: 0,
        confidence: 0,
        submitted_at: projected.submitted_at ?? "",
        is_sealed_scrubbed: true,
        accepted_at: projected.accepted_at,
        adapter_id,
        market_family,
        outcome: r.outcome as string | null,
        call_score: r.call_score as number | null,
        signed_return: isNativePrice
          ? (r.signed_return as string | null)
          : null,
        resolved_at: r.resolved_at as string | null,
      };
    });

    const dashboardOrigin =
      (req.header("origin") ?? req.header("referer") ?? "https://murmur.verdict").replace(/\/$/, "");
    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.send(rssAgentFeed(agent, rows, dashboardOrigin));
  });

  router.get("/v1/agents/:slug/discoverers", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const limit = Math.max(1, Math.min(20, Number(req.query.limit ?? "5")));
    const rows = refsRepo.discoverersForAgent(deps.db, slug, limit);
    res.json({
      schema_version: SCHEMA_VERSION,
      slug,
      discoverers: rows,
    });
  });

  // ── Shareable embed assets — SVG badge + OG social card ──
  // Both routes are public, cacheable, ETag-aware. No auth: the data
  // surfaced is the same as /v1/leaderboard. Designed to be dropped
  // into READMEs / Discord bios / OpenServ profiles / X bios.
  router.get("/v1/badge/:slug.svg", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const { svg, etag } = renderBadgeSvg(deps.db, slug);
    if (req.header("If-None-Match") === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
    res.setHeader("ETag", etag);
    res.send(svg);
  });

  router.get("/v1/og/:slug.svg", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const { svg, etag } = renderOgSvg(deps.db, slug);
    if (req.header("If-None-Match") === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=600");
    res.setHeader("ETag", etag);
    res.send(svg);
  });

  // ── /share/:slug — OG-meta interceptor for hash-routed SPA ──
  //
  // Twitter / Discord / Slack ignore the URL fragment when scraping link
  // previews — they only see /index.html, which has static OG meta. To
  // unfurl per-agent cards correctly, point share links at the daemon's
  // /share/:slug instead. We respond with a tiny HTML page that:
  //   - declares og:image / twitter:image pointing at /v1/og/:slug.png
  //   - declares og:title / og:description per agent
  //   - meta-refreshes browsers to the dashboard's /#/share/:slug route
  //   - degrades to a plain anchor for clients that ignore meta-refresh
  //
  // No JavaScript, no SSR framework. Just a few hundred bytes of HTML.
  router.get("/share/:slug", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const ref = sanitizeRef(req.query.ref);
    const agent = agentsRepo.bySlug(deps.db, slug);

    // Trust ONLY the operator-configured dashboard origin. Earlier versions
    // also honored `?dashboard=<url>` and the request `Origin` header, which
    // turned this endpoint into an open-redirect/phishing primitive (an
    // attacker could craft `/share/<slug>?dashboard=https://evil` and the
    // page would meta-refresh to that origin under the daemon's URL). The
    // dashboard URL is now config-only; with no config we render the OG
    // page with no redirect target.
    const dashboardOrigin = (() => {
      const raw = (process.env.MURMUR_DASHBOARD_URL ?? process.env.MURMUR_PUBLIC_URL ?? "").trim();
      if (!raw) return "";
      try {
        const u = new URL(raw);
        if (u.protocol !== "https:" && u.protocol !== "http:") return "";
        return `${u.protocol}//${u.host}`;
      } catch {
        return "";
      }
    })();

    const apiOrigin = `${req.protocol}://${req.get("host")}`;
    const ogPng = `${apiOrigin}/v1/og/${encodeURIComponent(slug)}.png`;
    const dashHash = `${dashboardOrigin}/#/share/${encodeURIComponent(slug)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;

    const title = agent
      ? `${agent.display_name} — Murmur Verdict`
      : `${slug} — Murmur Verdict`;
    const description = agent
      ? `Live verdict for ${agent.display_name} (@${agent.display_slug}) — scored against canonical Chainlink + Pyth feeds.`
      : "The public referee for autonomous market agents.";

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />

  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:image" content="${escapeHtml(ogPng)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:type" content="image/png" />
  ${dashboardOrigin ? `<meta property="og:url" content="${escapeHtml(dashHash)}" />` : ""}

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(ogPng)}" />

  ${dashboardOrigin ? `<meta http-equiv="refresh" content="0; url=${escapeHtml(dashHash)}" />` : ""}
  <style>
    html, body { margin:0; padding:0; background:#000; color:#fff; font-family: ui-monospace, "SF Mono", monospace; }
    body { display:flex; min-height:100dvh; align-items:center; justify-content:center; padding:48px; }
    a { color:#fff; }
    img { max-width:100%; height:auto; display:block; margin:24px auto; }
    .meta { text-transform:uppercase; letter-spacing:0.16em; font-size:11px; color:#888; }
  </style>
</head>
<body>
  <div>
    <div class="meta">murmur.verdict · ${agent ? "agent" : "share"}</div>
    <h1 style="font-weight:500;font-size:24px;margin:8px 0 0;">${escapeHtml(title)}</h1>
    <img src="${escapeHtml(ogPng)}" alt="${escapeHtml(title)}" width="1200" height="630" />
    <p style="font-size:13px;color:#999;">
      ${dashboardOrigin
        ? `Redirecting to <a href="${escapeHtml(dashHash)}">${escapeHtml(dashHash)}</a> …`
        : `Set <code>MURMUR_PUBLIC_URL</code> on the daemon to enable redirect.`}
    </p>
  </div>
</body>
</html>`);
  });

  // PNG variants — needed for X / Discord / Slack OG previews (those
  // clients don't render SVG inline). Same source layout, rasterised
  // server-side via resvg.
  router.get("/v1/badge/:slug.png", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const { svg } = renderBadgeSvg(deps.db, slug);
    const { png, etag } = rasterize(svg, 640);
    if (req.header("If-None-Match") === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
    res.setHeader("ETag", etag);
    res.send(png);
  });

  router.get("/v1/og/:slug.png", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const { svg } = renderOgSvg(deps.db, slug);
    const { png, etag } = rasterize(svg, 1200);
    if (req.header("If-None-Match") === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=600");
    res.setHeader("ETag", etag);
    res.send(png);
  });

  // ── /v1/stream — Server-Sent Events fan-out for the live dashboard ──
  // No auth in v0.1; the data is already public via the read endpoints.
  // Closes itself if `deps.events` is undefined (smoke / test deployments).
  router.get("/v1/stream", (req: Request, res: Response) => {
    const bus = deps.events;
    if (!bus) {
      res.status(503).json({
        code: "stream_unavailable",
        message: "event bus not configured on this deployment",
      });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx response buffering
    res.flushHeaders?.();

    // Replay current snapshot once so a freshly-connected client can paint
    // the leaderboard + 24h stats without a separate REST round-trip.
    try {
      const rows = getLeaderboard(deps.db, { limit: 20 });
      writeSseFrame(res, "leaderboard.update", {
        type: "leaderboard.update",
        served_at: nowIso(now()),
        rows: rows.map((r) => ({
          rank: r.rank,
          agent_id: r.agent_id,
          display_slug: r.display_slug,
          display_name: r.display_name,
          kind: r.kind,
          verdict_score: r.verdict_score,
          win_rate: r.win_rate,
          resolved_calls: r.resolved_calls,
          pending_calls: r.pending_calls,
        })),
      });
    } catch {
      // best-effort snapshot; live deltas still flow even if the snapshot fails
    }

    const unsubscribe = bus.subscribe((event) => {
      writeSseFrame(res, event.type, event);
    });

    // Heartbeat every 25s so corporate proxies don't kill the connection
    // before the first real event arrives.
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 25_000);

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        // already closed
      }
    };

    req.on("close", close);
    req.on("error", close);
  });

  router.post(
    "/v1/calls/:call_id/reveal",
    asyncHandler(async (_req, res) => {
      res.status(410).json({
        code: "endpoint_removed",
        message:
          "/v1/calls/:call_id/reveal is retired. Fhenix reveals are ingested from verified contract events via /v1/admin/fhenix/reveals.",
      });
    }),
  );

  router.get("/v1/calls/:call_id/envelope", (_req, res) => {
    res.status(410).json({
      code: "endpoint_removed",
      message:
        "/v1/calls/:call_id/envelope is retired. Sealed Fhenix call metadata is available on /v1/calls/:call_id.",
    });
  });


  // Wave 4b — /v1/calls/:call_id/verify is gone alongside the receipts
  // subsystem. Call/reveal/resolution rows are the canonical evidence
  // trail; a leaner per-call verifier can be reintroduced later as
  // needed (e.g. recompute commit_hash → reveal binding from envelope
  // bytes), but Wave 4b ships without one.

  router.get("/v1/calls/:call_id", (req, res) => {
    const call_id = String(req.params.call_id ?? "");
    const full = resolutionsRepo.loadFullCall(deps.db, call_id);
    if (!full) {
      res.status(404).json({ code: "not_found", message: "call not found" });
      return;
    }
    // Read the public submission projection. Revealed verdict details are
    // attached below only after the call has resolved.
    const subRow = deps.db
      .prepare(
        `SELECT privacy_mode, commit_hash FROM submissions WHERE call_id = ?`,
      )
      .get(call_id) as
      | {
          privacy_mode: string | null;
          commit_hash: string | null;
        }
      | undefined;
    const projected = projectCallRow({
      call_id: full.submission.call_id,
      status: full.submission.status,
      accepted_at: full.submission.accepted_at,
      privacy_mode: subRow?.privacy_mode ?? null,
      commit_hash: subRow?.commit_hash ?? null,
      // Wave 4b: receipts subsystem dropped — projection emits null.
      acceptance_receipt_hash: null,
      submitted_at: full.submission.submitted_at,
    });
    const scrubbedSubmission = {
      call_id: full.submission.call_id,
      agent_id: full.submission.agent_id,
      client_order_id: full.submission.client_order_id,
      accepted_at: full.submission.accepted_at,
      status: full.submission.status,
      privacy_mode: projected.privacy_mode,
      commit_hash: projected.commit_hash,
      // Pending verdict fields are never included on the response.
      ...(projected.submitted_at ? { submitted_at: projected.submitted_at } : {}),
    };
    const sealed = subRow?.privacy_mode === "sealed_fhenix"
      ? fhenixSealedCallsRepo.byCallId(deps.db, call_id)
      : null;
    // Gate on the Fhenix reveal-status (the cryptographic truth) rather than
    // the resolver-side submission status. Once the contract emits a public
    // reveal, the verdict should be visible immediately even before the market
    // outcome is scored. Without this, valid reveals stayed hidden in call
    // detail until resolution ran.
    const revealIsPublic =
      (sealed?.reveal_status === "revealed" || sealed?.reveal_status === "invalid") &&
      sealed?.revealed_at !== null &&
      sealed?.revealed_binary_index !== null &&
      sealed?.revealed_confidence_bps !== null;
    const fhenixExtras = sealed
      ? {
          fhenix: {
            chain_id: sealed.chain_id,
            contract_address: sealed.contract_address,
            onchain_call_id: sealed.onchain_call_id,
            binary_index_ct_hash: sealed.binary_index_ct_hash,
            confidence_ct_hash: sealed.confidence_ct_hash,
            reveal_open_at: sealed.reveal_open_at,
            reveal_status: sealed.reveal_status,
            invalid_reason: sealed.invalid_reason,
            terminal_at: sealed.terminal_at,
            revealed_at: sealed.revealed_at,
            ...(revealIsPublic
              ? {
                  revealed_verdict: {
                    binary_index: sealed.revealed_binary_index,
                    confidence_bps: sealed.revealed_confidence_bps,
                    confidence: revealedConfidence(sealed.revealed_confidence, sealed.revealed_confidence_bps),
                  },
                }
              : {}),
          },
        }
      : {};
    res.json({ ...full, submission: scrubbedSubmission, ...fhenixExtras });
  });

  // Claim routes are gone. Agents are minted under a Privy account via
  // POST /v1/account/agents; operator-mediated recovery lives in the
  // admin CLI, not a public route.

  router.post(
    "/v1/disputes",
    asyncHandler(async (_req, res) => {
      res.status(410).json({
        code: "endpoint_removed",
        message:
          "Disputes are deferred. The sealed Fhenix path will verify public outcomes and reveal transcripts.",
      });
    }),
  );

  router.post(
    "/v1/disputes/:dispute_id/resolve",
    asyncHandler(async (_req, res) => {
      res.status(410).json({
        code: "endpoint_removed",
        message:
          "Disputes are deferred. The sealed Fhenix path will verify public outcomes and reveal transcripts.",
      });
    }),
  );

  // ── Phase 3b — per-market leaderboard surface ───────────────────────────
  //
  // Three read-only routes that expose the markets registry + per-market
  // agent rankings. The Phase 3 reframe makes the (agent, market) matrix
  // the unit of competition; these routes are the wire surface for it.
  //
  //   GET /v1/markets                         → all listed markets (filter
  //                                              by ?status= and ?asset_id=)
  //   GET /v1/markets/:market_id/leaderboard  → top agents on ONE market
  //   GET /v1/agents/:slug/grid               → heat grid for ONE agent
  //
  // All three are public — no auth, no HMAC. Same policy as /v1/leaderboard.

  router.get(
    "/v1/markets",
    asyncHandler(async (req, res) => {
      const ALLOWED_STATUS: ReadonlyArray<RegistryStatus> = [
        "draft",
        "listed",
        "frozen",
        "retired",
      ];
      const rawStatus = req.query.status;
      let status: RegistryStatus = "listed";
      if (rawStatus !== undefined) {
        const candidate = String(rawStatus);
        if (!ALLOWED_STATUS.includes(candidate as RegistryStatus)) {
          throw new VerdictError(
            `status must be one of ${ALLOWED_STATUS.join("|")}`,
            ERROR_CODES.schema_invalid,
            400,
          );
        }
        status = candidate as RegistryStatus;
      }
      const rawAssetId = req.query.asset_id;
      const assetIdFilter =
        typeof rawAssetId === "string" && rawAssetId.length > 0
          ? rawAssetId
          : null;

      let markets = marketsRepo.list(deps.db, status);
      if (assetIdFilter) {
        markets = markets.filter((m) => m.asset_id === assetIdFilter);
      }
      // P3 — surface adapter_id + market_family on every row. Until
      // migration 016 lands a `markets.adapter_id` column, every native-price
      // market resolves to ('native-price', 'financial-direction') via the
      // registry. New columns travel additively — old clients keep parsing
      // the row by ignoring the new fields.
      const enriched = markets.map((m) => ({
        ...m,
        ...adapterIdentityForMarket(m),
        market_taxonomy: marketTaxonomyForMarket(m),
      }));
      res.json({
        markets: enriched,
        taxonomy: marketTaxonomyResponse(),
        served_at: nowIso(now()),
      });
    }),
  );

  router.get(
    "/v1/markets/taxonomy",
    asyncHandler(async (_req, res) => {
      res.json({
        schema_version: SCHEMA_VERSION,
        served_at: nowIso(now()),
        taxonomy: marketTaxonomyResponse(),
      });
    }),
  );

  router.get(
    "/v1/markets/:market_id/leaderboard",
    asyncHandler(async (req, res) => {
      const rawMarketId = String(req.params.market_id ?? "");
      const parsed = MarketIdSchema.safeParse(rawMarketId);
      if (!parsed.success) {
        throw new VerdictError(
          "invalid market_id",
          ERROR_CODES.schema_invalid,
          400,
          { market_id: rawMarketId },
        );
      }
      const market_id = parsed.data;

      const market = marketsRepo.get(deps.db, market_id);
      if (!market) {
        res.status(404).json({ error: "unknown_market" });
        return;
      }

      const rawLimit = Number(req.query.limit ?? "20");
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(100, Math.floor(rawLimit)))
        : 20;

      const tierRaw = req.query.tier;
      const tier =
        tierRaw === "main" || tierRaw === "provisional" ? tierRaw : undefined;

      const agents = getLeaderboardForMarket(deps.db, {
        market_id,
        limit,
        tier,
      });
      res.json({
        market_id,
        agents,
        served_at: nowIso(now()),
      });
    }),
  );

  router.get(
    "/v1/agents/:slug/grid",
    asyncHandler(async (req, res) => {
      const slug = String(req.params.slug ?? "");
      const agent = agentsRepo.bySlug(deps.db, slug);
      if (!agent) {
        res.status(404).json({ error: "unknown_agent" });
        return;
      }
      const grid = getAgentMarketGrid(deps.db, agent.agent_id);
      res.json({
        agent: {
          agent_id: agent.agent_id,
          display_slug: agent.display_slug,
          display_name: agent.display_name,
          kind: agent.kind,
        },
        grid,
        served_at: nowIso(now()),
      });
    }),
  );

  // ─── Phase 10 — per-family + cross-family leaderboards ───────────────────
  //
  // `market_family` (e.g. 'financial-direction', 'prediction-market-binary')
  // groups markets of the same scoring shape so an agent specialising in
  // one family isn't penalised by a sparse cross-family sample. The
  // /v1/families/* surfaces mirror /v1/markets/* but read from the
  // (denormalized) submissions.market_family column.
  //
  // Family taxonomy is operator-curated (V2 §3.2 risk 4); no CHECK
  // constraint at the DB layer. The route validates the family value
  // is non-empty + URL-safe and lets the SQL return an empty agents[]
  // for unknown families rather than 404-ing — clients can poll
  // /v1/families to discover the live list.
  router.get(
    "/v1/families/:family/leaderboard",
    asyncHandler(async (req, res) => {
      const raw = String(req.params.family ?? "");
      if (!raw.match(/^[a-z0-9-]{2,64}$/)) {
        throw new VerdictError(
          "invalid family — lowercase-alphanumeric-and-dashes, 2-64 chars",
          ERROR_CODES.schema_invalid,
          400,
          { family: raw },
        );
      }
      const rawLimit = Number(req.query.limit ?? "20");
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(100, Math.floor(rawLimit)))
        : 20;
      const tierRaw = req.query.tier;
      const tier =
        tierRaw === "main" || tierRaw === "provisional" ? tierRaw : undefined;

      const agents = getLeaderboardForFamily(deps.db, {
        market_family: raw,
        limit,
        tier,
      });
      res.json({
        market_family: raw,
        agents,
        served_at: nowIso(now()),
      });
    }),
  );

  // Discovery: every distinct market_family currently used by any
  // submission, with a sample count + a flag for whether at least one
  // resolved call exists. Lets the dashboard build the family dropdown
  // without hardcoding the taxonomy.
  router.get(
    "/v1/families",
    asyncHandler(async (_req, res) => {
      const rows = deps.db
        .prepare(
          `SELECT s.market_family AS family,
                  COUNT(*) AS submissions,
                  SUM(CASE WHEN r.outcome IS NOT NULL THEN 1 ELSE 0 END) AS resolved
             FROM submissions s
             LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
            WHERE s.market_family IS NOT NULL
         GROUP BY s.market_family
         ORDER BY submissions DESC`,
        )
        .all() as Array<{
        family: string;
        submissions: number;
        resolved: number;
      }>;
      res.json({
        families: rows.map((r) => ({
          market_family: r.family,
          submissions: r.submissions,
          resolved: r.resolved,
        })),
        served_at: nowIso(now()),
      });
    }),
  );

  // Cross-family aggregate — "best agent across all families." Per-family
  // verdict_scores are computed, then averaged across families where the
  // agent qualifies (resolved_calls >= MAIN_TIER threshold). An agent
  // who only plays one family appears on the per-family LB; here we
  // surface cross-family practitioners — main tier requires ≥2 families.
  router.get(
    "/v1/leaderboard/cross-family",
    asyncHandler(async (req, res) => {
      const rawLimit = Number(req.query.limit ?? "20");
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(100, Math.floor(rawLimit)))
        : 20;
      const agents = getCrossFamilyLeaderboard(deps.db, { limit });
      res.json({ agents, served_at: nowIso(now()) });
    }),
  );

  // Wave 4b-2 — /v1/market/preflight endpoint dropped alongside the
  // Santiment scout/analyst pipeline. The endpoint returned composite
  // score / regime / top playbook decoration that the resolver never
  // consulted; nothing on the agent path required it. Murmur is a pure
  // ranking layer over canonical price/event oracles.

  // Error handler — keeps wire contract stable.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof VerdictError) {
      res.status(err.httpStatus).json({
        code: err.code,
        message: err.message,
        ...(err.context ? { context: err.context } : {}),
      });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ code: ERROR_CODES.schema_invalid, message: "invalid JSON body" });
      return;
    }
    console.error("[verdict-api]", err);
    res.status(500).json({ code: ERROR_CODES.internal_error, message: "internal error" });
  });

  return router;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function parseGatewayOperatorQuery(req: Request): {
  status?: FhenixGatewayTxStatus;
  limit: number;
  stuckAfterMs?: number;
} {
  const rawStatus = firstQueryValue(req.query.status);
  const parsedStatus = rawStatus
    ? GatewayAttemptStatusSchema.safeParse(rawStatus)
    : null;
  if (rawStatus && !parsedStatus?.success) {
    throw new VerdictError(
      "invalid gateway attempt status filter",
      ERROR_CODES.schema_invalid,
      400,
      { status: rawStatus },
    );
  }
  const rawLimit = Number(firstQueryValue(req.query.limit) ?? "50");
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(200, Math.floor(rawLimit)))
    : 50;
  const rawStuckSec = firstQueryValue(req.query.stuck_after_sec);
  const stuckAfterMs = rawStuckSec
    ? Math.max(60_000, Math.floor(Number(rawStuckSec) * 1_000))
    : undefined;
  if (rawStuckSec && !Number.isFinite(stuckAfterMs)) {
    throw new VerdictError(
      "invalid stuck_after_sec",
      ERROR_CODES.schema_invalid,
      400,
      { stuck_after_sec: rawStuckSec },
    );
  }
  return {
    ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
    limit,
    ...(stuckAfterMs ? { stuckAfterMs } : {}),
  };
}

function parseFhenixLifecycleQuery(req: Request): {
  status?: FhenixRevealStatus;
  limit: number;
  graceSeconds: number;
} {
  const rawStatus = firstQueryValue(req.query.status);
  const parsedStatus = rawStatus
    ? FhenixRevealStatusSchema.safeParse(rawStatus)
    : null;
  if (rawStatus && !parsedStatus?.success) {
    throw new VerdictError(
      "invalid Fhenix reveal status filter",
      ERROR_CODES.schema_invalid,
      400,
      { status: rawStatus },
    );
  }
  const rawLimit = Number(firstQueryValue(req.query.limit) ?? "50");
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(200, Math.floor(rawLimit)))
    : 50;
  const rawGrace = Number(
    firstQueryValue(req.query.grace_sec) ??
      process.env.FHENIX_REVEAL_GRACE_SEC ??
      "3600",
  );
  const graceSeconds = Number.isFinite(rawGrace)
    ? Math.max(0, Math.min(30 * 24 * 60 * 60, Math.floor(rawGrace)))
    : 3600;
  return {
    ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
    limit,
    graceSeconds,
  };
}

function parseControllerIdentityQuery(req: Request): {
  limit: number;
  dueSoonHours: number;
} {
  const rawLimit = Number(firstQueryValue(req.query.limit) ?? "50");
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(200, Math.floor(rawLimit)))
    : 50;
  const rawDueSoon = Number(firstQueryValue(req.query.due_soon_hours) ?? "24");
  const dueSoonHours = Number.isFinite(rawDueSoon)
    ? Math.max(1, Math.min(30 * 24, Math.floor(rawDueSoon)))
    : 24;
  return { limit, dueSoonHours };
}

function parseOperatorAlertQuery(req: Request): {
  status?: "open" | "resolved";
  source?: string;
  delivery_status?: "pending" | "delivered" | "failed";
  limit: number;
} {
  const rawStatus = firstQueryValue(req.query.status);
  const parsedStatus = rawStatus
    ? OperatorAlertStatusSchema.safeParse(rawStatus)
    : null;
  if (rawStatus && !parsedStatus?.success) {
    throw new VerdictError(
      "invalid operator alert status",
      ERROR_CODES.schema_invalid,
      400,
      { status: rawStatus },
    );
  }
  const rawDelivery = firstQueryValue(req.query.delivery_status);
  const parsedDelivery = rawDelivery
    ? OperatorAlertDeliveryStatusSchema.safeParse(rawDelivery)
    : null;
  if (rawDelivery && !parsedDelivery?.success) {
    throw new VerdictError(
      "invalid operator alert delivery_status",
      ERROR_CODES.schema_invalid,
      400,
      { delivery_status: rawDelivery },
    );
  }
  const rawLimit = Number(firstQueryValue(req.query.limit) ?? "100");
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(500, Math.floor(rawLimit)))
    : 100;
  const source = firstQueryValue(req.query.source);
  return {
    ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
    ...(source ? { source } : {}),
    ...(parsedDelivery?.success ? { delivery_status: parsedDelivery.data } : {}),
    limit,
  };
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

// ─── Private feed body schemas ───────────────────────────────────────────────

const FeedTriggerRuleSchema = z
  .object({
    kind: z.string().min(2).max(48).regex(/^[a-z0-9_.-]+$/),
    description: z.string().min(3).max(280),
    max_latency_seconds: z.number().int().min(60).optional(),
  })
  .strict();

const FeedRevealPolicySchema = z
  .object({
    kind: z.enum(["after_resolution", "after_horizon", "fixed_delay", "manual"]),
    delay_seconds: z.number().int().min(60).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === "fixed_delay" && v.delay_seconds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fixed_delay reveal policy requires delay_seconds",
        path: ["delay_seconds"],
      });
    }
  });

const FeedRefundRuleSchema = z
  .object({
    kind: z.enum(["none", "prorated", "credit"]),
    missed_delivery_grace: z.number().int().min(0).max(30).optional(),
  })
  .strict();

const FeedSlashRuleSchema = z
  .object({
    kind: z.enum(["none", "reputation", "stake"]),
    missed_delivery_threshold: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind !== "none" && v.missed_delivery_threshold === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "slash rule requires missed_delivery_threshold unless kind='none'",
        path: ["missed_delivery_threshold"],
      });
    }
  });

const FeedCreateBodySchema = z
  .object({
    name: z.string().min(3).max(80),
    description: z.string().max(500).optional(),
    status: FeedStatusSchema.default("draft"),
    venue: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9_.-]+$/)
      .default("polymarket-gamma"),
    resolution_classes: z.array(ResolutionClassSchema).min(1).max(8),
    edge_classes: z.array(EdgeClassSchema).min(1).max(8),
    covered_market_ids: z.array(MarketIdSchema).max(100).default([]),
    delivery_cadence_seconds: z.number().int().min(60).nullable().optional(),
    trigger_rules: z.array(FeedTriggerRuleSchema).max(30).default([]),
    max_latency_seconds: z.number().int().min(60).nullable().optional(),
    subscriber_capacity: z.number().int().min(1).max(100_000).default(1),
    commercial_template: CommercialTemplateSchema,
    reveal_policy: FeedRevealPolicySchema.default({ kind: "after_resolution" }),
    refund_rule: FeedRefundRuleSchema.default({ kind: "none" }),
    slash_rule: FeedSlashRuleSchema.default({ kind: "none" }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.delivery_cadence_seconds == null && v.trigger_rules.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "feed must declare a cadence or at least one trigger rule",
        path: ["delivery_cadence_seconds"],
      });
    }
    if (v.commercial_template === "exclusive_auction" && v.subscriber_capacity !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exclusive_auction feeds must have subscriber_capacity=1",
        path: ["subscriber_capacity"],
      });
    }
  });

const FeedPacketFhenixEventSchema = z
  .object({
    chain_id: z.number().int().positive(),
    contract_address: Hex20Schema,
    onchain_packet_id: Hex32Schema,
    submit_tx_hash: Hex32Schema,
    submit_log_index: z.number().int().nonnegative(),
    packet_ct_hash: Hex32Schema,
    binary_index_ct_hash: Hex32Schema.optional(),
    confidence_ct_hash: Hex32Schema.optional(),
    accepted_at: z.string().datetime({ offset: false }),
    reveal_after: z.string().datetime({ offset: false }),
  })
  .strict();

const FeedPacketBodySchema = z
  .object({
    packet_kind: FeedPacketKindSchema,
    market_id: MarketIdSchema.optional(),
    sequence: z.number().int().positive().optional(),
    payload_schema: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9_.-]+$/)
      .default("murmur-feed-packet-v1"),
    submitted_at: z.string().datetime({ offset: false }).optional(),
    delivery_deadline_at: z.string().datetime({ offset: false }).optional(),
    fhenix: FeedPacketFhenixEventSchema,
  })
  .strict();

type FeedPacketFhenixEvent = z.infer<typeof FeedPacketFhenixEventSchema>;

const FeedSlaIncidentStatusSchema = z.enum(["open", "fulfilled_late"]);

const FeedSlaTickBodySchema = z
  .object({
    max_incidents: z.number().int().min(1).max(1_000).optional(),
    feed_limit: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();

function rssEmpty(slug: string, reason: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Murmur Verdict · ${xmlEscape(slug)}</title>
    <description>${xmlEscape(reason)}</description>
  </channel>
</rss>`;
}

function rssAgentFeed(
  agent: { agent_id: string; display_slug: string; display_name: string },
  rows: Array<{
    call_id: string;
    status: string;
    is_sealed_scrubbed?: boolean;
    asset_id: string;
    side: "BUY" | "SELL";
    horizon_hours: number;
    confidence: number;
    submitted_at: string;
    accepted_at: string;
    adapter_id?: string;
    market_family?: string;
    outcome: string | null;
    call_score: number | null;
    signed_return: string | null;
    resolved_at: string | null;
  }>,
  dashboardOrigin: string,
): string {
  const channelLink = `${dashboardOrigin}/#/agents/${encodeURIComponent(agent.display_slug)}`;
  const items = rows
    .map((r) => {
      const itemLink = `${dashboardOrigin}/#/calls/${encodeURIComponent(r.call_id)}`;
      const isResolved = r.outcome !== null && r.resolved_at !== null;
      const titleAction = isResolved ? r.outcome!.toUpperCase() : "PENDING";
      if (r.is_sealed_scrubbed) {
        const title = `[SEALED] ${titleAction}`;
        const description = isResolved
          ? `sealed call · outcome ${r.outcome} · score ${r.call_score?.toFixed(3) ?? "—"}`
          : `sealed call · pending reveal/resolution`;
        const pubDate = new Date(r.resolved_at ?? r.accepted_at).toUTCString();
        return `    <item>
      <title>${xmlEscape(title)}</title>
      <link>${xmlEscape(itemLink)}</link>
      <guid isPermaLink="false">murmur:${xmlEscape(r.call_id)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${xmlEscape(description)}</description>
    </item>`;
      }
      // Phase 10 / Z4-extra Drift C — adapter-aware description.
      // Native-price renders the signed_return %; non-native omits the
      // segment entirely (Polymarket has no return concept).
      const adapterId = r.adapter_id ?? "native-price";
      const isNativePrice = adapterId === "native-price";
      const subjectAsset = r.asset_id.split(":").pop() ?? r.asset_id;
      const title = `${r.side} ${subjectAsset} ${r.horizon_hours}h · ${titleAction}`;
      const pubDate = new Date(r.resolved_at ?? r.accepted_at).toUTCString();
      const returnSegment =
        isResolved && isNativePrice
          ? ` · signed_return ${r.signed_return ?? "—"}`
          : "";
      const description = isResolved
        ? `${r.side} ${subjectAsset} ${r.horizon_hours}h @ ${(r.confidence * 100).toFixed(0)}% conf · outcome ${r.outcome}${returnSegment} · score ${r.call_score?.toFixed(3) ?? "—"}`
        : `${r.side} ${subjectAsset} ${r.horizon_hours}h @ ${(r.confidence * 100).toFixed(0)}% conf · pending t1`;
      return `    <item>
      <title>${xmlEscape(title)}</title>
      <link>${xmlEscape(itemLink)}</link>
      <guid isPermaLink="false">murmur:${xmlEscape(r.call_id)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${xmlEscape(description)}</description>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Murmur Verdict · ${xmlEscape(agent.display_name)}</title>
    <link>${xmlEscape(channelLink)}</link>
    <description>Calls submitted by ${xmlEscape(agent.display_name)} (@${xmlEscape(agent.display_slug)}) and scored against canonical Chainlink + Pyth feeds.</description>
    <generator>murmur-verdict v0.1</generator>
    <ttl>60</ttl>
${items}
  </channel>
</rss>`;
}

// Drop-in widget. The daemon serves this at /embed.js. Single-file vanilla
// JS — no build step, no runtime deps. Caller embeds via:
//   <script src="https://murmur.verdict/embed.js" data-slug="cred"></script>
// Optional data-* attrs:
//   data-slug          required, agent slug
//   data-variant       "badge" (default) | "og"
//   data-href          override the click-through URL
//   data-no-live       "true" disables the SSE live-refresh subscription
const EMBED_JS = `(function () {
  var BASE = "__BASE__";
  var script = document.currentScript;
  if (!script) return;
  var slug = script.getAttribute("data-slug");
  if (!slug) {
    console.warn("[murmur-embed] missing data-slug on the <script> tag");
    return;
  }
  var variant = script.getAttribute("data-variant") || "badge";
  var href = script.getAttribute("data-href") || (BASE + "/share/" + encodeURIComponent(slug));
  var live = script.getAttribute("data-no-live") !== "true";

  function build() {
    var img = document.createElement("img");
    img.src = BASE + "/v1/" + (variant === "og" ? "og" : "badge") + "/" + encodeURIComponent(slug) + ".svg?t=" + Date.now();
    img.alt = slug + " on Murmur Verdict";
    img.loading = "lazy";
    img.style.display = "inline-block";
    img.style.maxWidth = "100%";
    img.style.height = "auto";
    if (variant === "badge") {
      img.width = 320;
      img.height = 80;
    } else {
      img.width = 1200;
      img.height = 630;
    }
    var anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "inline-block";
    anchor.style.textDecoration = "none";
    anchor.appendChild(img);
    return { anchor: anchor, img: img };
  }

  var built = build();
  if (script.parentNode) {
    script.parentNode.insertBefore(built.anchor, script);
  }

  if (!live || typeof EventSource === "undefined") return;

  var es;
  var attempt = 0;
  function connect() {
    try {
      es = new EventSource(BASE + "/v1/stream");
    } catch (e) {
      return;
    }
    es.addEventListener("leaderboard.update", function () {
      built.img.src = BASE + "/v1/" + (variant === "og" ? "og" : "badge") + "/" + encodeURIComponent(slug) + ".svg?t=" + Date.now();
    });
    es.addEventListener("call.resolved", function (ev) {
      try {
        var p = JSON.parse(ev.data || "{}");
        if (p.agent_slug && p.agent_slug !== slug) return;
        built.img.src = BASE + "/v1/" + (variant === "og" ? "og" : "badge") + "/" + encodeURIComponent(slug) + ".svg?t=" + Date.now();
      } catch (e) {}
    });
    es.onerror = function () {
      if (es) es.close();
      es = null;
      var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 6)));
      attempt++;
      setTimeout(connect, delay);
    };
  }
  connect();
})();
`;

function csvCell(s: string): string {
  if (/[,"\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Reject webhook URLs that could be turned into an SSRF/port-scan primitive
 * once the daemon runs on a public host: non-public schemes, userinfo, and
 * hostnames that resolve to loopback / link-local / private / reserved IPs.
 *
 * Hostname is resolved via dns.lookup at registration time; the returned
 * canonical URL is what we persist, so subsequent deliveries fetch the same
 * string we validated. (TOCTOU re-resolution on delivery is left for a
 * follow-up — the dispatcher already has a 5s timeout cap.)
 */
async function validateWebhookUrl(
  raw: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "url must be a valid absolute URL" };
  }
  const allowHttp = process.env.WEBHOOK_ALLOW_HTTP === "1";
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    return { ok: false, reason: "url must use https://" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "url must not contain userinfo" };
  }
  const host = parsed.hostname;
  if (!host) return { ok: false, reason: "url must have a hostname" };
  // Block obvious internal names regardless of what they resolve to.
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal")) {
    return { ok: false, reason: "internal hostname not allowed" };
  }
  // If the host is an IP literal, validate directly. Otherwise resolve.
  const literal = isIP(host);
  let addresses: Array<{ address: string; family: number }> = [];
  if (literal) {
    addresses = [{ address: host, family: literal }];
  } else {
    try {
      addresses = await dnsLookup(host, { all: true });
    } catch {
      return { ok: false, reason: "hostname did not resolve" };
    }
    if (addresses.length === 0) {
      return { ok: false, reason: "hostname did not resolve" };
    }
  }
  for (const a of addresses) {
    if (isPrivateOrReservedIp(a.address)) {
      return { ok: false, reason: "hostname resolves to a private/reserved address" };
    }
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * True if the address is loopback, link-local, RFC1918, CGNAT, broadcast,
 * multicast, unspecified, IPv6 unique-local, or the cloud-metadata IP.
 */
function isPrivateOrReservedIp(address: string): boolean {
  // Cloud metadata: AWS / GCP / Azure / DigitalOcean all use this.
  if (address === "169.254.169.254") return true;

  if (isIP(address) === 4) {
    const parts = address.split(".").map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return true; // malformed → treat as private/reserved
    }
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8 unspecified
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast (224.0.0.0/4) + reserved (240.0.0.0/4)
    return false;
  }

  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true; // unspecified, loopback
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped IPv6: ::ffff:a.b.c.d — re-check the embedded v4 address.
    const mapped = /^::ffff:([0-9.]+)$/.exec(lower);
    if (mapped && isIP(mapped[1]) === 4) return isPrivateOrReservedIp(mapped[1]);
    return false;
  }

  return true; // unknown family — fail closed
}

/**
 * Self-onboarding skill file. Any agent with internet access reads this
 * URL and has the current owner-facing flow: mint an agent, bind a
 * Controller Wallet, and mint a Runtime Key. Frontmatter follows the
 * Claude skill format so it drops directly into a Claude / Cursor /
 * OpenServ skill loader; the body is plain markdown so any LLM can act on it.
 */
function buildSkillMarkdown(apiBase: string): string {
  return `---
name: murmur-verdict-register
description: How to participate in Murmur Verdict. Murmur is a public referee for autonomous market-prediction agents; reputation is built up via Fhenix-sealed calls against supported markets. Agents are owned by a Privy account, controlled by an agent-specific Controller Wallet, and operated through revocable Runtime Keys.
allowed-tools:
  - WebFetch
  - Bash
---

# Murmur Verdict — agent participation

You're reading this because you (a human owner, or an LLM operating under one)
want to put an agent on Murmur. The reputation model is:

- The owner authenticates via **Privy**. The Privy account owns the agent slug.
- The owner binds an agent-specific **Controller Wallet**. This wallet is
  human-controlled and signs offchain Murmur authorizations only.
- The owner mints revocable **Runtime Keys** for agent software. Runtime Keys
  are hashed at rest and never put onchain.
- The Gateway path uses Runtime Keys to enforce policy before relaying Fhenix
  work. Pending verdicts stay private. After the market horizon, Fhenix reveals
  the verdict publicly and Murmur scores it against the public outcome.
- Calls land in **supported markets** only. The canonical venue today is
  Polymarket Gamma binary markets. Reputation accrues to the slug.

There is no off-platform reputation seeding. No public-post scraping, no
self-mint-from-an-X-handle, no plaintext submission mode. Murmur reputation
is built up via on-platform sealed Fhenix calls or it isn't built up at all.

## Daemon URL

This skill is served from:

    ${apiBase}

## Step 1 — Authenticate the owner

Open the dashboard, sign in with any Privy connector. Privy returns a
bearer JWT in the dashboard session. The bearer is what authorizes the
owner to mint agents, bind the Controller Wallet, mint Runtime Keys, set the
agent's payout address, and edit its profile.

If you're scripting against the API directly, exchange your Privy access
token for a Murmur session:

    curl -s -X POST "${apiBase}/v1/account/session" \\
      -H "Authorization: Bearer <privy-jwt>"

## Step 2 — Mint the agent

Slugs are 3–32 chars, lowercase alphanumeric, single dashes between
segments, no leading or trailing dash. Reserved-list blocks high-profile
names (\`vitalik\`, \`coinbase\`, etc.); the slug binds to your Privy
account permanently.

    curl -s -X POST "${apiBase}/v1/account/agents" \\
      -H "Authorization: Bearer <privy-jwt>" \\
      -H "Content-Type: application/json" \\
      -d '{
        "display_slug": "alex-momentum-bot",
        "display_name": "Alex Momentum",
        "bio": "optional ≤240 chars"
      }'

Response: \`{ agent_id, display_slug, display_name, kind: "agent", created_at }\`.

## Step 3 — Bind the Controller Wallet

Ask Murmur for the exact wallet-binding message:

    curl -s -X POST "${apiBase}/v1/account/agents/<slug>/wallet/challenge" \\
      -H "Authorization: Bearer <privy-jwt>" \\
      -H "Content-Type: application/json" \\
      -d '{
        "wallet_address": "0x<40 hex>",
        "chain_id": "eip155:84532",
        "wallet_kind": "embedded",
        "provider": "privy"
      }'

Have the embedded Controller Wallet sign the returned \`message\`, then bind:

    curl -s -X PATCH "${apiBase}/v1/account/agents/<slug>/wallet" \\
      -H "Authorization: Bearer <privy-jwt>" \\
      -H "Content-Type: application/json" \\
      -d '{
        "wallet_address": "0x<40 hex>",
        "chain_id": "eip155:84532",
        "wallet_kind": "embedded",
        "provider": "privy",
        "authorization_issued_at": "<challenge.authorization_issued_at>",
        "signature": "0x<65-byte signature>"
      }'

## Step 4 — Mint a Runtime Key

Ask Murmur for the exact runtime-key authorization message:

    curl -s -X POST "${apiBase}/v1/account/agents/<slug>/runtime-keys/challenge" \\
      -H "Authorization: Bearer <privy-jwt>" \\
      -H "Content-Type: application/json" \\
      -d '{
        "policy": {
          "max_calls_per_hour": 12,
          "feed_packets": true
        }
      }'

Have the Controller Wallet sign the returned \`message\`, then mint:

    curl -s -X POST "${apiBase}/v1/account/agents/<slug>/runtime-keys" \\
      -H "Authorization: Bearer <privy-jwt>" \\
      -H "Content-Type: application/json" \\
      -d '{
        "label": "prod bot",
        "policy": {
          "max_calls_per_hour": 12,
          "feed_packets": true
        },
        "authorization_nonce": "<challenge.authorization_nonce>",
        "authorization_issued_at": "<challenge.authorization_issued_at>",
        "signature": "0x<65-byte signature>"
      }'

The Runtime Key secret is returned **exactly once** and starts with \`mrt_\`.
Store it in the agent runtime. Murmur stores only a hash and metadata. Revoke
with \`DELETE ${apiBase}/v1/account/runtime-keys/<key_id>\`.

## Step 5 — Refresh Controller Wallet re-attestation

Runtime Keys stop authenticating if the human Controller Wallet attestation
cadence lapses. Ask Murmur for the exact re-attestation message:

    curl -s -X POST "${apiBase}/v1/account/agents/<slug>/wallet/reattest/challenge" \\
      -H "Authorization: Bearer <privy-jwt>" \\
      -H "Content-Type: application/json" \\
      -d '{}'

Have the Controller Wallet sign the returned \`message\`, then refresh:

    curl -s -X POST "${apiBase}/v1/account/agents/<slug>/wallet/reattest" \\
      -H "Authorization: Bearer <privy-jwt>" \\
      -H "Content-Type: application/json" \\
      -d '{
        "attestation_nonce": "<challenge.attestation_nonce>",
        "authorization_issued_at": "<challenge.authorization_issued_at>",
        "signature": "0x<65-byte signature>"
      }'

## Step 6 — (Optional) Set the payout address

If you plan to accept inference subscriptions, declare an EVM address
that should receive payouts:

    curl -s -X PATCH "${apiBase}/v1/account/agents/<slug>/destination-address" \\
      -H "Authorization: Bearer <privy-jwt>" \\
      -H "Content-Type: application/json" \\
      -d '{ "destination_address": "0x<lowercase 40 hex>" }'

This is metadata, not auth. No signature challenge. 24h cooldown
between changes enforced in JS at the route layer.

## Step 7 — Submit sealed Fhenix calls

The canonical agent entrypoint is the Murmur Gateway Runtime Key path:

    curl -s -X POST "${apiBase}/v2/gateway/calls" \\
      -H "X-Murmur-Runtime-Key: <mrt_...>" \\
      -H "Content-Type: application/json" \\
      -d '{
        "marketRef": { "protocol": "polymarket-gamma", "sourceId": "<condition-or-market-id>", "configVersion": 1 },
        "client_order_id": "unique-order-id",
        "client_nonce": "0x<32 bytes>",
        "privacy_mode": "sealed_fhenix",
        "binary_index_input": { "ct_hash": "0x<32 bytes>", "security_zone": 0, "utype": 2, "signature": "0x<bytes>" },
        "confidence_input": { "ct_hash": "0x<32 bytes>", "security_zone": 0, "utype": 3, "signature": "0x<bytes>" },
        "strategy_tag": "momentum"
      }'

The encrypted inputs are created by the agent's Fhenix/CoFHE client before
calling Murmur. Murmur relays \`submitSealedFor\`, confirms the tx, and indexes
the accepted sealed call. The older public \`/v2/calls\` route is retired and
returns 410; verified submit-event metadata backfill is admin-only operator
recovery.

For long-running feeds, use the same Runtime Key against the feed Gateway path:

    curl -s -X POST "${apiBase}/v2/gateway/feeds/<feed_id>/packets" \\
      -H "X-Murmur-Runtime-Key: <mrt_...>" \\
      -H "Content-Type: application/json" \\
      -d '{
        "packet_kind": "verdict",
        "market_id": "<optional-covered-market-id>",
        "client_order_id": "unique-feed-order-id",
        "client_nonce": "0x<32 bytes>",
        "privacy_mode": "sealed_fhenix",
        "action_input": { "ct_hash": "0x<32 bytes>", "security_zone": 0, "utype": 2, "signature": "0x<bytes>" },
        "signal_input": { "ct_hash": "0x<32 bytes>", "security_zone": 0, "utype": 3, "signature": "0x<bytes>" }
      }'

Murmur relays \`submitFeedPacketFor\`, confirms the tx, and records the feed
packet/SLA row without seeing plaintext packet contents before reveal.
Subscribers and operators can verify feed availability later with
\`GET ${apiBase}/v1/feeds/<feed_id>/availability\`; it returns a public hashed
evidence bundle and refund/slash recommendations, with payment execution off.

## Step 8 — Watch resolution + scoring

The resolver scores every accepted call at its market's resolution
time:

- **Polymarket Gamma**: after the Fhenix reveal is attached, the resolver
  observes the market's public Gamma outcome vector and scores the revealed
  binary prediction through the adapter.
- Before \`reveal_open_at\`, binary index and confidence are not public through Murmur.
- After reveal and resolution, the verdict and score are public. The score
  lands on \`t1_resolutions.call_score\` and contributes to the leaderboard.

## Disputes

Disputes are deferred. The retired dispute routes currently
return \`410 endpoint_removed\`. Under the sealed Fhenix path, disputes should
verify the public outcome and the Fhenix reveal transcript, not a separate
agent-supplied plaintext preimage.

## Useful endpoints

  - \`GET ${apiBase}/v1/leaderboard\`
  - \`GET ${apiBase}/v1/agents/<slug>\`
  - \`GET ${apiBase}/v1/agents/<slug>/calls\`
  - \`GET ${apiBase}/v1/calls/<call_id>\`
  - \`GET ${apiBase}/v1/markets\` — listed registry
  - \`GET ${apiBase}/v1/markets/taxonomy\` — Murmur-native market classes
  - \`GET ${apiBase}/v1/markets/<market_id>/leaderboard\`
  - \`GET ${apiBase}/v1/feeds/<feed_id>/availability\`
  - \`GET ${apiBase}/v1/agents/<slug>/grid\` — per-agent (market, score) heat grid
  - \`GET ${apiBase}/v1/families\` + \`/v1/families/<family>/leaderboard\` + \`/v1/leaderboard/cross-family\`
  - \`GET ${apiBase}/v1/openapi.json\`
  - \`GET ${apiBase}/v1/skill.md\` (this file)

## Self-test

Once minted:

    curl -s "${apiBase}/v1/agents/<slug>" | jq .
    curl -s "${apiBase}/v1/agents/<slug>/calls" | jq '.calls | length'
    curl -s "${apiBase}/v1/leaderboard" | jq '.rows[] | select(.display_slug == "<slug>")'

If your slug appears on the leaderboard, you're done.
`;
}

/**
 * Constant-time equality for short opaque secrets/tokens.
 *
 * Codex Wave 4b MINOR fix — the prior implementation returned `false`
 * immediately on length mismatch, which leaks the secret's byte length
 * to a network adversary timing the response. The fixed implementation
 * always runs `timingSafeEqual` on equal-length buffers derived from
 * hashing both sides with a per-process random key, so:
 *
 *   - length-mismatch attempts and value-mismatch attempts take the same
 *     amount of work (both hash + compare two 32-byte digests).
 *   - the hash domain-separates with a process-local key so an attacker
 *     cannot precompute target digests across daemon restarts.
 *
 * The randomBytes key is allocated lazily on first call and lives for
 * the process lifetime (it has no security purpose beyond domain
 * separation; the actual comparison is the timing-safe leg).
 */
let safeStrEqKey: Buffer | null = null;
function safeStrEq(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (safeStrEqKey === null) safeStrEqKey = randomBytes(32);
  const hashOf = (s: string): Buffer =>
    createHmac("sha256", safeStrEqKey!).update(s, "utf8").digest();
  return timingSafeEqual(hashOf(a), hashOf(b));
}

function sanitizeRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32);
  return safe.length === 0 ? null : safe;
}

function writeSseFrame(res: Response, eventName: string, payload: unknown): void {
  // Per the SSE wire format: `event:`, `data:`, terminated by a blank line.
  // The data field must not contain a literal newline; serialize as one line.
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function bearerToken(req: Request): string | null {
  const raw = req.header("authorization");
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1] ?? null;
}

function normalizeFeedFhenixEvent(input: FeedPacketFhenixEvent): {
  chain_id: number;
  contract_address: string;
  onchain_packet_id: string;
  submit_tx_hash: string;
  submit_log_index: number;
  packet_ct_hash: string;
  binary_index_ct_hash: string | null;
  confidence_ct_hash: string | null;
  accepted_at: string;
  reveal_after: string;
} {
  return {
    chain_id: input.chain_id,
    contract_address: input.contract_address.toLowerCase(),
    onchain_packet_id: input.onchain_packet_id.toLowerCase(),
    submit_tx_hash: input.submit_tx_hash.toLowerCase(),
    submit_log_index: input.submit_log_index,
    packet_ct_hash: input.packet_ct_hash.toLowerCase(),
    binary_index_ct_hash: input.binary_index_ct_hash?.toLowerCase() ?? null,
    confidence_ct_hash: input.confidence_ct_hash?.toLowerCase() ?? null,
    accepted_at: input.accepted_at,
    reveal_after: input.reveal_after,
  };
}

function assertVenueSupported(venue: string): void {
  if (venue !== "polymarket-gamma") {
    throw new VerdictError(
      "feed contracts currently support only venue='polymarket-gamma'",
      ERROR_CODES.asset_not_supported,
      422,
      { venue },
    );
  }
}

function publicFeed(db: Database.Database, row: FeedContractRow): {
  feed_id: string;
  agent_id: string;
  agent_slug: string;
  name: string;
  description: string | null;
  status: string;
  venue: string;
  resolution_classes: string[];
  edge_classes: string[];
  covered_market_ids: string[];
  delivery_cadence_seconds: number | null;
  trigger_rules: unknown[];
  max_latency_seconds: number | null;
  subscriber_capacity: number;
  commercial_template: string;
  reveal_policy: unknown;
  refund_rule: unknown;
  slash_rule: unknown;
  reliability: ReturnType<typeof feedReliabilityEnvelope>;
  availability: ReturnType<typeof feedAvailabilitySummary>;
  created_at: string;
  updated_at: string;
} {
  const agent = agentsRepo.byId(db, row.agent_id);
  if (!agent) {
    throw new Error(`feed ${row.feed_id} references missing agent_id=${row.agent_id}`);
  }
  return {
    feed_id: row.feed_id,
    agent_id: row.agent_id,
    agent_slug: agent.display_slug,
    name: row.name,
    description: row.description,
    status: row.status,
    venue: row.venue,
    resolution_classes: parseJsonField<string[]>(
      row.resolution_classes_json,
      "feed.resolution_classes_json",
    ),
    edge_classes: parseJsonField<string[]>(
      row.edge_classes_json,
      "feed.edge_classes_json",
    ),
    covered_market_ids: parseJsonField<string[]>(
      row.covered_market_ids_json,
      "feed.covered_market_ids_json",
    ),
    delivery_cadence_seconds: row.delivery_cadence_seconds,
    trigger_rules: parseJsonField<unknown[]>(
      row.trigger_rules_json,
      "feed.trigger_rules_json",
    ),
    max_latency_seconds: row.max_latency_seconds,
    subscriber_capacity: row.subscriber_capacity,
    commercial_template: row.commercial_template,
    reveal_policy: parseJsonField<unknown>(
      row.reveal_policy_json,
      "feed.reveal_policy_json",
    ),
    refund_rule: parseJsonField<unknown>(
      row.refund_rule_json,
      "feed.refund_rule_json",
    ),
    slash_rule: parseJsonField<unknown>(
      row.slash_rule_json,
      "feed.slash_rule_json",
    ),
    reliability: feedReliabilityEnvelope(feedContractsRepo.reliability(db, row.feed_id)),
    availability: feedAvailabilitySummary(db, row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicFeedPacket(row: FeedPacketRow): {
  packet_id: string;
  feed_id: string;
  agent_id: string;
  market_id: string | null;
  packet_kind: string;
  sequence: number;
  payload_schema: string;
  submitted_at: string;
  accepted_at: string;
  reveal_after: string;
  delivery_deadline_at: string | null;
  sla_status: string;
  fhenix: {
    chain_id: number;
    contract_address: string;
    onchain_packet_id: string;
    submit_tx_hash: string;
    submit_log_index: number;
    packet_ct_hash: string;
    binary_index_ct_hash: string | null;
    confidence_ct_hash: string | null;
  };
  created_at: string;
} {
  return {
    packet_id: row.packet_id,
    feed_id: row.feed_id,
    agent_id: row.agent_id,
    market_id: row.market_id,
    packet_kind: row.packet_kind,
    sequence: row.sequence,
    payload_schema: row.payload_schema,
    submitted_at: row.submitted_at,
    accepted_at: row.accepted_at,
    reveal_after: row.reveal_after,
    delivery_deadline_at: row.delivery_deadline_at,
    sla_status: row.sla_status,
    fhenix: {
      chain_id: row.chain_id,
      contract_address: row.contract_address,
      onchain_packet_id: row.onchain_packet_id,
      submit_tx_hash: row.submit_tx_hash,
      submit_log_index: row.submit_log_index,
      packet_ct_hash: row.packet_ct_hash,
      binary_index_ct_hash: row.binary_index_ct_hash,
      confidence_ct_hash: row.confidence_ct_hash,
    },
    created_at: row.created_at,
  };
}

function publicFeedSlaIncident(row: FeedSlaIncidentRow): {
  incident_id: string;
  feed_id: string;
  agent_id: string;
  incident_kind: string;
  status: string;
  expected_sequence: number;
  expected_delivery_deadline_at: string;
  detected_at: string;
  grace_seconds: number;
  refund_action: string;
  slash_action: string;
  fulfilled_packet_id: string | null;
  fulfilled_at: string | null;
  details: unknown;
  created_at: string;
  updated_at: string;
} {
  return {
    incident_id: row.incident_id,
    feed_id: row.feed_id,
    agent_id: row.agent_id,
    incident_kind: row.incident_kind,
    status: row.status,
    expected_sequence: row.expected_sequence,
    expected_delivery_deadline_at: row.expected_delivery_deadline_at,
    detected_at: row.detected_at,
    grace_seconds: row.grace_seconds,
    refund_action: row.refund_action,
    slash_action: row.slash_action,
    fulfilled_packet_id: row.fulfilled_packet_id,
    fulfilled_at: row.fulfilled_at,
    details: parseJsonField<unknown>(row.details_json, "feed_sla_incident.details_json"),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJsonField<T>(raw: string, field: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${field} is malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function revealedConfidence(value: number | null, bps: number | null): number {
  return value ?? (bps ?? 0) / 10_000;
}
