import { Router, type Request, type Response, type NextFunction } from "express";
import express from "express";
import type Database from "better-sqlite3";
import { agentsRepo, resolutionsRepo, submissionsRepo } from "./db.js";
import { getLeaderboard, get24hVerifiedVolume } from "./leaderboard.js";
import {
  ERROR_CODES,
  REGISTERED_STRATEGY_TAGS,
  SCHEMA_VERSION,
  SCORING_VERSION,
  VerdictError,
  VerifiedIdentityKindSchema,
} from "./schema.js";
import {
  hashSharedSecret,
  submitCall,
  verifyHmac,
  type SubmissionContext,
} from "./submissions.js";
import { ClaimService } from "./claim.js";
import { DisputeService } from "./disputes.js";
import { DisputeGroundsSchema, OracleFeedSchema } from "./schema.js";
import { verifyAgentApiKey } from "./auth.js";
import { getTodayFeed } from "./feed.js";
import { verifyReceiptChain, VerifyError } from "./verify.js";

// ─── API surface ─────────────────────────────────────────────────────────────
//
// Public routes (no auth):
//   GET  /v1/health
//   GET  /v1/meta
//   GET  /v1/leaderboard?tier=&limit=
//   GET  /v1/agents/:slug
//   GET  /v1/agents/:slug/calls?limit=
//   GET  /v1/calls/:call_id
//   GET  /v1/market/preflight
//
// Authed routes (HMAC):
//   POST /v1/calls
//
// HMAC headers:
//   X-Murmur-Agent-Id, X-Murmur-Timestamp, X-Murmur-Signature
//   The shared secret is *not* stored — only sha256(secret) is in `agents.api_key_hash`.
//   The body MUST be JSON; the server preserves the raw body for HMAC verification.

export interface ApiDeps {
  db: Database.Database;
  ctx: SubmissionContext;
  /** Map an agent_id to the shared secret for HMAC verification. */
  resolveSharedSecret: (agent_id: string) => Promise<string | null>;
  /**
   * Probe used by /v1/readyz. Should attempt a real oracle read and return
   * `null` on success or a string describing the failure. When unset, /readyz
   * still checks DB writeability but reports oracle as `disabled`.
   */
  oracleProbe?: () => Promise<string | null>;
  /** Optional ClaimService; defaults to a NullVerifier-backed instance. */
  claim?: ClaimService;
  /** Optional DisputeService; defaults to a fresh instance bound to the same db. */
  disputes?: DisputeService;
  /**
   * Required to access /v1/disputes/:id/resolve. When unset, that route returns 503.
   * v0.1 is admin-correct; token-staked governance ships post-TGE.
   */
  adminToken?: string;
  now?: () => Date;
}

export function createVerdictRouter(deps: ApiDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const claim = deps.claim ?? new ClaimService({ db: deps.db });
  const disputes = deps.disputes ?? new DisputeService({ db: deps.db });
  const adminToken = deps.adminToken ?? process.env.VERDICT_ADMIN_TOKEN ?? "";
  const json = express.json({ limit: "32kb" });

  // Capture raw body for HMAC verification on the submission route only.
  router.post(
    "/v1/calls",
    express.text({ type: "application/json", limit: "32kb" }),
    asyncHandler(async (req, res) => {
      // Two auth modes — both produce a verified agent_id:
      //   1. X-Murmur-Api-Key (claimed agents; key issued by claim flow,
      //      verified against agents.api_key_hash). Preferred path in prod.
      //   2. X-Murmur-Agent-Id + X-Murmur-Timestamp + X-Murmur-Signature
      //      (legacy HMAC; required for benchmark agents whose secret lives
      //      in env vars instead of the DB).
      const apiKey = req.header("X-Murmur-Api-Key");
      const headerAgentId = req.header("X-Murmur-Agent-Id");
      let identity: { agent_id: string };
      if (apiKey && headerAgentId) {
        identity = verifyAgentApiKey(deps.db, headerAgentId, apiKey);
      } else {
        const headers = readHmacHeaders(req);
        const secret = await deps.resolveSharedSecret(headers.agent_id);
        if (!secret) {
          throw new VerdictError(
            "unknown agent_id",
            ERROR_CODES.unknown_agent,
            404,
          );
        }
        verifyHmac({
          rawBody: typeof req.body === "string" ? req.body : "",
          headers,
          shared_secret: secret,
          now,
        });
        identity = { agent_id: headers.agent_id };
      }
      const payload = JSON.parse((req.body ?? "{}") as string);
      const result = await submitCall({
        db: deps.db,
        ctx: deps.ctx,
        identity,
        payload,
      });
      const status = result.idempotent_hit ? 200 : 201;
      res.status(status).json(result);
    }),
  );

  router.get("/v1/health", (_req, res) => {
    res.json({
      ok: true,
      schema_version: SCHEMA_VERSION,
      scoring_version: SCORING_VERSION,
      now: nowIso(now()),
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

    const ready = dbOk && (oracleStatus === "ok" || oracleStatus === "disabled");
    res.status(ready ? 200 : 503).json({
      ready,
      now: nowIso(now()),
      db: { ok: dbOk, latency_ms: dbMs, error: dbError },
      oracle: { status: oracleStatus, latency_ms: oracleMs, error: oracleError },
    });
  }));

  router.get("/v1/meta", (_req, res) => {
    res.json({
      schema_version: SCHEMA_VERSION,
      scoring_version: SCORING_VERSION,
      strategy_tags: REGISTERED_STRATEGY_TAGS,
      assets: ["base:ETH:USD"],
      verified_volume_24h: get24hVerifiedVolume(deps.db),
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
    const allowed = ["verified", "benchmark", "shadow", "internal_test"] as const;
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
        verified_identities: r.verified_identities,
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

  router.get("/v1/agents/:slug/calls", (req, res) => {
    const slug = String(req.params.slug ?? "");
    const agent = agentsRepo.bySlug(deps.db, slug);
    if (!agent) {
      res.status(404).json({ code: ERROR_CODES.unknown_agent, message: "agent not found" });
      return;
    }
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? "50")));
    const rows = deps.db
      .prepare(
        `SELECT s.call_id, s.status, s.asset_id, s.side, s.horizon_hours,
                s.confidence, s.submitted_at, s.accepted_at,
                r.outcome, r.call_score, r.signed_return, r.resolved_at
         FROM submissions s
         LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
         WHERE s.agent_id = ?
         ORDER BY s.accepted_at DESC
         LIMIT ?`,
      )
      .all(agent.agent_id, limit);
    res.json({
      agent_id: agent.agent_id,
      display_slug: agent.display_slug,
      kind: agent.kind,
      calls: rows,
    });
  });

  router.get("/v1/feed/today", (_req, res) => {
    res.json(getTodayFeed(deps.db, now()));
  });

  router.get("/v1/calls/:call_id/verify", (req, res) => {
    const call_id = String(req.params.call_id ?? "");
    try {
      const result = verifyReceiptChain(deps.db, call_id, now);
      res.status(result.passes ? 200 : 422).json(result);
    } catch (err) {
      if (err instanceof VerifyError) {
        res.status(err.code === "not_found" ? 404 : 400).json({
          code: err.code,
          message: err.message,
        });
        return;
      }
      throw err;
    }
  });

  router.get("/v1/calls/:call_id", (req, res) => {
    const call_id = String(req.params.call_id ?? "");
    const full = resolutionsRepo.loadFullCall(deps.db, call_id);
    if (!full) {
      res.status(404).json({ code: "not_found", message: "call not found" });
      return;
    }
    res.json(full);
  });

  router.post(
    "/v1/agents/:slug/claim/init",
    json,
    asyncHandler(async (req, res) => {
      const slug = String(req.params.slug ?? "");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const target = body.target_identity as
        | { kind?: string; value?: string }
        | undefined;
      const wallet = body.wallet_to_bind as string | undefined;
      if (!target?.kind || !target.value || !wallet) {
        throw new VerdictError(
          "target_identity and wallet_to_bind are required",
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      const result = await claim.init({
        display_slug: slug,
        target_identity: {
          kind: VerifiedIdentityKindSchema.parse(target.kind),
          value: String(target.value),
        },
        wallet_to_bind: String(wallet) as `0x${string}`,
        now,
      });
      res.status(201).json(result);
    }),
  );

  router.post(
    "/v1/agents/:slug/claim/finalize",
    json,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const challenge_id = body.challenge_id as string | undefined;
      const signature = body.signature as `0x${string}` | undefined;
      const post_url = body.post_url as string | undefined;
      if (!challenge_id || !signature || !post_url) {
        throw new VerdictError(
          "challenge_id, signature, and post_url are required",
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      const result = await claim.finalize({
        challenge_id,
        signature,
        post_url,
        now,
      });
      res.status(200).json(result);
    }),
  );

  // ── Disputes ──

  router.post(
    "/v1/disputes",
    json,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const target = body.target_resolution_receipt_hash;
      const grounds = body.grounds;
      const filed_by = body.filed_by;
      if (typeof target !== "string" || typeof grounds !== "string" || typeof filed_by !== "string") {
        throw new VerdictError(
          "target_resolution_receipt_hash, grounds, and filed_by are required",
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      if (!/^0x[0-9a-f]{64}$/.test(target)) {
        throw new VerdictError(
          "target_resolution_receipt_hash must be 0x + 64 hex chars",
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      const result = disputes.file({
        target_resolution_receipt_hash: target as `0x${string}`,
        grounds: DisputeGroundsSchema.parse(grounds),
        ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
        filed_by,
        now,
      });
      res.status(201).json(result);
    }),
  );

  router.post(
    "/v1/disputes/:dispute_id/resolve",
    json,
    asyncHandler(async (req, res) => {
      if (!adminToken) {
        throw new VerdictError(
          "dispute resolution endpoint disabled (no admin token configured)",
          ERROR_CODES.agent_not_authorized,
          503,
        );
      }
      const auth = req.header("authorization") ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (provided !== adminToken) {
        throw new VerdictError(
          "admin authorization required",
          ERROR_CODES.agent_not_authorized,
          403,
        );
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const replay = body.replay as
        | {
            t1_replay?: { t1?: string; p1?: string; feed?: string };
            t0_override?: { t0?: string; p0?: string; feed?: string };
          }
        | undefined;
      const t1 = replay?.t1_replay;
      if (!t1?.t1 || !t1.p1 || !t1.feed) {
        throw new VerdictError(
          "replay.t1_replay {t1, p1, feed} is required",
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      const result = await disputes.resolve({
        dispute_id: String(req.params.dispute_id ?? ""),
        replay: {
          t1_replay: {
            t1: String(t1.t1),
            p1: String(t1.p1),
            feed: OracleFeedSchema.parse(t1.feed),
          },
          ...(replay?.t0_override?.t0 && replay.t0_override.p0 && replay.t0_override.feed
            ? {
                t0_override: {
                  t0: String(replay.t0_override.t0),
                  p0: String(replay.t0_override.p0),
                  feed: OracleFeedSchema.parse(replay.t0_override.feed),
                },
              }
            : {}),
        },
        ...(typeof body.accept_unchanged === "boolean"
          ? { accept_unchanged: body.accept_unchanged }
          : {}),
        now,
      });
      res.status(200).json(result);
    }),
  );

  router.get("/v1/market/preflight", asyncHandler(async (_req, res) => {
    const market = await deps.ctx.marketContext("base:ETH:USD");
    res.json({
      asset_id: market.asset_id,
      composite_score: market.composite_score,
      top_playbook: market.top_playbook,
      regime: market.regime,
      data_freshness_seconds: market.data_freshness_seconds,
      served_at: nowIso(now()),
    });
  }));

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

function readHmacHeaders(req: Request): {
  agent_id: string;
  timestamp: string;
  signature: string;
} {
  const agent_id = String(req.header("X-Murmur-Agent-Id") ?? "");
  const timestamp = String(req.header("X-Murmur-Timestamp") ?? "");
  const signature = String(req.header("X-Murmur-Signature") ?? "");
  if (!agent_id || !timestamp || !signature) {
    throw new VerdictError(
      "missing HMAC headers",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
  return { agent_id, timestamp, signature };
}

function nowIso(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

export { hashSharedSecret };
