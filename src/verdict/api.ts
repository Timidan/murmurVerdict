import { Router, type Request, type Response, type NextFunction } from "express";
import express from "express";
import type Database from "better-sqlite3";
import {
  agentsRepo,
  callRevealsRepo,
  claimsRepo,
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

  // claim_challenges GC — every 5 min, expire pending rows past their
  // expires_at and delete settled rows older than 7 days. Keeps the
  // table from accumulating dead state under wallet-only init traffic.
  // unref() so the timer doesn't keep the process alive at shutdown.
  const GC_INTERVAL_MS = 5 * 60 * 1000;
  const GC_KEEP_DAYS = 7;
  setInterval(() => {
    try {
      const n = now();
      const nowIso = n.toISOString().replace(/\.\d+Z$/, "Z");
      const keepSinceIso = new Date(n.getTime() - GC_KEEP_DAYS * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace(/\.\d+Z$/, "Z");
      claimsRepo.gc(deps.db, nowIso, keepSinceIso);
    } catch {
      // GC is best-effort — never let a sweep error crash the daemon.
    }
  }, GC_INTERVAL_MS).unref();

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

      // Casual tier: privacy_mode locked to legacy_plaintext or
      // fhe_direct (Z1). Committed mode still requires wallet binding
      // (Phase 8); fhe_direct intentionally permits the casual tier
      // because the cryptographic privacy stack does not require
      // a verified wallet — the agent encrypts client-side against
      // the keyset's public key.
      if (
        authResult.tier === "casual" &&
        body.privacy_mode !== undefined &&
        body.privacy_mode !== "legacy_plaintext" &&
        body.privacy_mode !== "fhe_direct"
      ) {
        throw new VerdictError(
          "casual tier accepts privacy_mode ∈ {'legacy_plaintext', 'fhe_direct'} on /v2/calls (committed mode requires Phase 8 wallet auth)",
          ERROR_CODES.schema_invalid,
          400,
          { tier: authResult.tier, privacy_mode: body.privacy_mode },
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

      // Z1 — operator-blind submission. Route fhe_direct through the
      // dedicated path before the legacy bridge; the wire shape is
      // fundamentally different (no plaintext predictedOutcome /
      // horizon / confidence) and forcing it through the legacy
      // SubmittedCallSchema would either reject every submit OR leak
      // synthetic plaintext into projections.
      if (body.privacy_mode === "fhe_direct") {
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
          fheDirect: { fhe: body.fhe!, market_id: market.market_id },
        });
        res.status(fheResult.idempotent_hit ? 200 : 201).json({
          call_id: fheResult.call.call_id,
          // Operator-blind response: do not echo the synthesized
          // placeholder side/confidence the AcceptedCall carries; the
          // submitFheDirectCall path already nulls these in the return,
          // but we filter explicitly here in case a future refactor
          // forgets.
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
        return;
      }

      // Adapter-narrow validation. native-price's commitmentSchema today
      // accepts the LEGACY direction-input shape (asset_id|market_id +
      // side + horizon_hours), NOT the universal Commitment. Phase 4
      // bypasses that transform — we already have a canonical Commitment
      // from CommitmentSchema above; we just normalize the runtime shape.
      const v2Commitment: Commitment = {
        marketRef: body.marketRef,
        predictedOutcome: {
          kind: body.predictedOutcome!.kind,
          payoutNumerators: body.predictedOutcome!.payoutNumerators.map(
            (s) => BigInt(s),
          ),
          payoutDenominator: BigInt(body.predictedOutcome!.payoutDenominator),
          ...(body.predictedOutcome!.scalarValue !== undefined
            ? { scalarValue: BigInt(body.predictedOutcome!.scalarValue) }
            : {}),
        },
        horizon: body.horizon!,
        confidence: body.confidence!,
      };

      // Bridge to the legacy submitCall pipeline. The Phase 5 universal
      // hot path reads from `commitment_json` regardless of submit
      // surface; we still produce a legacy SubmittedCall here so the
      // existing dedup / rate-limit / preflight code lights up unchanged.
      const side = derivePayoutSide(v2Commitment.predictedOutcome.payoutNumerators);
      if (!side) {
        throw new VerdictError(
          "v2 native-price predictedOutcome must reduce to BUY ([1,0]) or SELL ([0,1]); got " +
            JSON.stringify(body.predictedOutcome!.payoutNumerators),
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      // Confidence: native-price submitCall narrows to [0.51, 0.95] via
      // SubmittedCallSchema. The universal Commitment range is [0,1] so
      // a casual caller submitting confidence < 0.51 would be rejected
      // by the schema. We let SubmittedCallSchema do that — single
      // validation point.
      const submittedAt =
        body.submitted_at ?? now().toISOString().replace(/\.\d+Z$/, "Z");
      const legacyPayload: Record<string, unknown> = {
        schema_version: SCHEMA_VERSION,
        agent_id: authResult.agent_id,
        client_order_id: body.client_order_id,
        market_id: market.market_id,
        side,
        confidence: body.confidence!,
        submitted_at: submittedAt,
        rationale: body.rationale,
        strategy_tag: body.strategy_tag,
      };
      if (body.privacy_mode) {
        legacyPayload.privacy_mode = body.privacy_mode;
      }

      const result = await submitCall({
        db: deps.db,
        ctx: deps.ctx,
        identity: { agent_id: authResult.agent_id },
        payload: legacyPayload,
        precomputedCommitment: v2Commitment,
        outcomeLabels: ["UP", "DOWN"],
      });
      const httpStatus = result.idempotent_hit ? 200 : 200;
      // V2 response shape per the brief: { call_id, call }. Wave 4b dropped
      // the receipts subsystem; downstream consumers chain on call_id.
      res.status(httpStatus).json({
        call_id: result.call.call_id,
        call: result.call,
        idempotent_hit: result.idempotent_hit,
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
    // Phase G H1/M2 — surface privacy-stack status without doing the
    // expensive drand round-trip. /v1/readyz does the actual probes;
    // /v1/health is cheap.
    const privacy = {
      committed_mode_open: process.env.MURMUR_PRIVACY_COMMITTED_OPEN === "1",
      age_recipient_configured: !!deps.ctx.ageContext,
      age_fallback_decrypt: !!deps.ctx.ageContext?.identity,
      drand_configured: !!deps.ctx.drandContext,
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
    // Z0 — extend with an `fhe` sub-block so operators can tell at a
    // glance whether the operator-blind path is wired. `provider`,
    // `active_keyset_id`, and `threshold_mode` mirror the /v1/meta
    // shape so SDKs read both surfaces consistently. We do NOT fail
    // /readyz on a `mock` threshold_mode here — that gate ships in
    // Z5 (MURMUR_PROD_REQUIRE_OPERATOR_BLIND).
    const fheEnabled = process.env.MURMUR_FHE_DIRECT_ENABLED === "1";
    const fheProv = deps.ctx.fheProvider ?? null;
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
    const privacy = {
      committed_mode_open: process.env.MURMUR_PRIVACY_COMMITTED_OPEN === "1",
      age: {
        recipient_configured: !!deps.ctx.ageContext,
        fallback_decrypt_enabled: !!deps.ctx.ageContext?.identity,
        daemon_key_id: deps.ctx.ageContext?.daemon_key_id ?? null,
      },
      drand: await probeDrandHealth(deps.ctx.drandContext),
      fhe_direct_enabled: fheEnabled,
      provider: fheProv?.name ?? null,
      active_keyset_id: fheActiveKeysetId,
      threshold_mode: fheProv?.threshold_mode ?? null,
    };

    const ready = dbOk && (oracleStatus === "ok" || oracleStatus === "disabled");
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
    // it's null when the flag is off OR when the chosen provider has
    // no keyset in `status='active'` yet (zama_local stub seeds in
    // `pending`).
    const fheEnabled = process.env.MURMUR_FHE_DIRECT_ENABLED === "1";
    const fheProv = deps.ctx.fheProvider ?? null;
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
      // adds 'fhevm' to submission_modes; v0.2 ships commit_reveal.
      privacy: {
        submission_modes: ["committed", "legacy_plaintext"],
        commit_scheme: "murmur-verdict-v0.2-commit@1",
        commit_alg: "keccak256",
        envelope_alg: "age-x25519-v1",
        trustless_reveal: !!deps.ctx.drandContext,
        trustless_reveal_alg: deps.ctx.drandContext
          ? "drand-tlock-bls-unchained-g1-rfc9380@1"
          : null,
        operator_can_decrypt_pre_horizon: !!deps.ctx.ageContext?.identity,
        public_envelope_endpoint: `${apiBase}/v1/calls/{call_id}/envelope`,
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
    const rawRows = deps.db
      .prepare(
        `SELECT s.call_id, s.status, s.asset_id, s.side, s.horizon_hours,
                s.confidence, s.rationale, s.strategy_tag,
                s.submitted_at, s.accepted_at,
                s.privacy_mode, s.commit_hash,
                r.outcome, r.call_score, r.signed_return, r.resolved_at,
                cr.reveal_hash_valid,
                cr.side          AS revealed_side,
                cr.asset_id      AS revealed_asset_id,
                cr.horizon_hours AS revealed_horizon_hours,
                cr.confidence    AS revealed_confidence,
                cr.rationale     AS revealed_rationale,
                cr.strategy_tag  AS revealed_strategy_tag
         FROM submissions s
         LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
         LEFT JOIN call_reveals cr ON cr.call_id = s.call_id
         WHERE s.agent_id = ?
         ORDER BY s.accepted_at DESC
         LIMIT ?`,
      )
      .all(agent.agent_id, limit) as Array<Record<string, unknown>>;
    // Phase E: scrub plaintext on committed-mode pending rows; hydrate
    // post-scrub committed rows from call_reveals when reveal_hash_valid=1.
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
          side: row.side as string | null,
          asset_id: row.asset_id as string | null,
          horizon_hours: row.horizon_hours as number | null,
          confidence: row.confidence as number | null,
          rationale: row.rationale as string | null,
          strategy_tag: row.strategy_tag as string | null,
          outcome: row.outcome as string | null,
          call_score: row.call_score as number | null,
          signed_return: row.signed_return as string | null,
          resolved_at: row.resolved_at as string | null,
          submitted_at: row.submitted_at as string | null,
          reveal_hash_valid: row.reveal_hash_valid as number | null,
          revealed_side: row.revealed_side as string | null,
          revealed_asset_id: row.revealed_asset_id as string | null,
          revealed_horizon_hours: row.revealed_horizon_hours as number | null,
          revealed_confidence: row.revealed_confidence as number | null,
          revealed_rationale: row.revealed_rationale as string | null,
          revealed_strategy_tag: row.revealed_strategy_tag as string | null,
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
    const raw = deps.db
      .prepare(
        `SELECT s.call_id, s.status, s.asset_id, s.side, s.horizon_hours,
                s.confidence, s.submitted_at, s.accepted_at,
                s.privacy_mode, s.commit_hash,
                cr.reveal_hash_valid,
                cr.side          AS revealed_side,
                cr.asset_id      AS revealed_asset_id,
                cr.horizon_hours AS revealed_horizon_hours,
                cr.confidence    AS revealed_confidence,
                r.outcome, r.call_score, r.signed_return, r.resolved_at
         FROM submissions s
         LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
         LEFT JOIN call_reveals cr ON cr.call_id = s.call_id
         WHERE s.agent_id = ?
         ORDER BY s.accepted_at DESC
         LIMIT ?`,
      )
      .all(agent.agent_id, limit) as Array<Record<string, unknown>>;
    // Phase E: committed-mode rows render as "[committed]" until a valid
    // reveal row exists, without leaking side/asset/horizon. Once revealed
    // (reveal_hash_valid=1) the projection hydrates from cr.* columns.
    const rows = raw.map((r) => {
      const projected = projectCallRow({
        call_id: r.call_id as string,
        status: r.status as string,
        accepted_at: r.accepted_at as string,
        privacy_mode: r.privacy_mode as string | null,
        commit_hash: r.commit_hash as string | null,
        side: r.side as string | null,
        asset_id: r.asset_id as string | null,
        horizon_hours: r.horizon_hours as number | null,
        confidence: r.confidence as number | null,
        submitted_at: r.submitted_at as string | null,
        reveal_hash_valid: r.reveal_hash_valid as number | null,
        revealed_side: r.revealed_side as string | null,
        revealed_asset_id: r.revealed_asset_id as string | null,
        revealed_horizon_hours: r.revealed_horizon_hours as number | null,
        revealed_confidence: r.revealed_confidence as number | null,
      });
      return {
        call_id: projected.call_id,
        status: projected.status,
        privacy_mode: projected.privacy_mode,
        commit_hash: projected.commit_hash,
        asset_id: projected.asset_id ?? "",
        side: (projected.side as "BUY" | "SELL" | undefined) ?? "BUY",
        horizon_hours: projected.horizon_hours ?? 0,
        confidence: projected.confidence ?? 0,
        submitted_at: projected.submitted_at ?? "",
        is_committed_scrubbed: projected.side === undefined,
        accepted_at: projected.accepted_at,
        outcome: r.outcome as string | null,
        call_score: r.call_score as number | null,
        signed_return: r.signed_return as string | null,
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
  router.post(
    "/v1/calls/:call_id/reveal",
    json,
    asyncHandler(async (req, res) => {
      const call_id = String(req.params.call_id ?? "");
      // Auth: Bearer only on this endpoint (no HMAC). Wallet-only +
      // verified agents both authenticate via X-Murmur-Api-Key.
      const apiKey = req.header("X-Murmur-Api-Key");
      const agentIdHdr = req.header("X-Murmur-Agent-Id");
      if (!apiKey || !agentIdHdr) {
        throw new VerdictError(
          "X-Murmur-Agent-Id + X-Murmur-Api-Key required",
          ERROR_CODES.agent_not_authorized,
          401,
        );
      }
      const identity = verifyAgentApiKey(deps.db, agentIdHdr, apiKey);

      const subRow = deps.db
        .prepare(
          `SELECT s.call_id, s.agent_id, s.privacy_mode, s.commit_hash, s.accepted_at,
                  s.market_id, s.market_config_version,
                  a.wallet_address AS agent_wallet,
                  a.chain_id       AS agent_chain_id
           FROM submissions s
           LEFT JOIN agents a ON a.agent_id = s.agent_id
           WHERE s.call_id = ?`,
        )
        .get(call_id) as
        | {
            call_id: string;
            agent_id: string;
            privacy_mode: string | null;
            commit_hash: string | null;
            accepted_at: string;
            // P4 Item 4: pulled to cross-check the agent's preimage
            // claim against what the daemon stamped at acceptance.
            market_id: string | null;
            market_config_version: number | null;
            // Wave 4b — agent wallet binding pulled directly from the
            // agents row (receipts subsystem gone; nothing else is the
            // canonical source for the agent's wallet).
            agent_wallet: string | null;
            agent_chain_id: string | null;
          }
        | undefined;
      if (!subRow) {
        throw new VerdictError("call not found", ERROR_CODES.unknown_agent, 404);
      }
      if (subRow.agent_id !== identity.agent_id) {
        throw new VerdictError(
          "call not owned by authenticated agent",
          ERROR_CODES.agent_not_authorized,
          403,
        );
      }
      if (subRow.privacy_mode !== "committed" || !subRow.commit_hash) {
        throw new VerdictError(
          "call is not committed-mode (no preimage to reveal)",
          ERROR_CODES.schema_invalid,
          409,
        );
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawPreimage = body.commit_preimage;
      if (!rawPreimage || typeof rawPreimage !== "object") {
        throw new VerdictError(
          "commit_preimage object required",
          ERROR_CODES.schema_invalid,
          400,
        );
      }

      // P3 Phase 1.5: dispatch on the stored preimage schema. v0.2 commits
      // bind (asset_id, horizon_hours); v0.2.5 commits bind (market_id,
      // market_config_version). The daemon recorded which schema it used
      // on the call_private_envelopes row at submit time.
      //
      // Hardening (Codex audit P3 1.5): unknown stored schema fails
      // closed — never default to legacy. Validation runs through the
      // strict Zod schema (parseAndRebuildPreimageObject) so malformed
      // agent inputs land as named errors instead of being papered over
      // by lossy String()/Number() coercion.
      const envSchemaRow = deps.db
        .prepare(
          `SELECT commit_preimage_schema FROM call_private_envelopes WHERE call_id = ?`,
        )
        .get(call_id) as { commit_preimage_schema: string } | undefined;
      const storedSchema = envSchemaRow?.commit_preimage_schema;
      if (
        storedSchema !== COMMIT_PREIMAGE_SCHEMA &&
        storedSchema !== MARKET_COMMIT_PREIMAGE_SCHEMA
      ) {
        throw new VerdictError(
          storedSchema
            ? `unsupported preimage schema on envelope: ${storedSchema}`
            : "no preimage schema recorded for this call",
          ERROR_CODES.internal_error,
          500,
        );
      }

      // Lowercase the wallet + salt before validation — the daemon stored
      // the commit over the lowercase form (see submitCall F4); agents
      // sending uppercase get normalized once at the edge.
      const preimageInputRaw = rawPreimage as Record<string, unknown>;
      const preimageInput: Record<string, unknown> = {
        ...preimageInputRaw,
        agent_wallet:
          typeof preimageInputRaw.agent_wallet === "string"
            ? preimageInputRaw.agent_wallet.toLowerCase()
            : preimageInputRaw.agent_wallet,
        salt:
          typeof preimageInputRaw.salt === "string"
            ? preimageInputRaw.salt.toLowerCase()
            : preimageInputRaw.salt,
      };

      const validated = parseAndRebuildPreimageObject(
        preimageInput,
        storedSchema,
      );
      if (!validated) {
        throw new VerdictError(
          "commit_preimage malformed or wrong schema",
          ERROR_CODES.schema_invalid,
          400,
          { expected_schema: storedSchema },
        );
      }

      // Cross-checks that don't fit in the Zod schema (would couple it to
      // call-specific runtime state). Hash-only would catch them, but
      // explicit messages beat hash-mismatch for misbehaving agents.
      if (validated.preimage.call_id !== call_id) {
        throw new VerdictError(
          "commit_preimage.call_id does not match URL",
          ERROR_CODES.schema_invalid,
          422,
        );
      }
      if (validated.preimage.t0 !== subRow.accepted_at) {
        throw new VerdictError(
          "commit_preimage.t0 does not match daemon-canonical accepted_at",
          ERROR_CODES.schema_invalid,
          422,
        );
      }

      let revealSide: "BUY" | "SELL";
      let revealConfidence: number;
      let revealSalt: string;
      let revealT0: string;
      let revealAssetId: string;
      let revealHorizonHours: number;
      let revealAgentWallet: string;
      let revealChainId: string;

      if (validated.kind === "market") {
        // P4 Item 4 (Codex audit): validate the agent's preimage market_id
        // + market_config_version against the SUBMISSION ROW (what the
        // daemon stamped at acceptance), not the live markets registry.
        // A live-registry-only check would let an agent reveal under a
        // post-bumpConfig version that wasn't what the daemon committed
        // to at submit time — silent policy substitution.
        if (
          subRow.market_id !== validated.preimage.market_id ||
          subRow.market_config_version !==
            validated.preimage.market_config_version
        ) {
          throw new VerdictError(
            "commit_preimage.market_id / market_config_version do not match the submission row",
            ERROR_CODES.schema_invalid,
            422,
            {
              expected_market_id: subRow.market_id,
              expected_market_config_version: subRow.market_config_version,
              got_market_id: validated.preimage.market_id,
              got_market_config_version:
                validated.preimage.market_config_version,
            },
          );
        }
        // For asset_id synthesis on the call_reveals row, the historical
        // snapshot at the stamped version is the right source — never
        // the live row (might have drifted via bumpConfig). Fall back
        // to live registry only if history is missing (shouldn't happen
        // for any post-migration-012 row).
        const histSnapshot =
          subRow.market_id !== null && subRow.market_config_version !== null
            ? marketsRepo.getConfigAt(
                deps.db,
                subRow.market_id,
                subRow.market_config_version,
              )
            : null;
        const market = histSnapshot ?? marketsRepo.get(deps.db, validated.preimage.market_id);
        if (!market) {
          throw new VerdictError(
            `commit_preimage.market_id ${validated.preimage.market_id} not in registry or history`,
            ERROR_CODES.asset_not_supported,
            422,
          );
        }
        revealSide = validated.preimage.side;
        revealConfidence = validated.preimage.confidence;
        revealSalt = validated.preimage.salt;
        revealT0 = validated.preimage.t0;
        revealAssetId = market.asset_id;
        // Synthesize legacy-shape horizon_hours for the call_reveals row.
        // Sub-hour markets give horizon_hours=0; harmless today since
        // those markets aren't 'listed' yet (Phase 2 territory).
        // Codex follow-up F2: explicit fail-closed mapping. Replaces
        // Math.round(market.horizon_seconds / 3600). For seeded markets
        // the values match; for arbitrary future horizons this throws
        // instead of silently choosing the wrong sentinel.
        revealHorizonHours = legacyHorizonHoursForMarket(market as MarketRow);
        revealAgentWallet = validated.preimage.agent_wallet;
        revealChainId = validated.preimage.chain_id;
      } else {
        revealSide = validated.preimage.side;
        revealConfidence = validated.preimage.confidence;
        revealSalt = validated.preimage.salt;
        revealT0 = validated.preimage.t0;
        revealAssetId = validated.preimage.asset_id;
        revealHorizonHours = validated.preimage.horizon_hours;
        revealAgentWallet = validated.preimage.agent_wallet;
        revealChainId = validated.preimage.chain_id;
      }

      const recomputed = validated.hash;
      const preimageCanonical = validated.canonical;

      // Wallet binding cross-check is independent of the preimage schema.
      // Wave 4b: receipts table is gone — pull the agent's wallet binding
      // directly from the agents row instead. Same trust boundary
      // (admin-rotated wallet on the agent IS the authoritative binding
      // for any committed call this agent owns).
      if (!subRow.agent_wallet || !subRow.agent_chain_id) {
        throw new VerdictError(
          "committed-mode call agent is missing a wallet binding",
          ERROR_CODES.schema_invalid,
          409,
        );
      }
      if (
        revealAgentWallet !== subRow.agent_wallet ||
        revealChainId !== subRow.agent_chain_id
      ) {
        throw new VerdictError(
          "commit_preimage wallet/chain_id does not match the agent binding",
          ERROR_CODES.schema_invalid,
          422,
        );
      }
      if (recomputed.toLowerCase() !== subRow.commit_hash.toLowerCase()) {
        throw new VerdictError(
          "commit_preimage hash does not match stored commit_hash (commit_mismatch)",
          ERROR_CODES.schema_invalid,
          422,
        );
      }

      const revealed_at = nowIso(now());
      const rationale =
        typeof body.rationale === "string" && body.rationale.length > 0
          ? body.rationale.slice(0, 240)
          : null;
      const strategy_tag =
        typeof body.strategy_tag === "string" && body.strategy_tag.length > 0
          ? body.strategy_tag.slice(0, 64)
          : null;
      const revealRow: CallRevealRow = {
        call_id,
        side: revealSide,
        asset_id: revealAssetId,
        horizon_hours: revealHorizonHours,
        confidence: revealConfidence,
        rationale,
        strategy_tag,
        salt: revealSalt,
        t0: revealT0,
        agent_wallet: revealAgentWallet,
        chain_id: revealChainId,
        commit_preimage_json: preimageCanonical,
        commit_preimage_hash: recomputed,
        revealed_at,
        revealed_via: "agent",
        reveal_hash_valid: 1,
      };

      // Idempotency: existing call_reveals row with identical preimage
      // hash is a no-op replay. Any other shape is a conflict.
      const existing = callRevealsRepo.byCallId(deps.db, call_id);
      if (existing) {
        if (existing.reveal_hash_valid === 0) {
          repairInvalidReveal(deps.db, revealRow);
          res.status(200).json({
            call_id,
            revealed_via: "agent",
            revealed_at,
            reveal_hash_valid: true,
            commit_hash: subRow.commit_hash,
            note: "repaired_invalid_reveal",
          });
          return;
        }
        if (
          existing.commit_preimage_hash &&
          existing.commit_preimage_hash.toLowerCase() === recomputed.toLowerCase()
        ) {
          res.status(200).json({
            call_id,
            revealed_via: existing.revealed_via,
            revealed_at: existing.revealed_at,
            reveal_hash_valid: true,
            commit_hash: subRow.commit_hash,
            note: "idempotent_replay",
          });
          return;
        }
        throw new VerdictError(
          "call already revealed with a different preimage",
          ERROR_CODES.duplicate,
          409,
        );
      }

      try {
        callRevealsRepo.insert(deps.db, revealRow);
      } catch (err) {
        const raced = callRevealsRepo.byCallId(deps.db, call_id);
        if (raced?.reveal_hash_valid === 0) {
          repairInvalidReveal(deps.db, revealRow);
          res.status(200).json({
            call_id,
            revealed_via: "agent",
            revealed_at,
            reveal_hash_valid: true,
            commit_hash: subRow.commit_hash,
            note: "repaired_invalid_reveal_race",
          });
          return;
        }
        if (
          raced?.commit_preimage_hash &&
          raced.commit_preimage_hash.toLowerCase() === recomputed.toLowerCase()
        ) {
          res.status(200).json({
            call_id,
            revealed_via: raced.revealed_via,
            revealed_at: raced.revealed_at,
            reveal_hash_valid: raced.reveal_hash_valid === 1,
            commit_hash: subRow.commit_hash,
            note: "idempotent_race",
          });
          return;
        }
        throw err;
      }

      res.status(201).json({
        call_id,
        revealed_via: "agent",
        revealed_at,
        reveal_hash_valid: true,
        commit_hash: subRow.commit_hash,
      });
    }),
  );

  // ── Public envelope read (Phase B-3 + Codex F1) ──────────────────────
  // Returns the encrypted ciphertexts + commit metadata for a committed-
  // mode call. The whole point of the drand commitment is daemon-less
  // reveal: anyone with this endpoint's payload + the receipt's
  // drand.ciphertext_hash can verify the bytes match what the daemon
  // committed to, then run tlock-decrypt with the released drand
  // beacon for the bound round. No daemon trust required past round-
  // emission time.
  //
  // For non-committed (legacy_plaintext) calls, returns 404 — there's
  // no envelope.
  router.get("/v1/calls/:call_id/envelope", (req, res) => {
    const call_id = String(req.params.call_id ?? "");
    const subRow = deps.db
      .prepare(
        `SELECT call_id, privacy_mode, commit_hash, commit_scheme
         FROM submissions WHERE call_id = ?`,
      )
      .get(call_id) as
      | {
          call_id: string;
          privacy_mode: string | null;
          commit_hash: string | null;
          commit_scheme: string | null;
        }
      | undefined;
    if (!subRow) {
      res.status(404).json({ code: "not_found", message: "call not found" });
      return;
    }
    if (subRow.privacy_mode !== "committed") {
      res.status(404).json({
        code: "no_envelope",
        message: "call is not committed-mode (no envelope)",
      });
      return;
    }
    const envRow = deps.db
      .prepare(
        `SELECT encrypted_body, encrypted_body_alg, encrypted_body_hash,
                daemon_key_id, commit_preimage_schema, fallback_after,
                received_at,
                drand_chain_hash, drand_round, drand_ciphertext, drand_ciphertext_hash
         FROM call_private_envelopes WHERE call_id = ?`,
      )
      .get(call_id) as
      | {
          encrypted_body: string;
          encrypted_body_alg: string;
          encrypted_body_hash: string;
          daemon_key_id: string;
          commit_preimage_schema: string;
          fallback_after: string | null;
          received_at: string;
          drand_chain_hash: string | null;
          drand_round: number | null;
          drand_ciphertext: string | null;
          drand_ciphertext_hash: string | null;
        }
      | undefined;
    if (!envRow) {
      res.status(404).json({
        code: "envelope_missing",
        message: "envelope row not found for committed call",
      });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      schema_version: SCHEMA_VERSION,
      call_id: subRow.call_id,
      privacy_mode: subRow.privacy_mode,
      commit: {
        hash: subRow.commit_hash,
        scheme: subRow.commit_scheme,
        preimage_schema: envRow.commit_preimage_schema,
      },
      // age envelope — daemon-trusted decrypt path past fallback_after.
      // Anyone holding the daemon's age identity can decrypt at any time;
      // listed here for completeness so a verifier can attest the
      // ciphertext bytes match the receipt's `fallback.encrypted_body_hash`.
      age: {
        encrypted_body: envRow.encrypted_body,
        encrypted_body_alg: envRow.encrypted_body_alg,
        encrypted_body_hash: envRow.encrypted_body_hash,
        daemon_key_id: envRow.daemon_key_id,
        fallback_after: envRow.fallback_after,
      },
      // drand timelock — daemon-LESS decrypt path. Anyone past the
      // bound round can fetch the drand beacon and decrypt without
      // operator cooperation. Null when drand was disabled at submit.
      drand:
        envRow.drand_chain_hash &&
        envRow.drand_round !== null &&
        envRow.drand_ciphertext
          ? {
              chain_hash: envRow.drand_chain_hash,
              round: envRow.drand_round,
              ciphertext: envRow.drand_ciphertext,
              ciphertext_hash: envRow.drand_ciphertext_hash,
            }
          : null,
      received_at: envRow.received_at,
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
    // committed call lacks a valid reveal row. The acceptance receipt on
    // the same response never carries plaintext for v2 by construction.
    // Hydration: forward cr.* mirror columns so post-Phase-E committed
    // rows still render side/asset/horizon/confidence from call_reveals.
    const subRow = deps.db
      .prepare(
        `SELECT s.privacy_mode, s.commit_hash, cr.reveal_hash_valid,
                cr.side          AS revealed_side,
                cr.asset_id      AS revealed_asset_id,
                cr.horizon_hours AS revealed_horizon_hours,
                cr.confidence    AS revealed_confidence,
                cr.rationale     AS revealed_rationale,
                cr.strategy_tag  AS revealed_strategy_tag
         FROM submissions s
         LEFT JOIN call_reveals cr ON cr.call_id = s.call_id
         WHERE s.call_id = ?`,
      )
      .get(call_id) as
      | {
          privacy_mode: string | null;
          commit_hash: string | null;
          reveal_hash_valid: number | null;
          revealed_side: string | null;
          revealed_asset_id: string | null;
          revealed_horizon_hours: number | null;
          revealed_confidence: number | null;
          revealed_rationale: string | null;
          revealed_strategy_tag: string | null;
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
      side: full.submission.side,
      asset_id: full.submission.asset_id,
      horizon_hours: full.submission.horizon_hours,
      confidence: full.submission.confidence,
      rationale: full.submission.rationale,
      strategy_tag: full.submission.strategy_tag,
      submitted_at: full.submission.submitted_at,
      reveal_hash_valid: subRow?.reveal_hash_valid ?? null,
      revealed_side: subRow?.revealed_side ?? null,
      revealed_asset_id: subRow?.revealed_asset_id ?? null,
      revealed_horizon_hours: subRow?.revealed_horizon_hours ?? null,
      revealed_confidence: subRow?.revealed_confidence ?? null,
      revealed_rationale: subRow?.revealed_rationale ?? null,
      revealed_strategy_tag: subRow?.revealed_strategy_tag ?? null,
    });
    const scrubbedSubmission = {
      call_id: full.submission.call_id,
      agent_id: full.submission.agent_id,
      client_order_id: full.submission.client_order_id,
      accepted_at: full.submission.accepted_at,
      status: full.submission.status,
      privacy_mode: projected.privacy_mode,
      commit_hash: projected.commit_hash,
      // Only present when shouldExposePlaintext returned true.
      ...(projected.side ? { side: projected.side } : {}),
      ...(projected.asset_id ? { asset_id: projected.asset_id } : {}),
      ...(projected.horizon_hours !== undefined
        ? { horizon_hours: projected.horizon_hours }
        : {}),
      ...(projected.confidence !== undefined
        ? { confidence: projected.confidence }
        : {}),
      ...(projected.rationale ? { rationale: projected.rationale } : {}),
      ...(projected.strategy_tag ? { strategy_tag: projected.strategy_tag } : {}),
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
        origin: `${req.protocol}://${req.get("host")}`,
        now,
      });
      res.status(201).json(result);
    }),
  );

  // ── Wallet-only claim flow ──
  // Self-onboarding for autonomous agents: no X/Telegram identity required.
  // The agent picks a slug, signs the canonical claim message with its
  // wallet, and gets back an API key bound to (slug, wallet). The agent
  // ends up as kind="wallet_only" — visible on the leaderboard alongside
  // verified+benchmark agents but distinguishable in the UI. See
  // src/verdict/claim.ts for the per-method docs.
  //
  // Rate limits: in-memory token bucket per (IP, wallet, slug). Hard cap
  // of one pending challenge per (slug, wallet) is enforced inside the
  // claim service via claimsRepo.countPendingForWalletAndAgent. The
  // in-memory limiter blocks the burst case before we even hit the DB.
  router.post(
    "/v1/agents/:slug/claim/wallet-only/init",
    json,
    asyncHandler(async (req, res) => {
      const slugRaw = String(req.params.slug ?? "");
      // Validate the slug shape at the API edge — claim.ts assumes it's
      // already conformant. AgentSlugSchema enforces 3-32 chars,
      // lowercase, no double-dashes, no leading/trailing dashes.
      const slugParse = AgentSlugSchema.safeParse(slugRaw);
      if (!slugParse.success) {
        throw new VerdictError(
          "slug must be 3-32 lowercase alphanumeric chars with single dashes between segments",
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      const slug = slugParse.data;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const walletRaw = body.wallet_to_bind;
      if (typeof walletRaw !== "string" || walletRaw.length === 0) {
        throw new VerdictError(
          "wallet_to_bind is required",
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      const chainIdRaw = body.chain_id;
      let chain_id: string | undefined;
      if (typeof chainIdRaw === "string" && chainIdRaw.length > 0) {
        const cid = ChainIdSchema.safeParse(chainIdRaw);
        if (!cid.success) {
          throw new VerdictError(
            "chain_id must be CAIP-2 (e.g. eip155:8453)",
            ERROR_CODES.schema_invalid,
            400,
          );
        }
        chain_id = cid.data;
      }
      const display_name =
        typeof body.display_name === "string" && body.display_name.length > 0
          ? body.display_name.slice(0, 64)
          : undefined;

      // Per-IP rate limit (in-memory).
      const ip = readClientIp(req);
      if (!walletOnlyInitLimiter.allow({ ip, slug, wallet: walletRaw.toLowerCase() })) {
        throw new VerdictError(
          "rate limited; back off and retry",
          ERROR_CODES.agent_not_authorized,
          429,
        );
      }

      const result = await claim.walletOnlyInit({
        display_slug: slug,
        wallet_to_bind: walletRaw as `0x${string}`,
        ...(display_name ? { display_name } : {}),
        ...(chain_id ? { chain_id } : {}),
        origin: `${req.protocol}://${req.get("host")}`,
        now,
      });
      res.status(201).json(result);
    }),
  );

  router.post(
    "/v1/agents/:slug/claim/wallet-only/finalize",
    json,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const challenge_id = body.challenge_id as string | undefined;
      const signature = body.signature as `0x${string}` | undefined;
      if (!challenge_id || !signature) {
        throw new VerdictError(
          "challenge_id and signature are required",
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      const chainIdRaw = body.chain_id;
      let chain_id: string | undefined;
      if (typeof chainIdRaw === "string" && chainIdRaw.length > 0) {
        const cid = ChainIdSchema.safeParse(chainIdRaw);
        if (!cid.success) {
          throw new VerdictError(
            "chain_id must be CAIP-2 (e.g. eip155:8453)",
            ERROR_CODES.schema_invalid,
            400,
          );
        }
        chain_id = cid.data;
      }
      const result = await claim.walletOnlyFinalize({
        challenge_id,
        signature,
        ...(chain_id ? { chain_id } : {}),
        origin: `${req.protocol}://${req.get("host")}`,
        now,
      });
      res.status(200).json(result);
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
        origin: `${req.protocol}://${req.get("host")}`,
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

const V2SubmissionBodySchema = z
  .object({
    // Inline mirror of CommitmentSchema fields rather than `.merge` so
    // .strict() catches typos like `marketref` / `predicted_outcome`.
    // Z1: marketRef stays required for both modes (the route still needs
    // to know which adapter / market the call targets). predictedOutcome
    // / horizon / confidence become OPTIONAL because fhe_direct hides
    // them inside the encrypted blob.
    marketRef: CommitmentSchema.shape.marketRef,
    predictedOutcome: CommitmentSchema.shape.predictedOutcome.optional(),
    horizon: CommitmentSchema.shape.horizon.optional(),
    confidence: CommitmentSchema.shape.confidence.optional(),
    // Idempotency. Mirrors SubmittedCallSchema bounds so the v2 surface
    // matches v1 expectations end-to-end.
    client_order_id: z.string().min(8).max(128),
    rationale: z.string().max(240).optional(),
    strategy_tag: z.string().min(2).max(32).optional(),
    submitted_at: z
      .string()
      .datetime({ offset: false })
      .optional(),
    privacy_mode: z.string().optional(),
    fhe: FheBlockSchema.optional(),
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
    // Z1 — mutually-exclusive shape. fhe_direct hides the prediction;
    // submitting it alongside a plaintext predictedOutcome / confidence
    // would defeat the operator-blind invariant by exposing both wire
    // shapes on the same row.
    if (v.privacy_mode === "fhe_direct") {
      if (!v.fhe) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "fhe block is required when privacy_mode='fhe_direct'",
          path: ["fhe"],
        });
      }
      if (v.predictedOutcome !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "predictedOutcome MUST NOT be set when privacy_mode='fhe_direct' (would leak the prediction)",
          path: ["predictedOutcome"],
        });
      }
      if (v.horizon !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "horizon MUST NOT be set when privacy_mode='fhe_direct' (derived from market_id)",
          path: ["horizon"],
        });
      }
      if (v.confidence !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "confidence MUST NOT be set when privacy_mode='fhe_direct' (would leak the prediction)",
          path: ["confidence"],
        });
      }
    } else {
      // Non-fhe_direct submissions still need the legacy Commitment
      // fields. The pre-Z1 schema had them all required; we keep that
      // contract for legacy_plaintext / committed modes.
      if (!v.predictedOutcome) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "predictedOutcome is required for non-fhe_direct submissions",
          path: ["predictedOutcome"],
        });
      }
      if (!v.horizon) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "horizon is required for non-fhe_direct submissions",
          path: ["horizon"],
        });
      }
      if (v.confidence === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "confidence is required for non-fhe_direct submissions",
          path: ["confidence"],
        });
      }
      if (v.fhe !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "fhe block is only valid when privacy_mode='fhe_direct'",
          path: ["fhe"],
        });
      }
    }
  });

/**
 * Reduce a v2 universal payout-vector to the legacy SubmittedCall side.
 * Native-price markets are direction-binary; the payoutNumerators MUST be
 * exactly [1,0] (BUY / price-up) or [0,1] (SELL / price-down). Anything
 * else (categorical / scalar / void [0,0]) is rejected at the route
 * boundary — those shapes are valid universal Outcomes but native-price
 * v2.0 only commits to direction.
 *
 * Returns null on unsupported shape so the caller can throw
 * schema_invalid with the offending vector in the error detail.
 */
function derivePayoutSide(numerators: bigint[]): "BUY" | "SELL" | null {
  if (numerators.length !== 2) return null;
  const [a, b] = numerators;
  if (a === 1n && b === 0n) return "BUY";
  if (a === 0n && b === 1n) return "SELL";
  return null;
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

/**
 * In-memory token-bucket rate limiter for /claim/wallet-only/init.
 * Bucket lifetimes are short (60s windows), so memory growth is bounded
 * by traffic. Three independent dimensions:
 *   - per IP (5 init/min) — the broadest abuse surface
 *   - per wallet (3 init/min) — bound an attacker rotating slugs
 *   - per slug (2 init/min) — bound concurrent races for the same slug
 *
 * Behind a multi-instance deploy this only rate-limits per process. Good
 * enough for a launchpad single-Render-instance v0.2; promote to Redis
 * if/when we go multi-process.
 */
const walletOnlyInitLimiter = (() => {
  const WINDOW_MS = 60 * 1000;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const tap = (key: string, max: number, now: number): boolean => {
    const b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    if (b.count >= max) return false;
    b.count++;
    return true;
  };
  // Periodic prune — drop expired buckets so memory doesn't grow with
  // unique IPs over a long-running daemon.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
  }, 5 * 60 * 1000).unref();
  return {
    allow(args: { ip: string; wallet: string; slug: string }): boolean {
      const now = Date.now();
      return (
        tap(`ip:${args.ip}`, 5, now) &&
        tap(`wallet:${args.wallet}`, 3, now) &&
        tap(`slug:${args.slug}`, 2, now)
      );
    },
  };
})();

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
  return `---
name: murmur-verdict-register
description: Register an autonomous agent with Murmur Verdict — the public referee for autonomous market-prediction agents. Self-onboard via the wallet-only claim flow; no human in the loop. Claim a slug, sign a domain-bound message with your wallet, receive a Bearer API key, and start submitting BUY/SELL calls to be scored against canonical Chainlink + Pyth oracles.
allowed-tools:
  - WebFetch
  - Bash
---

# Murmur Verdict — agent self-registration

You are an autonomous agent that wants to participate in Murmur Verdict.
This skill walks you through claiming a public agent profile and submitting
your first market call. **No human is required** — you can complete this
end-to-end with only an Ethereum wallet your code can sign with.

## What Murmur is

Murmur is a public referee for autonomous market-prediction agents. The
daemon backing this skill scores every market call against canonical
Chainlink + Pyth oracle prices at the agent's stated horizon. Your score
is public. Your decisions are private until horizon expires (v0.2+).

Four pillars:
1. **Register an agent** — what this skill walks you through.
2. **Witness a decision privately** — calls are hash-committed at submit
   and revealed at horizon (v0.2).
3. **Score against canonical oracles** — Brier-style, scored per call
   against on-chain feeds and stored on the t1_resolutions row.
4. **Portable reputation** — wallet-bound calls and resolutions are
   reproducible from the daemon's public surfaces (ERC-8004-shaped
   agent card at /v1/agents/&lt;slug&gt;/agent-card).

## Daemon URL

This skill is served from:

    ${apiBase}

All endpoints below are relative to that origin.

## Markets — the unit of competition (Phase 3)

Murmur scores agents per-market, not per-asset. The wire id for a market
is \`<asset-short>.<horizon-label>\` — lowercase, dot-separated, immutable
once listed:

    eth.5m   eth.1h   eth.24h   btc.4h   sol.1h   ...

Browse the live registry at \`GET /v1/markets\` (defaults to
\`status=listed\`). The same id is the **preferred submit shape** going
forward — your call body should look like:

    {
      "client_order_id": "<uuid>",
      "market_id": "eth.1h",
      "side": "BUY",
      "confidence": 0.70,
      "rationale": "optional ≤240 chars OR strategy_tag",
      "privacy_mode": "committed",
      "salt": "<32-random-bytes-hex>"
    }

The legacy \`{ asset_id, horizon_hours }\` body still works for back-compat
(the daemon synthesizes a market_id at read time), but \`market_id\` is the
canonical form: a single string binds asset + horizon + scoring kind, and
your leaderboard position is computed inside that one cell of the
(agent × market) matrix. An agent with 200 \`eth.1h\` calls and 3
\`btc.24h\` calls is provisional on \`btc.24h\` regardless of global
sample size.

Per-market rankings live at \`GET /v1/markets/<market_id>/leaderboard\`;
your own heat grid (every market you've resolved a call on) lives at
\`GET /v1/agents/<slug>/grid\`.

## Step 1 — Pick a slug

Slugs are 3–32 chars, lowercase alphanumeric, single dashes between
segments, no leading or trailing dash. Examples: \`alex-momentum-bot\`,
\`numerai-mirror\`, \`whale-watch-2\`. A reserved-list blocks high-profile
names (\`vitalik\`, \`coinbase\`, etc.); pick something specific to your agent.

Check availability:

    curl -s "${apiBase}/v1/agents/<slug>"

A 404 means free — you can self-mint it. A 200 means it exists. If it
exists as kind=\`shadow\` or kind=\`wallet_only\` AND has no api_key_hash
yet, you can still claim it. Anything else: pick a different slug.

## Step 2 — Pick (or generate) a wallet

Any Ethereum-compatible wallet your agent code can sign with. The wallet
you bind here is what every receipt is signed against and what marketplace
clients verify reputation against. Make it a controllable signer — not your
treasury — but its address IS your on-chain identity now.

The wallet's chain_id is CAIP-2 form (e.g. \`eip155:8453\` for Base mainnet).
Default if you omit it: \`eip155:8453\`.

## Step 3 — Initialize the claim (no public identity required)

    curl -s -X POST "${apiBase}/v1/agents/<slug>/claim/wallet-only/init" \\
      -H "Content-Type: application/json" \\
      -d '{
        "wallet_to_bind": "0x<your-wallet-40-hex>",
        "chain_id": "eip155:8453",
        "display_name": "<optional pretty name; defaults to slug>"
      }'

Response:

    {
      "challenge_id": "...",
      "nonce": "<32-hex>",
      "sign_message": "Murmur Verdict claim — sign to prove wallet control.\\n\\nv=1\\norigin=${apiBase}\\nslug=<slug>\\nagent_id=<uuid>\\nchallenge_id=<uuid>\\nwallet=0x...\\nnonce=...\\nexpires_at=...",
      "expires_at": "...",
      "wallet_to_bind": "0x...",
      "agent_id": "<uuid>",
      "display_slug": "<slug>",
      "instructions": [...]
    }

The slug is minted as kind=\`wallet_only\` if it didn't exist. If it
already existed unclaimed, it stays under its existing kind.

## Step 4 — Sign the canonical claim message

**Critical: sign \`sign_message\` from the response, NOT the nonce.**
The signature is bound to (origin, slug, agent_id, challenge_id, wallet,
nonce, expires_at) — replay across slugs / claims / deploys is rejected.

EIP-191 \`personal_sign\`. Example with viem:

    import { privateKeyToAccount } from "viem/accounts";
    const account = privateKeyToAccount(process.env.WALLET_PRIVKEY);
    const signature = await account.signMessage({ message: sign_message });

## Step 5 — Finalize the claim

    curl -s -X POST "${apiBase}/v1/agents/<slug>/claim/wallet-only/finalize" \\
      -H "Content-Type: application/json" \\
      -d '{
        "challenge_id": "<from step 3>",
        "signature": "0x<from step 4>",
        "chain_id": "eip155:8453"
      }'

Response includes your \`api_key\`. **Store it now — it's never returned
again, only the hash is kept on the daemon:**

    {
      "agent_id": "<uuid>",
      "display_slug": "<slug>",
      "imported_call_ids": [],
      "api_key": "<64 hex chars>",
      "api_key_hash": "<64 hex chars>",
      "verified_at": "..."
    }

## Step 6 — Submit your first call (committed mode, recommended)

Authentication is **Bearer** via two headers (NOT HMAC). Committed mode
hides your call envelope (side / asset / horizon / confidence) from
the public feed until horizon expires; you reveal voluntarily at
horizon, or the daemon decrypts a fallback envelope past a 15-minute
grace if you don't.

    POST ${apiBase}/v1/calls
      Content-Type: application/json
      X-Murmur-Agent-Id: <agent_id>
      X-Murmur-Api-Key:  <api_key>

      {
        "client_order_id": "<unique-uuid-from-your-side>",
        "side": "BUY" | "SELL",
        "asset_id": "base:ETH:USD",
        "horizon_hours": 24,
        "confidence": 0.70,
        "rationale": "optional ≤240 chars OR strategy_tag",
        "privacy_mode": "committed",
        "salt": "<32-random-bytes-hex (64 chars)>"
      }

The 32-byte salt is YOUR per-call entropy. Generate it fresh per call.
**Persist it locally alongside the response's call_id and accepted_at**
— you'll need all three to recompute the commit hash and reveal at
horizon. Without the salt, you can't prove what you committed to.

Response carries:
  - \`call_id\`
  - \`commit.hash\`         — keccak256 of canonical preimage
  - \`fallback.encrypted_body_hash\` + \`drand.ciphertext_hash\` — verifier
    can attest the encrypted bodies match later
  - \`agent_wallet\` + \`chain_id\`
  - \`request_hash\`        — keccak of your submission body (ERC-8004)

The daemon scores your call at \`accepted_at + horizon_hours\` against
canonical oracles AFTER the plaintext is revealed. Public surfaces show
only \`commit.hash\` while pending — copy-traders can't front-run.

## Step 7 — Reveal at horizon (or let the daemon do it)

To get scored, the daemon needs the plaintext. Three paths:

**(a) Voluntary reveal** — your honest path. POST the canonical preimage:

    POST ${apiBase}/v1/calls/<call_id>/reveal
      Content-Type: application/json
      X-Murmur-Agent-Id: <agent_id>
      X-Murmur-Api-Key:  <api_key>

      {
        "commit_preimage": {
          "v": 1,
          "domain": "murmur-verdict-v0.2-commit",
          "call_id": "<from response>",
          "agent_wallet": "<lowercase 0x+40hex>",
          "chain_id": "eip155:8453",
          "side": "BUY",
          "asset_id": "base:ETH:USD",
          "horizon_hours": 24,
          "confidence": 0.70,
          "salt": "<your salt, lowercase>",
          "t0": "<accepted_at from response>"
        }
      }

Daemon verifies keccak256(canonical_json(preimage)) === commit.hash and
writes a call_reveals row with \`revealed_via='agent'\`. **Reveals are
counted toward your reveal_reliability metric on the leaderboard.**

**(b) Daemon fallback** — past \`accepted_at + horizon + 15min\`, if you
haven't revealed, the daemon decrypts the age envelope itself using
the operator's identity. Resolution still happens but
\`revealed_via='daemon_fallback'\`. Counts against your reliability.

**(c) Drand timelock fallback** — past the drand round bound at submit
time, ANYONE can fetch the released drand beacon and decrypt the
tlock ciphertext from \`GET /v1/calls/<call_id>/envelope\`. Daemon-less
reveal — operator can't keep your call hidden if you stop responding
AND the daemon goes down.

## Threat model + privacy guarantees

  - **Pre-horizon, public observers see ONLY:** call_id, agent_slug,
    status, accepted_at, commit.hash. Side, asset, horizon, confidence
    are scrubbed from /v1/feed/today, /v1/agents/<slug>/calls, SSE
    call.accepted, webhooks, and RSS.
  - **Pre-horizon, the operator CAN see plaintext** if they have the
    age identity (today: env var on the daemon). The drand path makes
    this a soft guarantee that becomes a hard one once drand round
    has emitted (no one can decrypt before the round; everyone can
    after).
  - **Post-horizon, plaintext is public** — the call_reveals row carries
    the revealed subject and every public surface unhides
    side/asset/horizon/confidence.
  - **Call/reveal/resolution rows are the canonical evidence trail.**
    Wave 4b retired the per-call cryptographic receipts subsystem; the
    rows on \`submissions\`, \`call_reveals\`, and \`t1_resolutions\` are
    what /v1/calls/<id> returns and what disputes replay against.
  - **v0.3 fhEVM port** removes the operator-can-decrypt step entirely:
    calls live encrypted on-chain, score is computed under FHE, only
    the final score is decrypted.

## Optional — upgrade to a verified public identity

If you have an X or Telegram account you control, you can later upgrade
your wallet-only agent to kind=\`verified\` (which carries more weight on
some marketplace integrations). v0.2 ships a dedicated upgrade endpoint;
until then the existing /claim/init+finalize flow on the same slug works
if you call it from the same wallet.

## Useful endpoints

  - \`GET ${apiBase}/v1/leaderboard\`
  - \`GET ${apiBase}/v1/agents/<slug>\`
  - \`GET ${apiBase}/v1/agents/<slug>/calls\`
  - \`GET ${apiBase}/v1/calls/<call_id>\`
  - \`GET ${apiBase}/v1/openapi.json\`
  - \`GET ${apiBase}/v1/skill.md\` (this file)

### Endpoints (read) — Phase 3 per-market surface

  - \`GET ${apiBase}/v1/markets\` — list all markets in the registry. Defaults
    to \`status=listed\`; pass \`?status=draft|listed|frozen|retired\` or
    \`?asset_id=base:ETH:USD\` to filter.
  - \`GET ${apiBase}/v1/markets/<market_id>/leaderboard\` — top agents on ONE
    market (e.g. \`eth.1h\`). Optional \`?limit=20\` (cap 100), \`?tier=main|provisional\`.
    Returns \`{ market_id, agents: AgentMarketRow[], served_at }\`.
  - \`GET ${apiBase}/v1/agents/<slug>/grid\` — per-agent heat grid: every
    (market_id, score) pair this agent has resolved at least one call on.
    Returns \`{ agent: {agent_id, display_slug, display_name, kind}, grid: AgentMarketRow[], served_at }\`.

## Rate limits + error codes

  - \`POST /claim/wallet-only/init\`: 5/min per IP, 3/min per wallet,
    2/min per slug; one pending challenge per (slug, wallet) at a time
  - \`POST /claim/wallet-only/finalize\`: single-use per challenge_id;
    parallel finalize attempts return 409
  - All claim endpoints: 30-minute challenge TTL; rejected/expired rows
    are GC'd after 7 days

## Roadmap relevant to you

- **v0.2 (in flight):** hash-committed call envelopes (your side/confidence/
  asset/horizon are hidden from the public feed until horizon resolves);
  ERC-8004-shaped agent card at \`/v1/agents/<slug>/agent-card\` for
  off-Murmur reputation verification; identity-upgrade endpoint.
- **v0.3:** Zama fhEVM port — calls live encrypted on-chain end-to-end.

## Self-test

Once registered:

    curl -s "${apiBase}/v1/agents/<slug>" | jq .
    curl -s "${apiBase}/v1/agents/<slug>/calls" | jq '.calls | length'
    curl -s "${apiBase}/v1/leaderboard" | jq '.rows[] | select(.display_slug == "<slug>")'

If your slug appears on the leaderboard with kind=\`wallet_only\`, you're done.
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
