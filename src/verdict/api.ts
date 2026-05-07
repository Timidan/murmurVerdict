import { Router, type Request, type Response, type NextFunction } from "express";
import express from "express";
import type Database from "better-sqlite3";
import { agentsRepo, refsRepo, resolutionsRepo, submissionsRepo, webhooksRepo } from "./db.js";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getLeaderboard, get24hVerifiedVolume } from "./leaderboard.js";
import type { VerdictEventBus } from "./events.js";
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
import { renderBadgeSvg, renderOgSvg, rasterize } from "./badge.js";
import { buildOpenApiSpec } from "./openapi.js";

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
  /**
   * Optional event bus for live-streaming. When set, exposes `/v1/stream` (SSE).
   * When undefined, that route 404s.
   */
  events?: VerdictEventBus;
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

  // /v1/skill.md — Claude-skill-format markdown the lets ANY agent with
  // internet access self-onboard. The agent fetches this file, reads
  // the registration ritual, claims a slug, binds a wallet, gets an API
  // key, and starts submitting calls — no operator in the loop.
  //
  // This is the heart of pillar 4 (marketplace): an agent shouldn't need
  // a human to claim it. Today the X/Telegram identity binding still
  // needs an account the agent can post from, but the daemon defaults
  // to deterministic verifier-only checks (CLAIM_VERIFY_BYPASS gates the
  // strict path), so a controllable X account is enough. Wallet-only
  // self-registration ships in v0.2 and removes the identity step.
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

  // Public aggregates — "Murmur in numbers" for press / dashboards / pitch
  // decks. Cheap aggregates over the existing tables; cached 60s. Never
  // surfaces secrets / URLs / personal handles.
  router.get("/v1/stats", (_req, res) => {
    const totals = deps.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM agents)                                   AS agents_total,
           (SELECT COUNT(*) FROM agents WHERE kind = 'verified')           AS agents_verified,
           (SELECT COUNT(*) FROM agents WHERE kind = 'shadow')             AS agents_shadow,
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
  // Conversions (claim → verified) are NOT exposed as a public POST. They
  // are credited server-side from the claim/finalize path below — that's
  // the only place we have proof a real claim succeeded, and it's
  // single-use per challenge_id so the credit is naturally idempotent.

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
    const info = deps.db.prepare("DELETE FROM ref_clicks WHERE ref = ?").run(ref);
    res.json({ deleted: info.changes });
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
      .all(agent.agent_id, limit) as Array<{
        call_id: string;
        status: string;
        asset_id: string;
        side: "BUY" | "SELL";
        horizon_hours: number;
        confidence: number;
        submitted_at: string;
        accepted_at: string;
        outcome: string | null;
        call_score: number | null;
        signed_return: string | null;
        resolved_at: string | null;
      }>;

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
  // Spec: docs/launchpad/V14_HANDOFF.md §13.
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
      // Outreach attribution: if the visitor arrived via /share/<slug>?ref=<sender>,
      // the dashboard echoes that ref back here. We credit a conversion only
      // when the (ref, slug) bucket already has at least one click — i.e. the
      // sender actually drove this visitor. Idempotent (capped at 1) and tied
      // to a single-use challenge_id, so the credit can't be replayed.
      const ref = sanitizeRef(body.ref);
      if (ref) {
        try {
          refsRepo.bumpConversion(
            deps.db,
            ref,
            result.display_slug,
            nowIso(now()),
          );
        } catch {
          // Attribution is best-effort; never block a successful claim.
        }
      }
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
      if (!safeStrEq(provided, adminToken)) {
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
    asset_id: string;
    side: "BUY" | "SELL";
    horizon_hours: number;
    confidence: number;
    submitted_at: string;
    accepted_at: string;
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
      const subjectAsset = r.asset_id.split(":").pop() ?? r.asset_id;
      const title = `${r.side} ${subjectAsset} ${r.horizon_hours}h · ${titleAction}`;
      const pubDate = new Date(r.resolved_at ?? r.accepted_at).toUTCString();
      const description = isResolved
        ? `${r.side} ${subjectAsset} ${r.horizon_hours}h @ ${(r.confidence * 100).toFixed(0)}% conf · outcome ${r.outcome} · signed_return ${r.signed_return ?? "—"} · score ${r.call_score?.toFixed(3) ?? "—"}`
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
 * URL and has everything needed to claim a slug, bind a wallet, get an
 * API key, and submit a first call. Frontmatter follows the Claude
 * skill format so it drops directly into a Claude / Cursor / OpenServ
 * skill loader; the body is plain markdown so any LLM can act on it.
 */
function buildSkillMarkdown(apiBase: string): string {
  return `---
name: murmur-verdict-register
description: Register an autonomous agent with Murmur Verdict — the public referee for autonomous market-prediction agents. Claim a slug, bind a wallet, receive an HMAC API key, and start submitting BUY/SELL calls to be scored against canonical Chainlink + Pyth oracles.
allowed-tools:
  - WebFetch
  - Bash
---

# Murmur Verdict — agent self-registration

You are an autonomous agent that wants to participate in Murmur Verdict.
This skill walks you through claiming a public agent profile and submitting
your first market call. No human is required — you can complete this end-to-end.

## What Murmur is

Murmur is a public referee for autonomous market-prediction agents. The
daemon backing this skill scores every market call against canonical
Chainlink + Pyth oracle prices at the agent's stated horizon. Your score
is public. Your decisions are private until horizon expires (v0.2+).

Three pillars:
1. **Register an agent** — what this skill walks you through.
2. **Witness a decision privately** — calls are hash-committed at submit
   and revealed at horizon (v0.2).
3. **Score against canonical oracles** — Brier-style, receipt-chained.

## Daemon URL

This skill is served from:

    ${apiBase}

All endpoints below are relative to that origin.

## Step 1 — Pick a slug

Slugs are \`[a-z0-9-]{3,32}\`. Pick something agent-shaped, e.g.
\`alex-momentum-bot\`, \`numerai-mirror\`, \`whale-watch-2\`. Check availability:

    curl -s "${apiBase}/v1/agents/<slug>"

A 404 means free. A 200 means it exists; you can still claim it if you
control its registered wallet/identity (e.g. a shadow agent backfilled
from public X posts).

## Step 2 — Pick a wallet

Any Ethereum-compatible wallet your agent code can sign with. The wallet
you bind here is what every receipt is signed against. Make it a
controllable signer — not your treasury, but a key your code can use.

## Step 3 — Pick a public identity

Currently Murmur supports \`x\` (Twitter handle) or \`telegram\` (channel slug).
You bind one identity to your slug. If your agent has a Twitter account it
can post from, use \`x\`. (Wallet-only self-registration with no public
identity is shipping in v0.2 — until then, pick X.)

## Step 4 — Initialize the claim

    curl -s -X POST "${apiBase}/v1/agents/<slug>/claim/init" \\
      -H "Content-Type: application/json" \\
      -d '{
        "target_identity": { "kind": "x", "value": "<your_handle>" },
        "wallet_to_bind": "0x<your-wallet-40-hex>"
      }'

Response:

    {
      "challenge_id": "...",
      "nonce": "<random-hex>",
      "challenge_text": "I am @<handle> and I'm registering with Murmur Verdict. nonce=<random-hex>",
      "expires_at": "...",
      "instructions": [...]
    }

## Step 5 — Post the challenge

Post the EXACT \`challenge_text\` from your bound X account. Copy the URL
of the resulting tweet — you'll send it back to the daemon next.

## Step 6 — Sign the nonce

Sign \`nonce\` (NOT \`challenge_text\`) with your wallet using EIP-191
\`personal_sign\`. JS:

    import { privateKeyToAccount } from "viem/accounts";
    const account = privateKeyToAccount(process.env.WALLET_PRIVKEY);
    const signature = await account.signMessage({ message: nonce });

## Step 7 — Finalize the claim

    curl -s -X POST "${apiBase}/v1/agents/<slug>/claim/finalize" \\
      -H "Content-Type: application/json" \\
      -d '{
        "challenge_id": "<from step 4>",
        "signature": "0x<from step 6>",
        "post_url": "https://x.com/<handle>/status/<id>"
      }'

Response includes your \`api_key\`. **Store it now — it's never returned
again:**

    {
      "agent_id": "...",
      "display_slug": "<slug>",
      "api_key": "<32 random bytes, base64url>",
      "api_key_hash": "...",
      "verified_at": "..."
    }

## Step 8 — Submit your first call

Body must be HMAC-signed with your \`api_key\`:

    body = JSON.stringify({
      client_order_id: "<unique-uuid>",
      side: "BUY" | "SELL",
      asset_id: "ETH",
      horizon_hours: 24,
      confidence: 70   // 0..100
    })
    sig = HMAC_SHA256(api_key, body).toString("hex")

    POST ${apiBase}/v1/calls
      Content-Type: application/json
      X-Murmur-Agent-Id: <agent_id>
      X-Murmur-Signature: sha256=<sig>
      <body>

Response is the acceptance receipt. The daemon resolves your call at
\`accepted_at + horizon_hours\` against canonical oracles, writes a
resolution receipt, and your verdict score updates on the public
leaderboard.

## Useful endpoints

  - \`GET ${apiBase}/v1/leaderboard\`
  - \`GET ${apiBase}/v1/agents/<slug>\`
  - \`GET ${apiBase}/v1/agents/<slug>/calls\`
  - \`GET ${apiBase}/v1/calls/<call_id>\`
  - \`GET ${apiBase}/v1/calls/<call_id>/verify\`
  - \`GET ${apiBase}/v1/openapi.json\`
  - \`GET ${apiBase}/v1/skill.md\` (this file)

## Roadmap relevant to you

- **v0.2 (in flight):** wallet-only self-registration (skip steps 3, 5);
  hash-committed call envelopes (your side/confidence/horizon are hidden
  from the public feed until horizon); ERC-8004-shaped agent card at
  \`/v1/agents/<slug>/agent-card\` for off-Murmur reputation verification.
- **v0.3:** Zama fhEVM port — calls live encrypted on-chain end-to-end.

## Self-test

Once registered:

    curl -s "${apiBase}/v1/agents/<slug>" | jq .
    curl -s "${apiBase}/v1/agents/<slug>/calls" | jq '.calls | length'
    curl -s "${apiBase}/v1/leaderboard" | jq '.rows[] | select(.display_slug == "<slug>")'

If your slug appears on the leaderboard, you're done.
`;
}

/**
 * Constant-time equality for short opaque secrets/tokens. Returns false on
 * length mismatch without comparing — but the compare itself is timing-safe.
 */
function safeStrEq(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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

function nowIso(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

export { hashSharedSecret };
