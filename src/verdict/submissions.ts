import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AcceptedCall,
  AcceptedCallSchema,
  CallStatus,
  ERROR_CODES,
  SubmittedCall,
  SubmittedCallSchema,
  SUBMISSION_LIMITS,
  SCHEMA_VERSION,
  SCORING_VERSION,
  T0Policy,
  UsageEvent,
  VerdictError,
} from "./schema.js";
import {
  agentsRepo,
  isUniqueViolation,
  submissionsRepo,
  usageRepo,
  type AcceptanceWriteInput,
} from "./db.js";
import type { VerdictEventBus } from "./events.js";
import {
  acceptsSubmissions,
  buildMarketDedupKey,
  legacyHorizonHoursForMarket,
  perMarketDailyCap,
  resolveMarketFromPayload,
} from "./markets.js";
import type { Commitment } from "./markets-core.js";
import {
  derivePolicyFromMarket,
  PolicyDerivationError,
} from "./oracle-routing.js";
import type { MarketRow } from "./db.js";

/**
 * Privacy modes the daemon accepts at submit. Wave 2b: FHE-mandatory
 * means `fhe_direct` is the only surviving mode. Committed-mode and
 * legacy_plaintext have been excised — every submission must arrive
 * via the operator-blind path. Any unrecognized privacy_mode string
 * is rejected with schema_invalid (Codex H2 silent-downgrade closure
 * still applies).
 */
export const ACCEPTED_PRIVACY_MODES: ReadonlySet<string> = new Set<string>([
  "fhe_direct",
]);
import type { FheProvider } from "./fhe/provider.js";
import {
  insertFheCiphertext,
  validateFheSubmission,
  type FheSubmissionBlock,
} from "./fhe/submission.js";
import { buildFheCommit } from "./fhe/fhe-commit-preimage.js";
import { z } from "zod";

// ─── Public types ────────────────────────────────────────────────────────────

export interface SubmissionContext {
  /** Now provider; injectable for tests. */
  now?: () => Date;
  /**
   * Test-only override. Phase 2b: production submitCall always derives
   * T0Policy from the resolved market row via derivePolicyFromMarket().
   * Smoke / unit tests can inject a synthetic policy when bypassing the
   * markets-registry path.
   */
  oraclePolicy?: T0Policy;
  /** Optional event bus for SSE fan-out. Emit on accept; no-op when undefined. */
  events?: VerdictEventBus;
  /**
   * Z0 — FHE provider for operator-blind privacy. Loaded once at daemon
   * boot from MURMUR_FHE_PROVIDER and shared across submissions and the
   * resolver. NULL when MURMUR_FHE_DIRECT_ENABLED is unset; in that case
   * `fhe_direct` submissions are rejected by the privacy gate above and
   * legacy paths are unaffected. The submission path itself still
   * rejects `fhe_direct` with `z1_not_implemented` for now — Z1 fills
   * in the encrypted-submission code.
   */
  fheProvider?: FheProvider | null;
}

export interface AuthIdentity {
  agent_id: string;
}

export interface SubmitResult {
  call: AcceptedCall;
  status: Extract<CallStatus, "accepted">;
  /** True if an existing call with the same client_order_id was returned. */
  idempotent_hit: boolean;
}

// ─── HMAC auth helpers ───────────────────────────────────────────────────────
//
// Wire contract:
//   - Header `X-Murmur-Agent-Id`: agent's UUID
//   - Header `X-Murmur-Timestamp`: ISO8601 UTC; ±300s of server now
//   - Header `X-Murmur-Signature`: hex hmac-sha256( shared_secret, `${ts}\n${rawBodyJson}` )
// The server stores `api_key_hash = sha256(shared_secret)`, so the secret is
// not retrievable. Verification recomputes the HMAC against the candidate body
// and constant-time compares. v0.1 ignores key-rotation; the claim flow
// re-issues the key wholesale.

import { createHash } from "node:crypto";

export interface SignedHeaders {
  agent_id: string;
  timestamp: string;
  signature: string; // hex
}

export interface HmacAuthInput {
  rawBody: string;
  headers: SignedHeaders;
  shared_secret: string;
  now?: () => Date;
  /** Allowed clock skew (seconds). Default 300. */
  skewSec?: number;
}

export function verifyHmac(input: HmacAuthInput): void {
  const now = (input.now ?? (() => new Date()))().getTime();
  const ts = Date.parse(input.headers.timestamp);
  if (!Number.isFinite(ts)) {
    throw new VerdictError(
      "invalid X-Murmur-Timestamp",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
  const skewMs = (input.skewSec ?? 300) * 1000;
  if (Math.abs(now - ts) > skewMs) {
    throw new VerdictError(
      "X-Murmur-Timestamp outside allowed skew",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
  const expected = createHmac("sha256", input.shared_secret)
    .update(`${input.headers.timestamp}\n${input.rawBody}`)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(input.headers.signature.toLowerCase(), "hex");
  } catch {
    throw new VerdictError(
      "invalid signature hex",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new VerdictError(
      "signature mismatch",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
}

export function hashSharedSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// ─── Core submission flow ────────────────────────────────────────────────────

export async function submitCall(args: {
  db: Database.Database;
  ctx: SubmissionContext;
  identity: AuthIdentity;
  payload: unknown;
  /**
   * Phase 4 /v2/calls handoff retained for type-compat with legacy /v1
   * callers, but Wave 2b leaves the legacy plaintext stamp path dead
   * (it now writes NULL into the commitment columns). fhe_direct
   * submissions are stamped by submitFheDirectCall, which leaves both
   * commitment_json and predicted_outcome_json NULL by design.
   */
  precomputedCommitment?: Commitment;
  /** Phase 4 — render-only labels for the payout vector positions. Today
   *  always ['UP','DOWN'] for native-price; future adapters supply their
   *  own (e.g. ['YES','NO'] or category names). NEVER load-bearing for
   *  scoring (V2 §2.3); the leaderboard / dashboard just renders them. */
  outcomeLabels?: readonly string[];
  /**
   * Z1 — operator-blind submission. When the /v2/calls route detects
   * `privacy_mode === 'fhe_direct'`, it passes the parsed `fhe` block
   * and the resolved market_id here. submitCall routes to
   * `submitFheDirectCall` BEFORE validating against SubmittedCallSchema:
   * fhe_direct has no `side` / `confidence` on the wire, so passing it
   * through the legacy schema would reject every operator-blind call.
   *
   * The fhe block has already been Zod-validated by the route layer
   * (so a malformed shape is a 400 at the boundary); the *content* of
   * it (keyset existence, hash recomputation, replay) is verified
   * inside submitFheDirectCall.
   */
  fheDirect?: {
    readonly fhe: unknown;
    readonly market_id: string;
  };
}): Promise<SubmitResult> {
  const { db, ctx, identity, payload, precomputedCommitment } = args;
  const now = ctx.now ?? (() => new Date());

  // Z1 — operator-blind early branch. Detect fhe_direct from the
  // payload BEFORE schema validation: SubmittedCallSchema's
  // `side`/`confidence` requirements would otherwise reject every
  // fhe_direct submission at byte 0. The privacy gate inside the
  // legacy path still rejects fhe_direct strings when the caller
  // mistakenly routes through there (defense in depth).
  if (
    args.fheDirect !== undefined ||
    (isObject(payload) && payload.privacy_mode === "fhe_direct")
  ) {
    return submitFheDirectCall({
      db,
      ctx,
      identity,
      payload,
      fheDirect: args.fheDirect,
    });
  }
  // Phase 2b: oracle policy is derived from the resolved market row at the
  // point we know which market this call targets — see derivedOraclePolicy
  // below. ctx.oraclePolicy survives only as a TEST OVERRIDE (smoke / unit
  // tests can inject a synthetic T0Policy when the market lookup is being
  // bypassed). Production never passes ctx.oraclePolicy.

  // 1. schema validation
  const parsed = SubmittedCallSchema.safeParse(payload);
  if (!parsed.success) {
    usageRepo.emit(db, makeUsage(identity.agent_id, "submission_rejected", { reason: "schema_invalid" }, now));
    throw new VerdictError(
      "submission failed schema validation",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.format() },
    );
  }
  const rawSubmission: SubmittedCall = parsed.data;
  // Codex P3 D1: market_id-bearing payloads use the new commit-preimage
  // schema; legacy (asset_id, horizon_hours) payloads keep the v0.2 schema.
  const wireUsedMarketId = typeof rawSubmission.market_id === "string";

  if (rawSubmission.agent_id !== identity.agent_id) {
    throw new VerdictError(
      "agent_id in payload does not match auth identity",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }

  // 2. agent exists
  const agent = agentsRepo.byId(db, identity.agent_id);
  if (!agent) {
    throw new VerdictError(
      "unknown agent",
      ERROR_CODES.unknown_agent,
      404,
    );
  }

  // 3. P3 hardening (Codex audit, post-Phase 2a):
  //    Idempotency MUST run before the live market lookup + status gate.
  //    Otherwise a valid retry on an already-accepted client_order_id can
  //    fail when the market was frozen/retired between attempts. The
  //    receipt was minted under the old policy; returning the existing
  //    call is the correct semantics.
  const existing = submissionsRepo.findByClientOrderId(
    db,
    identity.agent_id,
    rawSubmission.client_order_id,
  );
  if (existing) {
    return loadExistingAcceptedCall(db, existing.call_id, true);
  }

  // 4. P3 — resolve market from either wire shape, gate on listed status.
  const market: MarketRow | null = resolveMarketFromPayload(db, {
    market_id: rawSubmission.market_id,
    asset_id: rawSubmission.asset_id,
    horizon_hours: rawSubmission.horizon_hours,
  } as Parameters<typeof resolveMarketFromPayload>[1]);
  if (!market) {
    usageRepo.emit(
      db,
      makeUsage(
        identity.agent_id,
        "submission_rejected",
        { reason: "market_unknown" },
        now,
      ),
    );
    throw new VerdictError(
      wireUsedMarketId
        ? `unknown market_id: ${rawSubmission.market_id}`
        : `unknown market for (asset_id=${rawSubmission.asset_id}, horizon_hours=${rawSubmission.horizon_hours})`,
      ERROR_CODES.asset_not_supported,
      404,
      { reason: "market_unknown" },
    );
  }
  if (!acceptsSubmissions(market)) {
    usageRepo.emit(
      db,
      makeUsage(
        identity.agent_id,
        "submission_rejected",
        { reason: "market_not_listed", market_id: market.market_id, status: market.status },
        now,
      ),
    );
    throw new VerdictError(
      `market ${market.market_id} status=${market.status} (not accepting submissions)`,
      ERROR_CODES.asset_not_supported,
      400,
      {
        reason: "market_not_listed",
        market_id: market.market_id,
        market_status: market.status,
      },
    );
  }
  // P3 Phase 2e: sub-hour scoring is live — scoring routes through
  // canonical `horizon_seconds` (see scoreCall in scoring.ts). The
  // Phase 2d submit guard that bounced sub-hour calls is removed; the
  // schema plumbing (Pyth-only T0Policy, horizon_seconds canonical)
  // and the new sub-hour volatility buckets close the gap.

  // Phase 2b: derive the per-call T0Policy from the market's primary +
  // fallback oracle rows. Fail-closed if either referenced oracle isn't
  // 'listed' or has no feed-string mapping. This closes the Codex-flagged
  // silent-wrong-oracle footgun where a market.status flip on a market
  // whose oracle was draft would let calls mint and resolve against the
  // wrong feed.
  let derivedOraclePolicy: T0Policy;
  try {
    derivedOraclePolicy = ctx.oraclePolicy ?? derivePolicyFromMarket(db, market);
  } catch (err) {
    if (err instanceof PolicyDerivationError) {
      usageRepo.emit(
        db,
        makeUsage(
          identity.agent_id,
          "submission_rejected",
          {
            reason: "policy_derivation_failed",
            market_id: market.market_id,
            cause: err.cause,
          },
          now,
        ),
      );
      throw new VerdictError(
        `cannot mint call on ${market.market_id}: ${err.message}`,
        ERROR_CODES.asset_not_supported,
        400,
        {
          reason: "policy_derivation_failed",
          market_id: market.market_id,
          cause: err.cause,
        },
      );
    }
    throw err;
  }
  const oraclePolicy = derivedOraclePolicy;

  // P3: normalize the submission shape — fill in whichever side of the
  // either/or wire shape is missing. Receipts, dedup, and persistence all
  // see asset_id + horizon_hours + market_id populated. The ORIGINAL wire
  // shape is preserved in `rawSubmission` for request_hash computation
  // (committed-mode receipts) so a verifier can recanonicalize the agent's
  // bytes without daemon mutation.
  // Codex follow-up F2: replace Math.round with the explicit fail-closed
  // mapping. Future arbitrary horizons (e.g. 7m → 0 same as 5m, 90m →
  // round to 2 which isn't a legal HorizonHours) would silently mint
  // wrong-shape v1 receipts otherwise.
  const horizonHoursFromMarket = legacyHorizonHoursForMarket(market);
  const submission: SubmittedCall = {
    ...rawSubmission,
    market_id: market.market_id,
    asset_id: market.asset_id as SubmittedCall["asset_id"],
    horizon_hours: horizonHoursFromMarket as SubmittedCall["horizon_hours"],
  };

  // 5. rate limits — layered (Codex P3 D3):
  //    a. global active per agent (5)
  //    b. per-asset rolling 24h (24/asset/day, accepted_at-bound)
  //    c. per-market rolling 24h (24 for legacy ETH, 12 for new markets)
  const activeCount = agentsRepo.countActiveCallsForAgent(db, identity.agent_id);
  if (activeCount >= SUBMISSION_LIMITS.max_active_calls_per_agent) {
    usageRepo.emit(db, makeUsage(identity.agent_id, "submission_rejected", { reason: "max_active" }, now));
    throw new VerdictError(
      `max ${SUBMISSION_LIMITS.max_active_calls_per_agent} active calls per agent`,
      ERROR_CODES.rate_limited,
      429,
    );
  }
  const since = new Date(now().getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const todayAssetCount = submissionsRepo.countCallsForAgentAssetWindow(
    db,
    identity.agent_id,
    submission.asset_id!,
    since,
  );
  if (todayAssetCount >= SUBMISSION_LIMITS.max_calls_per_asset_per_day) {
    usageRepo.emit(db, makeUsage(identity.agent_id, "submission_rejected", { reason: "daily_cap_asset" }, now));
    throw new VerdictError(
      `max ${SUBMISSION_LIMITS.max_calls_per_asset_per_day} calls per asset per day`,
      ERROR_CODES.rate_limited,
      429,
    );
  }
  const perMarketCap = perMarketDailyCap(market.market_id);
  const todayMarketCount = submissionsRepo.countCallsForAgentMarketWindow(
    db,
    identity.agent_id,
    market.market_id,
    since,
  );
  if (todayMarketCount >= perMarketCap) {
    usageRepo.emit(
      db,
      makeUsage(
        identity.agent_id,
        "submission_rejected",
        { reason: "daily_cap_market", market_id: market.market_id, cap: perMarketCap },
        now,
      ),
    );
    throw new VerdictError(
      `max ${perMarketCap} calls/market/24h on ${market.market_id}`,
      ERROR_CODES.rate_limited,
      429,
      { market_id: market.market_id, cap: perMarketCap },
    );
  }

  // 6. dedup — uses SERVER time (accepted_at), not agent-supplied submitted_at,
  //    so an agent cannot replay the same call with different submitted_at
  //    strings and slip past dedup on the wire. Bucket size = max(300s,
  //    horizon_seconds/4) per Codex P3 D2.
  const accepted_at = nowIso(now());
  const dedup_key = buildMarketDedupKey({
    agent_id: identity.agent_id,
    market_id: market.market_id,
    side: submission.side,
    horizon_seconds: market.horizon_seconds,
    accepted_at_iso: accepted_at,
  });
  const dup = submissionsRepo.findByDedupKey(db, dedup_key);
  if (dup) {
    usageRepo.emit(db, makeUsage(identity.agent_id, "submission_rejected", { reason: "dedup" }, now));
    throw new VerdictError(
      "duplicate submission inside dedup window",
      ERROR_CODES.duplicate,
      409,
      { existing_call_id: dup.call_id },
    );
  }

  // 6. Wave 4b-2 — Santiment-driven risk evaluator removed. The earlier
  // pipeline produced a VerdictPreflight stamped onto every accepted call
  // with composite_score / regime / playbook / risk_flags. Resolver never
  // consulted it; calls settle against Chainlink/Pyth oracles only. The
  // commitment + reveal + resolution rows are the canonical evidence
  // trail; rate limits, dedup, and HMAC auth above provide all
  // non-decorative gating.

  // 7. assign call_id and prep committed-mode envelope (Wave 4b: receipts
  // were dropped — call_id + reveal + resolution rows are the canonical
  // evidence trail; no per-call JSON snapshot persists).
  const call_id = randomUUID();
  // accepted_at already computed above for dedup; reuse for the envelope.
  // Pillar-4 marketplace portability: wallet binding lives on the agent
  // row directly; off-Murmur verifiers chain (agent_wallet → score) via
  // the agent profile, not a per-call receipt subject.
  const issuingAgent = agentsRepo.byId(db, submission.agent_id);

  // Wave 2b — FHE-mandatory. The committed-mode and legacy_plaintext
  // branches have been excised. fhe_direct submissions are dispatched
  // via the early branch at the top of submitCall(); reaching this
  // point means the caller posted the legacy plaintext wire shape, so
  // we keep the privacy-mode gate to reject anything outside the
  // surviving set (which is just `fhe_direct`).
  const envelopeForRepo: AcceptanceWriteInput["envelope"] = undefined;
  const privacyModeForRepo: string = "legacy_plaintext";
  const commitHashForRepo: string | undefined = undefined;
  const commitSchemeForRepo: string | undefined = undefined;
  void issuingAgent;

  // F3: reject unknown privacy_mode strings BEFORE branching. Closes
  // the Codex H2 silent-downgrade vector.
  if (
    submission.privacy_mode !== undefined &&
    !ACCEPTED_PRIVACY_MODES.has(submission.privacy_mode)
  ) {
    throw new VerdictError(
      `unknown privacy_mode '${submission.privacy_mode}' — must be one of: ${[...ACCEPTED_PRIVACY_MODES].join(", ")}`,
      ERROR_CODES.schema_invalid,
      400,
    );
  }

  // Z1 — fhe_direct is handled by submitFheDirectCall via the early
  // branch at the top of submitCall. Reaching this point with
  // privacy_mode='fhe_direct' means a caller posted the legacy wire
  // shape (side/confidence in plaintext) while declaring fhe_direct
  // — that would leak the prediction to the operator. Reject as a
  // shape error rather than silently downgrading.
  if (submission.privacy_mode === "fhe_direct") {
    throw new VerdictError(
      "fhe_direct submissions must POST to /v2/calls with the `fhe` block; this route's wire shape includes plaintext side/confidence",
      ERROR_CODES.schema_invalid,
      400,
    );
  }

  // 8. construct AcceptedCall, validate, persist atomically
  const accepted: AcceptedCall = AcceptedCallSchema.parse({
    schema_version: SCHEMA_VERSION,
    scoring_version: SCORING_VERSION,
    call_id,
    agent_id: submission.agent_id,
    client_order_id: submission.client_order_id,
    asset_id: submission.asset_id,
    side: submission.side,
    horizon_hours: submission.horizon_hours,
    confidence: submission.confidence,
    submitted_at: submission.submitted_at,
    rationale: submission.rationale,
    strategy_tag: submission.strategy_tag,
    accepted_at,
    status: "accepted",
    oracle_policy: oraclePolicy,
  });

  // Wave 2b — the legacy plaintext fallthrough that reaches this point
  // is unreachable at runtime (the v2 surface rejects non-FHE at the
  // route layer; fhe_direct branches out at the top of submitCall).
  // We stamp nulls into the commitment columns so the call site stays
  // compilable without dragging the deleted Phase 4 helpers
  // (`deriveLegacyCommitment` / `commitmentToWire`) back in.
  void precomputedCommitment;
  void args.outcomeLabels;
  const commitmentJsonStamp: string | null = null;
  const predictedOutcomeJsonStamp: string | null = null;
  const outcomeLabelsJsonStamp: string | null = null;

  try {
    submissionsRepo.acceptCall(db, {
      submission,
      accepted,
      dedup_key,
      privacy_mode: privacyModeForRepo,
      market_id: market.market_id,
      market_config_version: market.market_config_version,
      // Phase 2c: stamp the canonical horizon directly from the market row
      // (sub-hour markets need the seconds-precise value; legacy ETH
      // markets still produce the exact same bytes — 3600/14400/86400/604800).
      horizon_seconds: market.horizon_seconds,
      // BUG FIX (codex review v3 P2 #2): stamp adapter_id / market_family
      // on the submission row at acceptance. Migration 016 covers legacy
      // rows; without this stamp, fresh submissions accepted post-deploy
      // would land with NULL adapter_id / market_family and break family
      // filters + adapter dispatch. Falls back to the same defaults
      // migration 016 uses when a market row predates adapter columns.
      adapter_id: market.adapter_id ?? "native-price",
      market_family: market.market_family ?? "financial-direction",
      commitment_json: commitmentJsonStamp,
      predicted_outcome_json: predictedOutcomeJsonStamp,
      outcome_labels_json: outcomeLabelsJsonStamp,
      ...(commitHashForRepo ? { commit_hash: commitHashForRepo } : {}),
      ...(commitSchemeForRepo ? { commit_scheme: commitSchemeForRepo } : {}),
      ...(envelopeForRepo ? { envelope: envelopeForRepo } : {}),
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // race with concurrent identical submission; fall through to idempotent return
      const existingAfter = submissionsRepo.findByClientOrderId(
        db,
        identity.agent_id,
        submission.client_order_id,
      );
      if (existingAfter) return loadExistingAcceptedCall(db, existingAfter.call_id, true);
      const dupAfter = submissionsRepo.findByDedupKey(db, dedup_key);
      if (dupAfter) {
        throw new VerdictError(
          "duplicate submission inside dedup window",
          ERROR_CODES.duplicate,
          409,
          { existing_call_id: dupAfter.call_id },
        );
      }
    }
    throw err;
  }

  submissionsRepo.setStatus(db, call_id, "pending_t0");
  usageRepo.emit(
    db,
    makeUsage(
      identity.agent_id,
      "submission_accepted",
      {
        call_id,
        asset_id: submission.asset_id,
        side: submission.side,
        horizon_hours: submission.horizon_hours,
      },
      now,
    ),
  );

  // Wave 2b — committed-mode scrubbing is gone (mode no longer exists at
  // this layer). The legacy plaintext fallthrough fans out side / asset /
  // horizon / confidence directly; fhe_direct submissions are emitted by
  // submitFheDirectCall's own event path with operator-blind redaction.
  ctx.events?.emit({
    type: "call.accepted",
    call_id,
    agent_id: agent.agent_id,
    agent_slug: agent.display_slug,
    privacy_mode: privacyModeForRepo,
    accepted_at,
    // Phase 10 / Z4-extra discriminators. The resolved adapter/family/
    // market_id are always known at this point — market != null was
    // enforced earlier in the route. Subscribers route render off these
    // without inferring from optional plaintext.
    adapter_id: market.adapter_id ?? "native-price",
    market_family: market.market_family ?? "financial-direction",
    market_id: market.market_id,
    side: submission.side,
    asset_id: submission.asset_id,
    horizon_hours: submission.horizon_hours,
    confidence: submission.confidence,
  });

  return {
    call: accepted,
    status: "accepted",
    idempotent_hit: false,
  };
}

// ─── Z1 — operator-blind submission path ─────────────────────────────────────
//
// Parallel to submitCall(): same agent / market / rate-limit / idempotency
// gates, but the wire shape carries an `fhe` block instead of
// side/confidence/predictedOutcome, and the persisted submissions row has
// NULL on every plaintext-prediction column. submissions.commit_hash is
// stamped with the v0.3 fhe-commit preimage hash (which binds the
// ciphertext_hash, not the prediction itself).
//
// Intentionally does NOT share state with submitCall — copy-paste over
// abstraction here is deliberate because every shared helper would
// invite future drift that re-introduces a plaintext leak. The legacy
// path's "stamp commitment_json from precomputedCommitment" is exactly
// what we must NOT do for fhe_direct.

/**
 * Wire shape for the agent-supplied portion of an fhe_direct submission.
 * The /v2/calls route extracts this and passes it via `args.fheDirect`.
 * `client_order_id`, `rationale`, `strategy_tag`, `submitted_at` come
 * through the payload object as usual (mirrors V2SubmissionBodySchema's
 * non-Commitment fields).
 */
const FheDirectPayloadSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    agent_id: z.string().uuid(),
    client_order_id: z.string().min(8).max(128),
    market_id: z.string().min(1),
    privacy_mode: z.literal("fhe_direct"),
    rationale: z.string().max(240).optional(),
    strategy_tag: z.string().min(2).max(32).optional(),
    submitted_at: z.string().datetime({ offset: false }).optional(),
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
  });

async function submitFheDirectCall(args: {
  db: Database.Database;
  ctx: SubmissionContext;
  identity: AuthIdentity;
  payload: unknown;
  fheDirect?: { readonly fhe: unknown; readonly market_id: string };
}): Promise<SubmitResult> {
  const { db, ctx, identity, payload } = args;
  const now = ctx.now ?? (() => new Date());

  // Provider must be loaded — the privacy gate at module top admits
  // 'fhe_direct' only when MURMUR_FHE_DIRECT_ENABLED=1, but the gate
  // doesn't check whether the daemon actually constructed a provider.
  // If the operator typoed MURMUR_FHE_PROVIDER or dropped a required
  // env var, loader returns null even with the flag on; we refuse
  // submissions with a clear 503 rather than crashing on the keyset
  // lookup.
  const provider = ctx.fheProvider ?? null;
  if (!provider) {
    throw new VerdictError(
      "daemon not configured for fhe_direct submissions (no FheProvider loaded; check MURMUR_FHE_DIRECT_ENABLED and MURMUR_FHE_PROVIDER)",
      ERROR_CODES.internal_error,
      503,
    );
  }

  // 1. Validate the agent-supplied payload shape. The /v2/calls handler
  //    already parsed the body; we re-parse here so /v1 routes (or
  //    future internal callers) can't bypass the schema.
  const parsed = FheDirectPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    usageRepo.emit(
      db,
      makeUsage(
        identity.agent_id,
        "submission_rejected",
        { reason: "schema_invalid", privacy_mode: "fhe_direct" },
        now,
      ),
    );
    throw new VerdictError(
      "fhe_direct submission failed schema validation",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.format() },
    );
  }
  const submission = parsed.data;

  if (submission.agent_id !== identity.agent_id) {
    throw new VerdictError(
      "agent_id in payload does not match auth identity",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }

  // 2. Agent exists.
  const agent = agentsRepo.byId(db, identity.agent_id);
  if (!agent) {
    throw new VerdictError("unknown agent", ERROR_CODES.unknown_agent, 404);
  }

  // 3. Idempotency — same client_order_id returns the existing call.
  //    Runs BEFORE market lookup so a market freeze between attempts
  //    can't break a retry (same rationale as the legacy path).
  //    Uses the fhe_direct-aware loader so the rebuilt AcceptedCall
  //    doesn't trip AcceptedCallSchema's required side/confidence
  //    (which are deliberately NULL for fhe_direct rows).
  const existing = submissionsRepo.findByClientOrderId(
    db,
    identity.agent_id,
    submission.client_order_id,
  );
  if (existing) {
    return loadExistingFheDirectCall(db, existing.call_id, true);
  }

  // 4. Market resolution + listed-status gate.
  const market: MarketRow | null = resolveMarketFromPayload(db, {
    market_id: submission.market_id,
  } as Parameters<typeof resolveMarketFromPayload>[1]);
  if (!market) {
    throw new VerdictError(
      `unknown market_id: ${submission.market_id}`,
      ERROR_CODES.asset_not_supported,
      404,
    );
  }
  if (!acceptsSubmissions(market)) {
    throw new VerdictError(
      `market ${market.market_id} status=${market.status} (not accepting submissions)`,
      ERROR_CODES.asset_not_supported,
      400,
    );
  }

  // 5. Derive oracle policy (same path the legacy submit takes; the
  //    resolver still needs this for Z2's encrypted-scoring flow).
  let oraclePolicy: T0Policy;
  try {
    oraclePolicy = ctx.oraclePolicy ?? derivePolicyFromMarket(db, market);
  } catch (err) {
    if (err instanceof PolicyDerivationError) {
      throw new VerdictError(
        `cannot mint fhe_direct call on ${market.market_id}: ${err.message}`,
        ERROR_CODES.asset_not_supported,
        400,
      );
    }
    throw err;
  }

  // 6. Rate limits — global active count + per-market 24h cap. We DON'T
  //    apply the per-asset cap (it indexes on `asset_id`, which is null
  //    for fhe_direct rows). The per-market cap on its own keeps the
  //    headline abuse vector bounded.
  const activeCount = agentsRepo.countActiveCallsForAgent(db, identity.agent_id);
  if (activeCount >= SUBMISSION_LIMITS.max_active_calls_per_agent) {
    throw new VerdictError(
      `max ${SUBMISSION_LIMITS.max_active_calls_per_agent} active calls per agent`,
      ERROR_CODES.rate_limited,
      429,
    );
  }
  const since = new Date(now().getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const perMarketCap = perMarketDailyCap(market.market_id);
  const todayMarketCount = submissionsRepo.countCallsForAgentMarketWindow(
    db,
    identity.agent_id,
    market.market_id,
    since,
  );
  if (todayMarketCount >= perMarketCap) {
    throw new VerdictError(
      `max ${perMarketCap} calls/market/24h on ${market.market_id}`,
      ERROR_CODES.rate_limited,
      429,
    );
  }

  // 7. accepted_at stamp + dedup-key bucket.
  //    fhe_direct dedup omits `side` because there is no side on the
  //    wire — we substitute the literal 'fhe' so the bucket still
  //    collapses two near-simultaneous identical-market submits but
  //    can't accidentally collide with a legacy_plaintext BUY/SELL
  //    bucket (different prefix).
  const accepted_at = nowIso(now());
  const dedup_key = buildMarketDedupKey({
    agent_id: identity.agent_id,
    market_id: market.market_id,
    side: "fhe" as unknown as "BUY",
    horizon_seconds: market.horizon_seconds,
    accepted_at_iso: accepted_at,
  });

  // 8. Validate the `fhe` block content (keyset, circuit, hash,
  //    replay). The route already validated the SHAPE via Zod; this
  //    pass enforces the existence + integrity constraints.
  const fheBlock = args.fheDirect?.fhe;
  if (fheBlock === undefined) {
    throw new VerdictError(
      "fhe_direct submissions require an `fhe` block on /v2/calls",
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  const validated = validateFheSubmission({
    db,
    agent_id: identity.agent_id,
    provider,
    fhe: fheBlock,
  });

  // 9. Build the v0.3 commit hash. The preimage binds the ciphertext
  //    hash, NOT the prediction. See fhe-commit-preimage.ts for the
  //    operator-blind invariant: putting `side` / `confidence` /
  //    `payoutNumerators` here would re-open a dictionary-attack
  //    side-channel on the public commit_hash.
  const call_id = randomUUID();
  const fheCommit = buildFheCommit({
    call_id,
    agent_id: identity.agent_id,
    market_ref: {
      protocol: market.adapter_id ?? "native-price",
      sourceId: market.market_id,
    },
    keyset_id: validated.keyset.keyset_id,
    circuit_id: validated.circuit.circuit_id,
    ciphertext_hash: validated.block.ciphertext_hash,
    vector_len: validated.block.vector_len,
    payout_denominator: validated.block.payout_denominator,
    nonce: validated.block.nonce,
    t0_anchor_ts: accepted_at,
    accepted_at,
  });

  // 10. Persist. Same transaction shape as the legacy acceptCall, but
  //     we (a) leave commitment_json / predicted_outcome_json NULL,
  //     (b) leave side / asset_id / horizon_hours / confidence NULL on
  //     the row, (c) insert the ciphertext row alongside.
  const submittedAt =
    submission.submitted_at ?? accepted_at;
  // The synthesized AcceptedCall satisfies the legacy type but every
  // plaintext-prediction field is overridden to NULL inside the
  // transaction below. The cast is unavoidable: AcceptedCall predates
  // operator-blind privacy and bakes in side/confidence/horizon as
  // required. Z4 introduces a discriminated AcceptedCall variant; for
  // Z1 the cast is the price of leaving public types stable while a
  // single mode goes "blind".
  const acceptedRow = {
    schema_version: SCHEMA_VERSION,
    scoring_version: SCORING_VERSION,
    call_id,
    agent_id: submission.agent_id,
    client_order_id: submission.client_order_id,
    asset_id: market.asset_id,
    side: "BUY",
    horizon_hours: legacyHorizonHoursForMarket(market) ?? 24,
    confidence: 0.51,
    submitted_at: submittedAt,
    ...(submission.rationale !== undefined
      ? { rationale: submission.rationale }
      : {}),
    ...(submission.strategy_tag !== undefined
      ? { strategy_tag: submission.strategy_tag }
      : {}),
    accepted_at,
    status: "accepted",
    oracle_policy: oraclePolicy,
  } as unknown as AcceptedCall;

  // Run the multi-statement insert inside a single transaction so a
  // crash between submissions and fhe_call_ciphertexts can't leave a
  // half-written call.
  let idempotentHit = false;
  try {
    db.transaction(() => {
      submissionsRepo.acceptCall(db, {
        submission: {
          schema_version: SCHEMA_VERSION,
          agent_id: submission.agent_id,
          client_order_id: submission.client_order_id,
          // The repo writes these onto the submissions row. For
          // fhe_direct we want them NULL — `acceptCall` reads from
          // `i.accepted`, so we override after the call below via a
          // direct UPDATE. Pass the synthetic acceptedRow shape here
          // to satisfy the typed insert; we then null the leak-y
          // columns in the same transaction.
          market_id: market.market_id,
          side: "BUY",
          confidence: 0.51,
          submitted_at: submittedAt,
        } as unknown as SubmittedCall,
        accepted: acceptedRow,
        dedup_key,
        privacy_mode: "fhe_direct",
        market_id: market.market_id,
        market_config_version: market.market_config_version,
        horizon_seconds: market.horizon_seconds,
        adapter_id: market.adapter_id ?? "native-price",
        market_family: market.market_family ?? "financial-direction",
        // Operator-blind invariant: NULL on every plaintext-derived
        // column. Phase 5 resolver's universal hot path falls back to
        // legacy-synthesis when commitment_json is null; Z2 will add
        // an `fhe_direct` short-circuit there that consults
        // fhe_call_ciphertexts instead.
        commitment_json: null,
        predicted_outcome_json: null,
        outcome_labels_json: null,
        commit_hash: fheCommit.commit_hash,
        commit_scheme: "keccak256",
      });
      // Null the plaintext-prediction columns the legacy repo just
      // wrote. We want fhe_direct rows to be operator-blind — even
      // the side/asset/horizon/confidence columns must be cleared so
      // a future projection (Today Tape, SSE) reading `submissions.*`
      // can't accidentally surface a placeholder value.
      db.prepare(
        `UPDATE submissions
         SET side = NULL, asset_id = NULL, horizon_hours = NULL, confidence = NULL
         WHERE call_id = ?`,
      ).run(call_id);
      insertFheCiphertext({
        db,
        call_id,
        keyset: validated.keyset,
        circuit: validated.circuit,
        block: validated.block,
        ciphertext_bytes: validated.ciphertext_bytes,
        accepted_at,
      });
    })();
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Race or replay — both surface as 409 with the existing call_id
      // when we can identify it; otherwise re-throw as a duplicate
      // schema_invalid so the agent rotates their nonce / hash.
      const existingAfter = submissionsRepo.findByClientOrderId(
        db,
        identity.agent_id,
        submission.client_order_id,
      );
      if (existingAfter) {
        return loadExistingFheDirectCall(db, existingAfter.call_id, true);
      }
      throw new VerdictError(
        "fhe_direct: duplicate ciphertext_hash or (keyset_id, nonce) — agent must rotate nonce or resubmit with fresh entropy",
        ERROR_CODES.duplicate,
        409,
      );
    }
    throw err;
  }

  submissionsRepo.setStatus(db, call_id, "pending_t0");
  usageRepo.emit(
    db,
    makeUsage(
      identity.agent_id,
      "submission_accepted",
      {
        call_id,
        privacy_mode: "fhe_direct",
        commit_hash: fheCommit.commit_hash,
        keyset_id: validated.keyset.keyset_id,
      },
      now,
    ),
  );

  // SSE/webhook event — operator-blind projection. Subscribers see
  // commit_hash, keyset_id, ciphertext_hash. NO side, NO confidence,
  // NO ciphertext bytes. This is the load-bearing guard: every fan-out
  // surface must consult the fhe block (or the projection helper) and
  // never the synthesized placeholder on the AcceptedCall.
  ctx.events?.emit({
    type: "call.accepted",
    call_id,
    agent_id: agent.agent_id,
    agent_slug: agent.display_slug,
    privacy_mode: "fhe_direct",
    accepted_at,
    commit_hash: fheCommit.commit_hash,
    // Phase 10 / Z4-extra discriminators. fhe_direct calls still
    // belong to an adapter/family — Polymarket can submit fhe_direct
    // once P11.5 lands. Subscribers route on these without leaking
    // plaintext.
    adapter_id: market.adapter_id ?? "native-price",
    market_family: market.market_family ?? "financial-direction",
    market_id: market.market_id,
  });

  // Return a publicly-safe shape: the synthesized AcceptedCall is what
  // the legacy /v2/calls response shape expects (call_id + call), but
  // we redact the leak-y fields so a curious client logging the
  // response doesn't accidentally cache a placeholder side/confidence.
  // (The router strips these explicitly via a projection step, but
  // belt-and-braces here closes the gap if a future caller forgets.)
  const redacted: AcceptedCall = {
    ...acceptedRow,
    side: undefined as unknown as AcceptedCall["side"],
    confidence: undefined as unknown as AcceptedCall["confidence"],
    asset_id: undefined as unknown as AcceptedCall["asset_id"],
    horizon_hours: undefined as unknown as AcceptedCall["horizon_hours"],
  };
  return {
    call: redacted,
    status: "accepted",
    idempotent_hit: idempotentHit,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Suppress unused-import warnings — these are part of the fhe_direct
// surface and kept in scope for the helper's type signature even when
// the helper does not directly invoke them.
void buildFheCommit;
void validateFheSubmission;
void insertFheCiphertext;
type _FheSubmissionBlock = FheSubmissionBlock;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeUsage(
  agent_id: string | null,
  kind: UsageEvent["kind"],
  attributes: Record<string, unknown>,
  now: () => Date,
): UsageEvent {
  return {
    event_id: randomUUID(),
    agent_id,
    kind,
    ts: nowIso(now()),
    attributes,
  };
}

function nowIso(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Z1 — idempotent loader for fhe_direct rows. AcceptedCallSchema requires
 * non-null side/asset_id/horizon_hours/confidence, but fhe_direct rows
 * deliberately persist all four as NULL (operator-blind invariant). We
 * build the AcceptedCall via the loose cast that the submit path already
 * uses, so an idempotent retry hydrates exactly what the original submit
 * returned — null on every plaintext field, populated on call_id /
 * accepted_at / status / strategy_tag.
 */
function loadExistingFheDirectCall(
  db: Database.Database,
  call_id: string,
  idempotent_hit: boolean,
): SubmitResult {
  const row = db
    .prepare(
      `SELECT s.call_id, s.agent_id, s.client_order_id, s.submitted_at,
              s.accepted_at, s.strategy_tag, s.rationale,
              s.schema_version, s.scoring_version,
              op.primary_feed, op.fallback_feed, op.primary_max_staleness_sec,
              op.fallback_max_staleness_sec, op.t0_grace_seconds, op.t0_extended_grace_seconds
       FROM submissions s
       JOIN oracle_policies op ON op.call_id = s.call_id
       WHERE s.call_id = ?`,
    )
    .get(call_id) as Record<string, unknown> | undefined;
  if (!row) {
    throw new VerdictError(
      "call vanished after insert",
      ERROR_CODES.internal_error,
      500,
    );
  }
  // Build a synthetic AcceptedCall whose plaintext fields are undefined
  // (so JSON serialization drops them on the wire). The cast bypasses
  // AcceptedCallSchema for the same reason the submit path bypasses
  // it: the schema predates operator-blind privacy.
  const accepted = {
    schema_version: row.schema_version,
    scoring_version: row.scoring_version,
    call_id: row.call_id,
    agent_id: row.agent_id,
    client_order_id: row.client_order_id,
    submitted_at: row.submitted_at,
    accepted_at: row.accepted_at,
    status: "accepted" as const,
    ...(row.rationale ? { rationale: row.rationale } : {}),
    ...(row.strategy_tag ? { strategy_tag: row.strategy_tag } : {}),
    oracle_policy: buildT0PolicyFromRow(row),
  } as unknown as AcceptedCall;
  return {
    call: accepted,
    status: "accepted",
    idempotent_hit,
  };
}

function loadExistingAcceptedCall(
  db: Database.Database,
  call_id: string,
  idempotent_hit: boolean,
): SubmitResult {
  // Wave 4b — receipts subsystem is gone; idempotent retries hydrate from
  // the submissions row alone. The call_id is the only canonical identifier
  // an old client expected back from this path.
  // Wave 4b-2 — preflights table dropped; oracle_policies remains as the
  // sole join below.
  // Codex Z2 Drift B follow-up — explicit submissions columns (was
  // `SELECT s.*`). Same defense-in-depth rationale as
  // resolutionsRepo.loadFullCall: a future plaintext column added to
  // submissions would land in the row dict on day one with no audit
  // moment, and a naive widening of AcceptedCallSchema.parse below
  // would auto-surface it. Enumerating fields here forces a deliberate
  // review.
  const stmt = db.prepare(`
    SELECT s.schema_version, s.scoring_version,
           s.call_id, s.agent_id, s.client_order_id,
           s.asset_id, s.side, s.horizon_hours, s.confidence,
           s.submitted_at, s.accepted_at, s.rationale, s.strategy_tag,
           op.primary_feed, op.fallback_feed, op.primary_max_staleness_sec,
           op.fallback_max_staleness_sec, op.t0_grace_seconds, op.t0_extended_grace_seconds
    FROM submissions s
    JOIN oracle_policies op ON op.call_id = s.call_id
    WHERE s.call_id = ?
  `);
  const row = stmt.get(call_id) as Record<string, unknown> | undefined;
  if (!row) {
    throw new VerdictError(
      "call vanished after insert",
      ERROR_CODES.internal_error,
      500,
    );
  }
  const accepted = AcceptedCallSchema.parse({
    schema_version: row.schema_version,
    scoring_version: row.scoring_version,
    call_id: row.call_id,
    agent_id: row.agent_id,
    client_order_id: row.client_order_id,
    asset_id: row.asset_id,
    side: row.side,
    horizon_hours: row.horizon_hours,
    confidence: row.confidence,
    submitted_at: row.submitted_at,
    rationale: row.rationale ?? undefined,
    strategy_tag: row.strategy_tag ?? undefined,
    accepted_at: row.accepted_at,
    status: "accepted",
    // P3 Phase 2d: oracle_policies fallback columns are nullable for
    // sub-hour Pyth-only markets. T0PolicySchema's optional fields accept
    // omission/undefined but NOT null; hydrate the conditional shape so
    // an idempotent retry on a Pyth-only call doesn't blow up at parse
    // time (Codex audit Bug 4).
    oracle_policy: buildT0PolicyFromRow(row),
  });
  return {
    call: accepted,
    status: "accepted",
    idempotent_hit,
  };
}

/**
 * Build a T0Policy object from an oracle_policies row read. Sub-hour
 * Pyth-only markets stamp NULL into fallback_feed + fallback_max_staleness_sec
 * (migration 011); T0PolicySchema's optional fields accept omission/undefined
 * but NOT null. This helper translates row nulls → omitted keys so the
 * caller's Zod parse succeeds (Codex audit Bug 4).
 */
function buildT0PolicyFromRow(row: Record<string, unknown>): T0Policy {
  const hasFeed = row.fallback_feed !== null;
  const hasStaleness = row.fallback_max_staleness_sec !== null;
  if (hasFeed !== hasStaleness) {
    throw new Error(
      `oracle_policies row has half-configured fallback (fallback_feed=${hasFeed ? "set" : "null"}, fallback_max_staleness_sec=${hasStaleness ? "set" : "null"}); both must be set or both NULL`,
    );
  }
  return {
    primary_feed: row.primary_feed as T0Policy["primary_feed"],
    primary_max_staleness_sec: row.primary_max_staleness_sec as number,
    t0_grace_seconds: row.t0_grace_seconds as number,
    t0_extended_grace_seconds: row.t0_extended_grace_seconds as number,
    ...(row.fallback_feed !== null && row.fallback_max_staleness_sec !== null
      ? {
          fallback_feed: row.fallback_feed as NonNullable<
            T0Policy["fallback_feed"]
          >,
          fallback_max_staleness_sec: row.fallback_max_staleness_sec as number,
        }
      : {}),
  };
}

// Wave 2b — `deriveLegacyCommitment` and `commitmentToWire` deleted.
// Under FHE-mandatory the only path stamping `commitment_json` /
// `predicted_outcome_json` is the fhe_direct branch (which writes NULL
// into both, per the operator-blind invariant). The legacy plaintext
// fallthrough in submitCall() now stamps null directly.
