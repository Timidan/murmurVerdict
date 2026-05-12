import { Router, type Request, type Response, type NextFunction } from "express";
import express from "express";
import type Database from "better-sqlite3";
import {
  agentsRepo,
  callRevealsRepo,
  marketsRepo,
  refsRepo,
  resolutionsRepo,
  submissionsRepo,
  webhooksRepo,
  type CallRevealRow,
  type MarketRow,
  type RegistryStatus,
} from "./db.js";
import { adapterIdentityForMarket, legacyHorizonHoursForMarket } from "./markets.js";
import {
  COMMIT_PREIMAGE_SCHEMA,
  MARKET_COMMIT_PREIMAGE_SCHEMA,
  parseAndRebuildPreimageObject,
} from "./commit-preimage.js";
import { projectCallRow } from "./projections.js";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
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
  AgentSlugSchema,
  ChainIdSchema,
  ERROR_CODES,
  MarketIdSchema,
  REGISTERED_STRATEGY_TAGS,
  SCHEMA_VERSION,
  SCORING_VERSION,
  VerdictError,
} from "./schema.js";
import {
  hashSharedSecret,
  submitCall,
  verifyHmac,
  type SubmissionContext,
} from "./submissions.js";
// Wave 1 — ClaimService import removed alongside src/verdict/claim.ts.
import { DisputeService } from "./disputes.js";
import { DisputeGroundsSchema, OracleFeedSchema } from "./schema.js";
import { verifyAgentApiKey } from "./auth.js";
import { getTodayFeed } from "./feed.js";
import { renderBadgeSvg, renderOgSvg, rasterize } from "./badge.js";
import { buildOpenApiSpec } from "./openapi.js";
import { dispatchAuth, type AuthIdentity as DispatchedAuthIdentity } from "./auth/dispatcher.js";
import { CommitmentSchema, type Commitment } from "./markets-core.js";
import { getMarketMakerRegistry } from "./market-maker/registry.js";
import { z } from "zod";

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
  const disputes = deps.disputes ?? new DisputeService({ db: deps.db });
  const adminToken = deps.adminToken ?? process.env.VERDICT_ADMIN_TOKEN ?? "";
  const json = express.json({ limit: "32kb" });

  // Wave 1 — claim_challenges GC removed alongside the deleted claim
  // routes. The table is retained for now to keep local DBs at v=30
  // bootable without manual repair; Wave 3 (Migration 031) drops the
  // table outright.

  // Wave 2a — /v1/calls returns 410 Gone. The legacy plaintext submit
  // endpoint (wallet HMAC OR API key with side/asset_id/horizon_hours/
  // confidence wire shape) is retired. Reputation is built up via
  // FHE-direct calls on /v2/calls only; agents that previously
  // targeted /v1/calls must migrate to /v2/calls with the `fhe` block.
  router.post(
    "/v1/calls",
    asyncHandler(async (_req, res) => {
      res.status(410).json({
        code: "endpoint_removed",
        message:
          "/v1/calls is retired. Submit via /v2/calls with privacy_mode='fhe_direct' and the `fhe` block. See /v1/skill.md for the new flow.",
        replacement: "/v2/calls",
      });
    }),
  );

  // ─── POST /v2/calls (Phase 4 — V2 §7.1 universal Commitment) ───────────────
  //
  // Universal Commitment surface. Auth runs through the tier-aware
  // dispatcher (Privy bearer → casual; X-Murmur-Api-Key → casual or legacy;
  // HMAC → wallet_legacy). Per V2 §7.1:
  //   - tier='casual'        → accepted; legacy_plaintext only (committed
  //                            mode is gated until reveal-flow lands at
  //                            scoped key + EIP-712).
  //   - tier='legacy'        → accepted (existing API-key-only agent),
  //                            flagged for cutover.
  //   - tier='wallet_legacy' → REJECTED 426. HMAC wallet agents must keep
  //                            using /v1/calls until Phase 8 EIP-712.
  //   - tier='attested'      → REJECTED 503 (Phase 13).
  //
  // Body shape: a universal {@link Commitment} (CommitmentSchema) PLUS
  // idempotency / metadata fields the legacy wire shape carries:
  //   - client_order_id        (required, idempotency key)
  //   - rationale | strategy_tag (required — same superRefine as /v1)
  //   - submitted_at           (optional; defaults to server-now)
  //
  // Adapter dispatch: marketRef.protocol → MarketMakerRegistry.get(...).
  // Today only 'native-price' is registered; unknown protocols 422. The
  // adapter's `commitmentSchema` runs an additional narrow Zod transform
  // (e.g. native-price clamps confidence to [0.51, 0.95]).
  //
  // Body → legacy SubmittedCall translation: native-price's payout-vector
  // maps to BUY/SELL ([1,0]→BUY, [0,1]→SELL). The handler synthesizes a
  // legacy SubmittedCall payload and feeds submitCall(...) which writes
  // BOTH the legacy columns and the universal commitment_json /
  // predicted_outcome_json columns (Phase 4 dual-write).
  router.post(
    "/v2/calls",
    express.text({ type: "application/json", limit: "32kb" }),
    asyncHandler(async (req, res) => {
      const rawBody = typeof req.body === "string" ? req.body : "";
      // Tier-aware auth dispatch. Privy unconfigured in dev → bearer
      // tokens fall through to api-key / hmac modes (verifyPrivyAuth
      // returns null when env unset). Throws VerdictError on policy
      // rejections (unowned slug, multi-agent ambiguous header).
      const authResult: DispatchedAuthIdentity | null = await dispatchAuth(
        req,
        {
          db: deps.db,
          resolveSharedSecret: deps.resolveSharedSecret,
          rawBody,
          now,
        },
      );
      if (!authResult) {
        throw new VerdictError(
          "auth required: provide Authorization: Bearer <privy>, X-Murmur-Api-Key, or HMAC headers",
          ERROR_CODES.agent_not_authorized,
          401,
        );
      }
      // Per-tier policy gates.
      if (authResult.tier === "wallet_legacy") {
        // Wallet HMAC agents stay on /v1/calls until Phase 8 EIP-712. We
        // surface 426 Upgrade Required so a misrouted wallet client sees
        // an actionable error (vs the silent 401 a missing tier would
        // produce). The /v1/calls path is unchanged for them.
        throw new VerdictError(
          "wallet HMAC agents must use /v1/calls; /v2/calls requires casual or legacy tier auth (Phase 8 lands EIP-712 for wallet tier)",
          ERROR_CODES.agent_not_authorized,
          426,
        );
      }
      if (authResult.agent_kind === "attested") {
        // Phase 13 wires Olas Service Registry attestation. Reject
        // explicitly so an attested agent sees a clear "not yet" rather
        // than a silent fall-through.
        throw new VerdictError(
          "attested-tier submissions are not yet supported on /v2/calls (Phase 13)",
          ERROR_CODES.agent_not_authorized,
          503,
        );
      }
      if (!authResult.agent_id) {
        // Casual tier session-only auth (account exists, no agent
        // selected). /v2/calls demands an agent context — surface a 400
        // with the same code the dispatcher uses elsewhere.
        throw new VerdictError(
          "X-Murmur-Agent-Slug or X-Murmur-Agent-Id header required: account owns no default agent",
          ERROR_CODES.agent_slug_required,
          400,
        );
      }

      // Parse the v2 wire body. Schema is CommitmentSchema + the
      // idempotency / metadata fields the legacy wire carries.
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
      const parsed = V2SubmissionBodySchema.safeParse(bodyJson);
      if (!parsed.success) {
        throw new VerdictError(
          "v2 submission failed schema validation",
          ERROR_CODES.schema_invalid,
          400,
          { issues: parsed.error.format() },
        );
      }
      const body = parsed.data;

      // Wave 2a — FHE-direct is the only accepted privacy_mode on
      // /v2/calls. Legacy plaintext / committed-mode acceptance is
      // dead; the daemon stores ciphertext-only and the operator
      // cannot decrypt the prediction. Default the mode to fhe_direct
      // when callers omit it so existing clients that previously
      // omitted the field don't break — they fail downstream at the
      // `fhe` block requirement instead.
      const submittedMode = body.privacy_mode ?? "fhe_direct";
      if (submittedMode !== "fhe_direct") {
        throw new VerdictError(
          "/v2/calls accepts only privacy_mode='fhe_direct' (committed + legacy_plaintext modes removed in Wave 2a — reputation is built up via FHE-direct calls only)",
          ERROR_CODES.schema_invalid,
          400,
          { received: body.privacy_mode ?? null },
        );
      }
      body.privacy_mode = "fhe_direct";
      if (!body.fhe) {
        throw new VerdictError(
          "/v2/calls requires the `fhe` block (encrypted_predicted_outcome + keyset_id + circuit_id + ciphertext_hash + vector_len + payout_denominator + nonce). plaintext predictedOutcome/horizon/confidence are no longer accepted",
          ERROR_CODES.schema_invalid,
          400,
        );
      }

      // Adapter dispatch: registry.get(marketRef.protocol). 422 on
      // unknown protocols so a v2.0 agent that mistypes / picks an
      // unimplemented family (polymarket-gamma — Phase 11) sees a
      // distinct error code from auth (401/403/426) and schema (400).
      const adapter = getMarketMakerRegistry().get(body.marketRef.protocol);
      if (!adapter) {
        throw new VerdictError(
          `unsupported marketRef.protocol: '${body.marketRef.protocol}' (only 'native-price' registered at v2.0)`,
          ERROR_CODES.asset_not_supported,
          422,
          { protocol: body.marketRef.protocol },
        );
      }

      // Resolve the underlying market_id. For native-price, marketRef.sourceId
      // IS the market_id (e.g. 'eth.1h'). Fail-fast 404 if unknown.
      const market = marketsRepo.get(deps.db, body.marketRef.sourceId);
      if (!market) {
        throw new VerdictError(
          `unknown market: marketRef.sourceId='${body.marketRef.sourceId}' (no row in markets registry)`,
          ERROR_CODES.asset_not_supported,
          404,
          { sourceId: body.marketRef.sourceId },
        );
      }

      // Wave 2a — single FHE-direct submission path. Legacy
      // plaintext bridge (Commitment → derivePayoutSide → SubmittedCall
      // → submitCall) deleted; the privacy_mode check at the top of
      // this handler refuses any non-fhe_direct submission before we
      // reach this point.
      const submittedAt =
        body.submitted_at ?? now().toISOString().replace(/\.\d+Z$/, "Z");
      const fhePayload: Record<string, unknown> = {
        schema_version: SCHEMA_VERSION,
        agent_id: authResult.agent_id,
        client_order_id: body.client_order_id,
        market_id: market.market_id,
        privacy_mode: "fhe_direct",
        submitted_at: submittedAt,
        ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
        ...(body.strategy_tag !== undefined
          ? { strategy_tag: body.strategy_tag }
          : {}),
      };
      const fheResult = await submitCall({
        db: deps.db,
        ctx: deps.ctx,
        identity: { agent_id: authResult.agent_id },
        payload: fhePayload,
        fheDirect: { fhe: body.fhe, market_id: market.market_id },
      });
      res.status(fheResult.idempotent_hit ? 200 : 201).json({
        call_id: fheResult.call.call_id,
        // Operator-blind response: no synthesized plaintext fields.
        call: {
          schema_version: fheResult.call.schema_version,
          scoring_version: fheResult.call.scoring_version,
          call_id: fheResult.call.call_id,
          agent_id: fheResult.call.agent_id,
          client_order_id: fheResult.call.client_order_id,
          submitted_at: fheResult.call.submitted_at,
          accepted_at: fheResult.call.accepted_at,
          status: fheResult.call.status,
          ...(fheResult.call.rationale !== undefined
            ? { rationale: fheResult.call.rationale }
            : {}),
          ...(fheResult.call.strategy_tag !== undefined
            ? { strategy_tag: fheResult.call.strategy_tag }
            : {}),
          privacy_mode: "fhe_direct",
        },
        idempotent_hit: fheResult.idempotent_hit,
        tier: authResult.tier,
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
    // Wave 2b — committed-mode / age-envelope / drand binding privacy
    // stack removed. /v1/health surfaces only the FHE-direct readiness
    // signal; the deeper threshold-committee posture lives at
    // /v1/readyz.privacy and /v1/meta.privacy.
    const privacy = {
      fhe_direct_enabled: deps.ctx.fheProvider !== null && deps.ctx.fheProvider !== undefined,
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

    // Phase G H1/M2 — privacy stack health. age key custody is a
    // boot-time check (env var presence); drand requires a live
    // network probe of the chain's latest beacon. We don't fail
    // /readyz on drand UNREACHABLE (that's an opt-in upgrade), but
    // we DO surface the state so operators see the degradation.
    //
    // Wave 2a — FHE is mandatory; `fhe_direct_enabled` is now always
    // true in the readyz/meta privacy block. The check kept for wire-
    // shape stability with older SDK clients that read the field.
    const fheProv = deps.ctx.fheProvider ?? null;
    const fheEnabled = fheProv !== null;
    let fheActiveKeysetId: string | null = null;
    if (fheProv) {
      try {
        const row = deps.db
          .prepare(
            `SELECT keyset_id FROM fhe_keysets
             WHERE provider = ? AND status = 'active'
             ORDER BY activated_at DESC LIMIT 1`,
          )
          .get(fheProv.name) as { keyset_id: string } | undefined;
        if (row) fheActiveKeysetId = row.keyset_id;
      } catch {
        // Pre-migration-023 race; surface as no active keyset.
      }
    }
    // Z5 — production gate. When MURMUR_PROD_REQUIRE_OPERATOR_BLIND=1
    // the daemon refuses to report ready unless the threshold committee
    // posture is 'production'. mock / stub / mock_quorum are explicitly
    // rejected — those are development postures that keep the operator
    // in the trust root (see skill.md threat-model + Z3 plan §3).
    // Default off so single-operator dev environments can boot the
    // legacy plaintext or committed-mode stack without flipping this.
    const prodRequireOperatorBlind =
      process.env.MURMUR_PROD_REQUIRE_OPERATOR_BLIND === "1";
    const thresholdMode = fheProv?.threshold_mode ?? null;
    const prodGateOk = !prodRequireOperatorBlind || thresholdMode === "production";
    const prodGateReason = prodRequireOperatorBlind && !prodGateOk
      ? `MURMUR_PROD_REQUIRE_OPERATOR_BLIND=1 but threshold_mode=${thresholdMode ?? "null"} (need 'production')`
      : null;

    // Z5 — audit-log emit on gate STATE TRANSITION. Codex Z5 review
    // MAJOR fix: the privacy_policy_events table existed without any
    // producer, leaving the audit log decorative. Emitting on every
    // readyz call (typically once per second from a kubelet probe)
    // would spam the table; emitting on transition catches the
    // ok→fail (and recovery) events that operators actually want
    // logged. In-memory module-scope flag — single-process daemon
    // assumption matches the EventBus posture elsewhere.
    if (prodGateOk !== lastProdGateOk) {
      try {
        deps.db
          .prepare(
            `INSERT INTO privacy_policy_events (
               event_id, kind, payload_json, actor, created_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            "readyz_prod_gate_failed",
            JSON.stringify({
              transitioned_to_ok: prodGateOk,
              threshold_mode: thresholdMode,
              prod_require_operator_blind: prodRequireOperatorBlind,
              reason: prodGateReason,
            }),
            "daemon:readyz",
            nowIso(now()),
          );
      } catch (err) {
        // Audit emit is best-effort — must not affect readyz response.
        console.warn(
          `[readyz] privacy_policy_events emit failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      lastProdGateOk = prodGateOk;
    }

    const privacy = {
      // Wave 2b — committed-mode / age / drand fields removed. FHE-direct
      // is the only privacy mode now; the readyz privacy block surfaces
      // the threshold-committee posture + Z5 prod gate state.
      fhe_direct_enabled: fheEnabled,
      provider: fheProv?.name ?? null,
      active_keyset_id: fheActiveKeysetId,
      threshold_mode: thresholdMode,
      // Z5 — prod-gate observability.
      prod_require_operator_blind: prodRequireOperatorBlind,
      prod_gate_ok: prodGateOk,
      prod_gate_reason: prodGateReason,
    };

    const ready =
      dbOk && (oracleStatus === "ok" || oracleStatus === "disabled") && prodGateOk;
    res.status(ready ? 200 : 503).json({
      ready,
      now: nowIso(now()),
      db: { ok: dbOk, latency_ms: dbMs, error: dbError },
      oracle: { status: oracleStatus, latency_ms: oracleMs, error: oracleError },
      privacy,
    });
  }));

  router.get("/v1/meta", (_req, res) => {
    // Z0 — surface FHE wiring without disclosing anything secret. The
    // `privacy` block is additive; SDK clients reading existing fields
    // (schema_version, strategy_tags, assets, verified_volume_24h)
    // stay untouched. `active_keyset_id` is the row Z1 will FK against;
    // Wave 2a — FHE is mandatory. `fhe_direct_enabled` is true iff a
    // provider was loaded at boot; null means the daemon misconfigured
    // and /v2/calls submissions will reject.
    const fheProv = deps.ctx.fheProvider ?? null;
    const fheEnabled = fheProv !== null;
    let activeKeysetId: string | null = null;
    if (fheProv) {
      try {
        const row = deps.db
          .prepare(
            `SELECT keyset_id FROM fhe_keysets
             WHERE provider = ? AND status = 'active'
             ORDER BY activated_at DESC LIMIT 1`,
          )
          .get(fheProv.name) as { keyset_id: string } | undefined;
        if (row) activeKeysetId = row.keyset_id;
      } catch {
        // fhe_keysets exists post-migration 023; defensive against
        // older DBs surfaced via /v1/meta during boot races.
      }
    }
    res.json({
      schema_version: SCHEMA_VERSION,
      scoring_version: SCORING_VERSION,
      strategy_tags: REGISTERED_STRATEGY_TAGS,
      assets: ["base:ETH:USD"],
      verified_volume_24h: get24hVerifiedVolume(deps.db),
      privacy: {
        fhe_direct_enabled: fheEnabled,
        provider: fheProv?.name ?? null,
        active_keyset_id: activeKeysetId,
        threshold_mode: fheProv?.threshold_mode ?? null,
      },
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

  // ── ERC-8004 agent card (Draft) ──
  // Machine-readable agent card discoverable by ERC-8004 indexers and
  // launchpad marketplaces. Shape follows the Draft EIP registration JSON:
  //   { type, name, description, image?, services[], x402Support, active,
  //     registrations, supportedTrust? }
  // - `services` use `endpoint` (NOT `url`) per the canonical spec
  // - `agentWallet` is reserved on-chain metadata in the spec; NOT included
  //   here. Off-chain consumers read /v1/agents/:slug for the wallet
  //   binding (top-level wallet_address + chain_id fields).
  // - x402Support is declared `true` so AgentKit / x402-aware clients
  //   know we'll honor 402 receipts on /v1/receipts/:id when v0.3 wires
  //   the actual middleware. v0.2 ships the declaration only (D8b).
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
          name: "Submit a market call",
          endpoint: `${apiBase}/v1/calls`,
          // Auth: X-Murmur-Agent-Id + X-Murmur-Api-Key (Bearer).
        },
        {
          type: "murmur-verdict.skill",
          name: "Self-onboarding skill (Claude/Cursor/OpenServ readable)",
          endpoint: `${apiBase}/v1/skill.md`,
        },
      ],
      // Paper-only declaration today; flips to true wiring when the v0.3
      // x402 middleware lands on /v1/receipts/:id.
      x402Support: true,
      // "active" = this agent CAN submit calls right now. True if the
      // agent has an issued api_key_hash (verified + wallet_only after
      // finalize) OR the agent uses env-var keys (benchmark, internal_test).
      // Shadow agents and unfinalized wallet_only agents return false —
      // they exist as profiles but can't push fresh data.
      active:
        row.api_key_hash !== null ||
        row.kind === "benchmark" ||
        row.kind === "internal_test",
      // Per the EIP, `registrations` is an array of (chain_id,
      // registration_id) tuples once an agent is on-chain. v0.2 has no
      // contract deploy yet, so we emit an empty array — consumers know
      // we plan to register but haven't yet.
      registrations: [] as Array<{ chain_id: string; registration_id: string }>,
      // Phase H — operator UX. Marketplace clients see exactly which
      // privacy primitives this Murmur deployment supports. v0.3 fhEVM
      // Wave 2b — ERC-8004 agent card privacy block rewritten to the
      // FHE-mandatory shape. submission_modes is single-entry; the
      // committed/age/drand fields are deleted. Threshold-committee
      // posture lives at /v1/meta.privacy.threshold_mode.
      privacy: {
        submission_modes: ["fhe_direct"],
        operator_can_decrypt_pre_horizon: false,
        threat_model_url: `${apiBase}/v1/skill.md#threat-model--privacy-guarantees`,
      },
      // Optional v0.3+ fields surfaced when present. Always included off
      // the agent row so receipts and the agent card stay consistent.
      ...(row.wallet_address && row.chain_id
        ? {
            // Non-spec sibling field: explicit wallet binding for off-
            // Murmur consumers that don't want to compose
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
    // Phase E hydration: pull cr.* mirror columns alongside s.* so the
    // projection can COALESCE legacy submission plaintext (NULL after
    // MURMUR_PHASE_E_CLEANUP) with the still-present call_reveals values.
    // Wave 2b — call_reveals JOIN + cr.* SELECT removed. The plaintext
    // s.side / s.asset_id / s.horizon_hours / s.confidence columns are
    // still SELECT'd for now because the schema retains them through
    // Wave 3 (Migration 031 drops them outright); projectCallRow's
    // operator-blind projection ignores them under FHE-mandatory.
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
    // Phase E hydration: pull cr.* mirror columns so the RSS surface stays
    // populated for committed-mode rows whose submissions plaintext has
    // been NULL'd by MURMUR_PHASE_E_CLEANUP.
    // Wave 2b — call_reveals JOIN + cr.* SELECT removed. Plaintext
    // submission columns dropped from the projection input (projectCallRow
    // ignores them under FHE-mandatory). The RSS row shape still
    // exposes the placeholder fields (asset_id / side / horizon_hours /
    // confidence) because the consumer at rssAgentFeed treats them as
    // optional rendering hints — they collapse to "" / "BUY" / 0 / 0
    // under FHE-mandatory, which the formatter handles.
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
        // Wave 2b — operator-blind placeholders. The RSS formatter
        // tolerates these; future Wave 3 drops the legacy SQL columns
        // entirely and the formatter will need updating.
        asset_id: "",
        side: "BUY" as const,
        horizon_hours: 0,
        confidence: 0,
        submitted_at: projected.submitted_at ?? "",
        is_committed_scrubbed: true,
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

  // ── Reveal: agent voluntarily publishes the commit preimage ─────────
  // POST /v1/calls/:call_id/reveal
  // Auth: Bearer (X-Murmur-Agent-Id + X-Murmur-Api-Key)
  // Body: { commit_preimage: <D13 fields>, rationale?, strategy_tag? }
  //
  // Flow:
  //   1. Bearer auth identifies the calling agent.
  //   2. Look up call; must be privacy_mode='committed' AND owned by
  //      this agent. Cross-agent reveals are rejected.
  //   3. The submitted preimage is canonicalized and hashed. The hash
  //      MUST match the stored submissions.commit_hash (set at submit
  //      time). Mismatch → 422 commit_mismatch.
  //   4. Defense-in-depth: preimage.call_id matches URL :call_id;
  //      preimage.agent_wallet matches the agent's bound wallet;
  //      preimage.chain_id matches; preimage.t0 matches accepted_at.
  //      Any mismatch is structurally impossible if the daemon
  //      computed commit_hash correctly, but check anyway.
  //   5. Idempotency: if a call_reveals row already exists with the
  //      SAME preimage hash, return 200 with the existing record.
  //      Different preimage hash → 409.
  //   6. Insert call_reveals row (revealed_via='agent',
  //      reveal_hash_valid=1).
  //
  // The reveal is allowed BEFORE t1 too — the agent just shows their
  // hand early. Public surfaces still scrub pending rows (Phase E);
  // the reveal is private until resolution.
  // Wave 2a — /v1/calls/:call_id/reveal and /v1/calls/:call_id/envelope
  // both return 410 Gone. Committed-mode submissions don't exist in the
  // FHE-mandatory world: there's no plaintext preimage to reveal and no
  // age/drand envelope to publicly attest. fhe_direct calls use the
  // threshold-decrypt flow under /v1/fhe/* instead (see Z3 routes).
  router.post(
    "/v1/calls/:call_id/reveal",
    asyncHandler(async (_req, res) => {
      res.status(410).json({
        code: "endpoint_removed",
        message:
          "/v1/calls/:call_id/reveal is retired alongside committed-mode submissions. fhe_direct calls release the bounded score via the threshold-decrypt routes (/v1/fhe/*); the prediction itself stays encrypted.",
      });
    }),
  );

  router.get("/v1/calls/:call_id/envelope", (_req, res) => {
    res.status(410).json({
      code: "endpoint_removed",
      message:
        "/v1/calls/:call_id/envelope is retired alongside committed-mode submissions. fhe_direct ciphertext hashes live on the call's submission row + fhe_call_ciphertexts; the threshold release transcript at /v1/calls/:call_id (fhe_extras) is the public attestation path.",
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
    // Phase E: scrub plaintext from the submission sub-object while a
    // Wave 2b — call_reveals JOIN + cr.* SELECT removed. Single
    // submissions row read for the privacy-mode + commit-hash needed
    // to construct the operator-blind projection.
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
      // Wave 2b — operator-blind always. No plaintext fields are
      // included on the response.
      ...(projected.submitted_at ? { submitted_at: projected.submitted_at } : {}),
    };
    // Z2 — for fhe_direct rows, surface the encrypted-score status. The
    // response NEVER carries the prediction (still encrypted in
    // fhe_call_ciphertexts) and NEVER carries the cleartext score (still
    // encrypted in fhe_score_jobs until Z3 releases it). Callers see:
    //   score_status: 'pending_t1'            — t1 not yet anchored
    //   score_status: 'score_pending_decrypt' — encrypted score computed,
    //                                           awaiting Z3 quorum decrypt
    //   score_status: 'score_pending_quorum'  — Z3 in flight (placeholder
    //                                           until Z3 wires it; today
    //                                           we never emit this state)
    //   score_status: 'resolved'              — bounded score released
    //                                           (only after Z3)
    // plus the transcript_hash once computed (Z3 disputes replay
    // against it).
    const fheExtras: Record<string, string> = {};
    if (subRow?.privacy_mode === "fhe_direct") {
      const jobRow = deps.db
        .prepare(
          `SELECT j.status AS job_status, j.transcript_hash,
                  s.status AS sub_status
           FROM submissions s
           LEFT JOIN fhe_score_jobs j ON j.call_id = s.call_id
           WHERE s.call_id = ?`,
        )
        .get(call_id) as
        | {
            job_status: string | null;
            transcript_hash: string | null;
            sub_status: string;
          }
        | undefined;
      if (jobRow) {
        let scoreStatus: string;
        if (jobRow.sub_status !== "resolved") {
          scoreStatus = "pending_t1";
        } else if (jobRow.job_status === "scored_pending_decrypt") {
          scoreStatus = "score_pending_decrypt";
        } else if (
          full.resolution?.call_score !== null &&
          full.resolution?.call_score !== undefined
        ) {
          scoreStatus = "resolved";
        } else {
          scoreStatus = "score_pending_decrypt";
        }
        fheExtras["score_status"] = scoreStatus;
        if (jobRow.transcript_hash) {
          fheExtras["transcript_hash"] = jobRow.transcript_hash;
        }
      } else {
        fheExtras["score_status"] = "pending_t1";
      }
    }
    res.json({ ...full, submission: scrubbedSubmission, ...fheExtras });
  });

  // Wave 1 (consolidated reshape) — /v1/agents/:slug/claim/* routes
  // (init, finalize, wallet-only/init, wallet-only/finalize) all
  // deleted. The public-identity claim flow (X/Telegram post-content
  // verification) and the wallet-only self-mint flow were the v0.1
  // onboarding paths. In the new model agents are minted under a
  // Privy account via POST /v1/account/agents — no on-platform
  // signature challenge, no public-identity proof. Operator-mediated
  // manual claim for legacy shadow agents lands as a CLI in Wave 5
  // (no public route).

  // ── Disputes ──

  router.post(
    "/v1/disputes",
    json,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Wave 4b: disputes now key on the call_id directly. Receipt hashes
      // were retired alongside the receipts subsystem.
      const target = body.target_call_id;
      const grounds = body.grounds;
      const filed_by = body.filed_by;
      if (typeof target !== "string" || typeof grounds !== "string" || typeof filed_by !== "string") {
        throw new VerdictError(
          "target_call_id, grounds, and filed_by are required",
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      const result = disputes.file({
        target_call_id: target,
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
      }));
      res.json({
        markets: enriched,
        served_at: nowIso(now()),
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

// ─── /v2/calls body schema (Phase 4) ───────────────────────────────────────
//
// CommitmentSchema + idempotency / metadata fields the legacy wire shape
// already requires. Kept narrow on purpose: the v2 surface deliberately
// drops {asset_id, horizon_hours, market_id, salt} — every market is
// addressed via marketRef, and committed-mode (which needed `salt`) is
// gated until Phase 8 EIP-712. Adding a stray field returns
// `schema_invalid` thanks to z.strict().
// Z1 — operator-blind submission. When privacy_mode='fhe_direct', the
// body carries an `fhe` block instead of plaintext predictedOutcome /
// horizon / confidence. The legacy Commitment fields become OPTIONAL at
// the Zod level and are REJECTED by the superRefine when fhe_direct is
// set (mutually exclusive). The fhe block's content (keyset existence,
// hash recomputation, replay) is validated inside submitFheDirectCall;
// here we only enforce the wire shape.
const FheBlockSchema = z
  .object({
    keyset_id: z.string().min(1).max(128),
    circuit_id: z.string().min(1).max(128),
    encrypted_predicted_outcome: z
      .string()
      .min(1)
      .max(256 * 1024),
    ciphertext_hash: z.string().regex(/^[0-9a-f]{64}$/),
    vector_len: z.number().int().min(2).max(256),
    payout_denominator: z.string().regex(/^[1-9][0-9]*$/),
    nonce: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

// Wave 2a — /v2/calls is FHE-direct-only. The schema requires the
// `fhe` block, defaults privacy_mode to 'fhe_direct' when omitted,
// rejects any other value, and forbids the legacy plaintext fields
// (predictedOutcome / horizon / confidence) since fhe_direct hides
// them inside the ciphertext.
const V2SubmissionBodySchema = z
  .object({
    marketRef: CommitmentSchema.shape.marketRef,
    client_order_id: z.string().min(8).max(128),
    rationale: z.string().max(240).optional(),
    strategy_tag: z.string().min(2).max(32).optional(),
    submitted_at: z
      .string()
      .datetime({ offset: false })
      .optional(),
    // Default to 'fhe_direct' when omitted so existing clients that
    // never set the field get the right behavior. The superRefine
    // below still rejects any explicit non-FHE value (the legacy
    // legacy_plaintext / committed modes are gone in Wave 2a).
    privacy_mode: z
      .string()
      .optional()
      .transform((v) => v ?? "fhe_direct"),
    fhe: FheBlockSchema,
    // Wave 2a — predictedOutcome/horizon/confidence are no longer
    // accepted on /v2/calls. They were optional under Z1 because the
    // wire shape had to support both fhe_direct and legacy_plaintext;
    // with legacy_plaintext gone, they're forbidden. The schema
    // explicitly captures them with .never() so .strict() surfaces a
    // clear error if a stale client still sends them. .never() inside
    // .strict() emits "Expected never, received ..." — the message is
    // helpful enough that we don't superRefine on top.
    predictedOutcome: z.never().optional(),
    horizon: z.never().optional(),
    confidence: z.never().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.rationale && !v.strategy_tag) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rationale or strategy_tag is required",
        path: ["rationale"],
      });
    }
    if (v.privacy_mode !== "fhe_direct") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "/v2/calls accepts only privacy_mode='fhe_direct' (legacy_plaintext + committed removed in Wave 2a)",
        path: ["privacy_mode"],
      });
    }
  });

// Wave 2a — `derivePayoutSide` + `readHmacHeaders` helpers removed
// alongside the legacy plaintext bridge and the /v1/calls HMAC submit
// endpoint. The FHE-direct submit path doesn't reduce payoutNumerators
// at the API edge (the ciphertext is opaque to the daemon), and HMAC
// auth headers are unused now that /v1/calls returns 410.

function repairInvalidReveal(db: Database.Database, row: CallRevealRow): void {
  const info = db
    .prepare(
      `UPDATE call_reveals
       SET side = @side,
           asset_id = @asset_id,
           horizon_hours = @horizon_hours,
           confidence = @confidence,
           rationale = @rationale,
           strategy_tag = @strategy_tag,
           salt = @salt,
           t0 = @t0,
           agent_wallet = @agent_wallet,
           chain_id = @chain_id,
           commit_preimage_json = @commit_preimage_json,
           commit_preimage_hash = @commit_preimage_hash,
           revealed_at = @revealed_at,
           revealed_via = @revealed_via,
           reveal_hash_valid = @reveal_hash_valid
       WHERE call_id = @call_id
         AND reveal_hash_valid = 0`,
    )
    .run(row);
  if (info.changes !== 1) {
    throw new VerdictError(
      "call already revealed with a different preimage",
      ERROR_CODES.duplicate,
      409,
    );
  }
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
    is_committed_scrubbed?: boolean;
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
      if (r.is_committed_scrubbed) {
        const title = `[COMMITTED] ${titleAction}`;
        const description = isResolved
          ? `committed call · outcome ${r.outcome} · score ${r.call_score?.toFixed(3) ?? "—"}`
          : `committed call · pending reveal/resolution`;
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
 * Read the client IP from `X-Forwarded-For` (when behind a trusted proxy
 * like Render / Vercel / Cloudflare) or fall back to `req.ip`. Picks the
 * leftmost address from XFF since proxies append rightward. Defensive:
 * never throws, always returns a string suitable as a rate-limiter key.
 */
function readClientIp(req: Request): string {
  const xff = req.header("x-forwarded-for");
  if (xff && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first && first.length > 0) return first;
  }
  return req.ip ?? "unknown";
}

// Wave 1 — walletOnlyInitLimiter deleted alongside the /claim/wallet-only
// routes it gated. Casual-tier mint via POST /v1/account/agents has its
// own express-rate-limit middleware (see src/verdict/routes/account.ts).

/**
 * Self-onboarding skill file. Any agent with internet access reads this
 * URL and has everything needed to claim a slug, bind a wallet, get an
 * API key, and submit a first call. Frontmatter follows the Claude
 * skill format so it drops directly into a Claude / Cursor / OpenServ
 * skill loader; the body is plain markdown so any LLM can act on it.
 */
/**
 * Phase G — drand reachability probe for /v1/readyz. Doesn't error out
 * the readiness check (drand is opt-in, an unavailable drand network
 * just means committed-mode submissions get age-only envelopes). But
 * the operator sees the degraded state in the readyz response so
 * they can investigate.
 *
 * Cached result: 30s TTL. Drand mainnet quicknet has a 3s period; we
 * don't need to hit it on every readyz call.
 */
// Z5 — module-scope last-seen prod-gate state so readyz only emits a
// privacy_policy_events row on TRANSITION, not on every probe call.
// Default true so the very first 503 (gate trips at boot) emits one
// event and subsequent failed probes stay silent until recovery.
// Single-process daemon assumption — same posture as drandHealthCache
// and the EventBus.
let lastProdGateOk = true;

let drandHealthCache: {
  fetchedAt: number;
  result: {
    configured: boolean;
    reachable: boolean;
    chain_hash: string | null;
    latest_round: number | null;
    period_seconds: number | null;
    error?: string;
  };
} | null = null;
const DRAND_HEALTH_TTL_MS = 30_000;

async function probeDrandHealth(
  drandCtx?: import("./drand-envelope.js").DrandContext,
): Promise<NonNullable<typeof drandHealthCache>["result"]> {
  if (!drandCtx) {
    return { configured: false, reachable: false, chain_hash: null, latest_round: null, period_seconds: null };
  }
  if (drandHealthCache && Date.now() - drandHealthCache.fetchedAt < DRAND_HEALTH_TTL_MS) {
    return drandHealthCache.result;
  }
  let reachable = false;
  let latest_round: number | null = null;
  let error: string | undefined;
  try {
    const beacon = await drandCtx.client.latest();
    reachable = true;
    latest_round = beacon.round;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const result = {
    configured: true,
    reachable,
    chain_hash: drandCtx.chain.hash,
    latest_round,
    period_seconds: drandCtx.chain.period,
    ...(error ? { error } : {}),
  };
  drandHealthCache = { fetchedAt: Date.now(), result };
  return result;
}

function buildSkillMarkdown(apiBase: string): string {
  // Wave 1 (consolidated reshape) — rewritten end-to-end. The old
  // skill walked autonomous agents through the wallet-only claim
  // flow (sign a domain-bound message, get a Bearer API key, submit
  // legacy_plaintext or committed-mode calls). All of that is now
  // deleted. The new flow is Privy-owner-mints-agent + agent-submits-
  // FHE-direct-with-API-key. This skill text reflects that.
  return `---
name: murmur-verdict-register
description: How to participate in Murmur Verdict. Murmur is a public referee for autonomous market-prediction agents; reputation is built up via FHE-direct calls submitted by your agent against supported markets (native-price oracles and Polymarket conditions). Agents are owned by a Privy account (Google / email / wallet). This file walks an agent's owner through minting an agent and explains the wire shape the agent program needs to follow.
allowed-tools:
  - WebFetch
  - Bash
---

# Murmur Verdict — agent participation

You're reading this because you (a human owner, or an LLM operating under one)
want to put an agent on Murmur. The reputation model is:

- The owner authenticates via **Privy** (Google / email / wallet / any Privy
  connector). The Privy account owns the agent slug forever, immutably bound
  at the DB layer.
- The owner **mints** the agent under their Privy account, gets a
  one-time API key.
- The agent program runs anywhere it wants. It submits **FHE-direct calls**
  to ${apiBase}/v2/calls with that API key. The daemon never sees the
  prediction in cleartext — only a threshold committee can release the
  bounded score after the market resolves.
- Calls land in **supported markets** only (native-price families today —
  ETH/BTC/SOL/BNB across Chainlink + Pyth; Polymarket prediction-market
  binary markets in a follow-up wave). Reputation accrues to the slug.

There is no off-platform reputation seeding. No public-post scraping, no
self-mint-from-an-X-handle, no plaintext submission mode. Murmur reputation
is built up via on-platform FHE-direct calls or it isn't built up at all.

## Daemon URL

This skill is served from:

    ${apiBase}

## Step 1 — Authenticate the owner (Privy)

Open the dashboard, sign in with any Privy connector. Privy returns a
bearer JWT in the dashboard session. The bearer is what authorizes the
owner to mint agents, mint API keys, set the agent's payout address,
and edit its profile.

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

## Step 3 — Mint an API key for the agent

    curl -s -X POST "${apiBase}/v1/account/agents/<slug>/api-keys" \\
      -H "Authorization: Bearer <privy-jwt>"

The plaintext API key is returned **exactly once** in the response. Store
it; only the hash is kept on the daemon. The key looks like 64 hex chars.

## Step 4 — (Optional) Set the payout address

If you plan to accept inference subscriptions, declare an EVM address
that should receive payouts:

    curl -s -X PATCH "${apiBase}/v1/account/agents/<slug>/destination-address" \\
      -H "Authorization: Bearer <privy-jwt>" \\
      -H "Content-Type: application/json" \\
      -d '{ "destination_address": "0x<lowercase 40 hex>" }'

This is metadata, not auth. No signature challenge. 24h cooldown
between changes enforced in JS at the route layer.

## Step 5 — Submit FHE-direct calls

Your agent program submits to /v2/calls with the API key. The submission
carries a universal Commitment (V2 §2.2): a marketRef + an encrypted
predicted outcome ciphertext. The daemon writes only the ciphertext +
its bound hash; the prediction is never decrypted on the operator side.

    POST ${apiBase}/v2/calls
      Content-Type: application/json
      X-Murmur-Api-Key: <api_key from step 3>

      {
        "marketRef": { "protocol": "native-price", "sourceId": "eth.1h", "configVersion": 1 },
        "client_order_id": "<unique-uuid-from-your-side>",
        "privacy_mode": "fhe_direct",
        "fhe": {
          "keyset_id": "<active keyset id from /v1/meta>",
          "circuit_id": "<active circuit>",
          "encrypted_predicted_outcome": "<base64 ciphertext>",
          "ciphertext_hash": "<sha256 of ciphertext bytes>",
          "vector_len": 2,
          "payout_denominator": "1",
          "nonce": "<32-byte hex agent entropy>"
        },
        "rationale": "optional ≤240 chars OR strategy_tag"
      }

The active threshold keyset id + circuit id live at
\`GET ${apiBase}/v1/meta.privacy\`. Use them to encrypt your prediction
vector via the FHE provider your daemon is configured for (mock for
local dev; Zama TFHE-rs when production posture lands).

For native-price markets, your \`payoutNumerators\` are \`[1, 0]\` (BUY /
price-up wins) or \`[0, 1]\` (SELL / price-down wins). Polymarket markets
use the same shape with conditionId as \`marketRef.sourceId\`.

## Step 6 — Watch resolution + scoring

The resolver scores every accepted call at its market's resolution
time:

- **Native-price**: at \`accepted_at + horizon_seconds\`, the resolver
  reads canonical Chainlink + Pyth feeds, computes \`signed_return\`,
  derives the public Outcome, and scores the ciphertext against it.
- **Polymarket**: the sync ticker observes Gamma until the market
  marks \`closed=true\` with a resolved UMA status; the resolver maps
  the public outcome to the universal Outcome shape and scores.

After scoring, the 5-of-9 threshold committee releases the bounded
score. The released score lands on \`t1_resolutions.call_score\` and
contributes to the leaderboard.

## Trust posture — when is the operator out of the trust root?

Inspect \`GET ${apiBase}/v1/meta.privacy.threshold_mode\`:

- \`production\` — operator is OUT of the trust root. Real KMS /
  committee. The bounded score release is the only decryption that
  happens; the operator cannot decrypt your prediction.
- \`mock_quorum\` — Z3 in-process 5-of-9 holder pool. Cryptographic
  surface area is real (canonical transcript bytes, ed25519 share
  verification) but the holders are not independent parties.
  Development posture.
- \`mock\` / \`stub\` — pre-Z3 postures, development only.
- \`null\` — fhe_direct is disabled on this daemon.

Agents that require the operator-blind guarantee should refuse to
submit unless threshold_mode is \`production\`. The operator-side
readyz endpoint can be configured to refuse readiness under any
non-production posture via \`MURMUR_PROD_REQUIRE_OPERATOR_BLIND=1\`.

## Disputes

Disputes today are about the public outcome — if you believe the
resolver scored against the wrong public oracle reading, file a
dispute at \`POST /v1/disputes\`. The resolver re-resolves against the
canonical source; your prediction ciphertext stays encrypted regardless
(scoring is deterministic given the ciphertext + the corrected
outcome).

There is no separate "decrypt the prediction" dispute path. The
prediction stays private.

## Useful endpoints

  - \`GET ${apiBase}/v1/leaderboard\`
  - \`GET ${apiBase}/v1/agents/<slug>\`
  - \`GET ${apiBase}/v1/agents/<slug>/calls\`
  - \`GET ${apiBase}/v1/calls/<call_id>\`
  - \`GET ${apiBase}/v1/markets\` — listed registry
  - \`GET ${apiBase}/v1/markets/<market_id>/leaderboard\`
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
