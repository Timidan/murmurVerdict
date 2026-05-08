import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AcceptanceReceiptPayloadSchema,
  AcceptedCall,
  AcceptedCallSchema,
  CallStatus,
  DEFAULT_T0_POLICY,
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
import { buildAcceptanceReceipt } from "../receipts/verdictReceipt.js";
import { canonicalHash } from "../receipts/canonical.js";
import { evaluateRisk, type MarketContext } from "./risk.js";
import type { VerdictEventBus } from "./events.js";
import {
  buildCommit,
  buildMarketCommit,
  COMMIT_PREIMAGE_SCHEMA,
  MARKET_COMMIT_PREIMAGE_SCHEMA,
  REVEAL_GRACE_MS,
} from "./commit-preimage.js";
import {
  acceptsSubmissions,
  buildMarketDedupKey,
  perMarketDailyCap,
  resolveMarketFromPayload,
} from "./markets.js";
import type { MarketRow } from "./db.js";

/**
 * Privacy modes the v0.2 daemon accepts at submit. Codex Phase B review
 * H2: an unrecognized privacy_mode (typo, future v0.3 mode) MUST NOT
 * silently fall through to legacy plaintext — that's an accidental
 * privacy downgrade vector. v0.3 will extend this set with 'fhevm' (or
 * similar) only when the daemon has the corresponding code path; until
 * then, any string outside this set is rejected with schema_invalid.
 */
const ACCEPTED_PRIVACY_MODES = new Set(["committed", "legacy_plaintext"] as const);
import { encryptEnvelope, type AgeContext } from "./age-envelope.js";
import { encryptToDrandRound, type DrandContext } from "./drand-envelope.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface SubmissionContext {
  /** Build current market context for the asset; the pipeline is upstream of risk. */
  marketContext: (asset_id: AssetId) => Promise<MarketContext>;
  /** Optional Filecoin pin; null to skip in v0.1. */
  pinReceipt?: (canonical_json: string) => Promise<string | null>;
  /** Now provider; injectable for tests. */
  now?: () => Date;
  /** Per-call oracle policy; defaults to DEFAULT_T0_POLICY. */
  oraclePolicy?: T0Policy;
  /**
   * P2 committed-mode age context. When present, agents may submit with
   * privacy_mode='committed' and the daemon encrypts the envelope to the
   * configured age recipient. When absent (no MURMUR_DAEMON_AGE_RECIPIENT),
   * committed-mode submissions are rejected with 503; legacy_plaintext
   * submissions are unaffected.
   */
  ageContext?: AgeContext;
  /**
   * Optional parallel drand/tlock encryption context (D21). When opted-in
   * via MURMUR_DRAND_ENABLED, every committed-mode submit ALSO produces
   * a tlock ciphertext bound to a future drand round. The v2 acceptance
   * receipt's `drand` block records (chain_hash, round, ciphertext_hash)
   * so anyone with the receipt can decrypt at the round without daemon
   * cooperation. drand failures are best-effort: age envelope still
   * persists, drand ciphertext is just absent.
   */
  drandContext?: DrandContext;
  /** Optional event bus for SSE fan-out. Emit on accept; no-op when undefined. */
  events?: VerdictEventBus;
}

export interface AuthIdentity {
  agent_id: string;
}

export interface SubmitResult {
  call: AcceptedCall;
  receipt_hash: `0x${string}`;
  filecoin_cid: string | null;
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
import type { AssetId } from "./schema.js";

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
}): Promise<SubmitResult> {
  const { db, ctx, identity, payload } = args;
  const now = ctx.now ?? (() => new Date());
  const oraclePolicy = ctx.oraclePolicy ?? DEFAULT_T0_POLICY;

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

  // P3: normalize the submission shape — fill in whichever side of the
  // either/or wire shape is missing. Receipts, dedup, and persistence all
  // see asset_id + horizon_hours + market_id populated. The ORIGINAL wire
  // shape is preserved in `rawSubmission` for request_hash computation
  // (committed-mode receipts) so a verifier can recanonicalize the agent's
  // bytes without daemon mutation.
  const horizonHoursFromMarket = Math.round(market.horizon_seconds / 3600);
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

  // 6. preflight via risk evaluator. P3: submission is post-normalization
  // so asset_id is always populated; assert non-null for the legacy
  // marketContext signature. evaluateRisk gets a MarketContext (the legacy
  // ad-hoc shape); the new MarketRow stays in scope as `market`.
  const marketCtx = await ctx.marketContext(submission.asset_id!);
  const { preflight } = evaluateRisk(submission, marketCtx);

  // 7. build acceptance receipt
  const call_id = randomUUID();
  // accepted_at already computed above for dedup; reuse so the receipt records
  // the same instant we used for dedup bucketing.
  // Pillar-4 marketplace portability: include the issuing agent's wallet +
  // chain_id in the receipt subject when available. Off-Murmur verifiers can
  // then attest the (wallet → score) relationship without a daemon round-trip.
  const issuingAgent = agentsRepo.byId(db, submission.agent_id);

  // P2 committed mode: when the agent opted in via privacy_mode='committed',
  // build a v2 acceptance receipt that omits the plaintext envelope from
  // the receipt subject and binds to a commit_hash + age envelope instead.
  // Falls back to v1 (legacy_plaintext) for benchmark/shadow agents (D20).
  let receipt: { canonical_json: string; receipt_hash: `0x${string}` };
  let envelopeForRepo: AcceptanceWriteInput["envelope"];
  let privacyModeForRepo: string = "legacy_plaintext";
  let commitHashForRepo: string | undefined;
  let commitSchemeForRepo: string | undefined;

  // F3: reject unknown privacy_mode strings BEFORE branching. Closes
  // the Codex H2 silent-downgrade vector.
  if (
    submission.privacy_mode !== undefined &&
    !ACCEPTED_PRIVACY_MODES.has(submission.privacy_mode as never)
  ) {
    throw new VerdictError(
      `unknown privacy_mode '${submission.privacy_mode}' — must be one of: ${[...ACCEPTED_PRIVACY_MODES].join(", ")}`,
      ERROR_CODES.schema_invalid,
      400,
    );
  }

  if (submission.privacy_mode === "committed") {
    // F2: gate committed-mode behind a feature flag until Phase E
    // ships projection scrubbing. Codex Phase B review C2: today the
    // daemon ACCEPTS committed submits, encrypts the receipt subject
    // properly, but /v1/feed/today + /v1/agents/:slug/calls + SSE
    // events + webhooks STILL select plaintext from the submissions
    // table. The committed path is therefore only meaningful once
    // those surfaces are scrubbed. Until then, refuse — operator can
    // opt in for testing via env.
    if (process.env.MURMUR_PRIVACY_COMMITTED_OPEN !== "1") {
      throw new VerdictError(
        "committed-mode submissions are gated until projection scrubbing lands (Phase E); set MURMUR_PRIVACY_COMMITTED_OPEN=1 on the daemon to opt in for testing",
        ERROR_CODES.agent_not_authorized,
        503,
      );
    }
    const ageCtx = ctx.ageContext;
    if (!ageCtx) {
      throw new VerdictError(
        "daemon not configured for committed-mode submissions (set MURMUR_DAEMON_AGE_RECIPIENT)",
        ERROR_CODES.internal_error,
        503,
      );
    }
    if (
      !issuingAgent?.wallet_address ||
      !issuingAgent.chain_id ||
      !["verified", "wallet_only"].includes(issuingAgent.kind)
    ) {
      throw new VerdictError(
        "committed-mode submissions require kind ∈ (verified, wallet_only) and a wallet binding",
        ERROR_CODES.agent_not_authorized,
        403,
      );
    }
    if (!submission.salt) {
      // Schema-level superRefine should have caught this; defensive recheck.
      throw new VerdictError(
        "salt is required for committed-mode submissions",
        ERROR_CODES.schema_invalid,
        400,
      );
    }
    // F4: lowercase-normalize salt before hashing. Schema accepts
    // 64-char hex case-insensitive, but commit canonicalization MUST
    // be byte-stable — agents that uppercase the salt would otherwise
    // produce a different commit_hash than the daemon. Lowercase wins.
    const saltLower = submission.salt.toLowerCase();

    // P3 D4: dispatch on the WIRE shape, not the normalized submission.
    // Agents that submitted with explicit market_id get a v0.2.5 preimage
    // (market_id + market_config_version). Legacy (asset_id, horizon_hours)
    // payloads keep emitting the v0.2 schema so existing verifiers and
    // already-published preimages stay byte-compatible.
    let commit_hash: `0x${string}`;
    let preimage_canonical: string;
    let usedPreimageSchema: string;
    if (wireUsedMarketId) {
      ({ commit_hash, preimage_canonical } = buildMarketCommit({
        call_id,
        agent_wallet: issuingAgent.wallet_address,
        chain_id: issuingAgent.chain_id,
        side: submission.side,
        market_id: market.market_id,
        market_config_version: market.market_config_version,
        confidence: submission.confidence,
        salt: saltLower,
        // D16: t0 is daemon-canonical accepted_at.
        t0: accepted_at,
      }));
      usedPreimageSchema = MARKET_COMMIT_PREIMAGE_SCHEMA;
    } else {
      ({ commit_hash, preimage_canonical } = buildCommit({
        call_id,
        agent_wallet: issuingAgent.wallet_address,
        chain_id: issuingAgent.chain_id,
        side: submission.side,
        asset_id: submission.asset_id!,
        horizon_hours: submission.horizon_hours!,
        confidence: submission.confidence,
        salt: saltLower,
        t0: accepted_at,
      }));
      usedPreimageSchema = COMMIT_PREIMAGE_SCHEMA;
    }
    // Envelope plaintext = canonical preimage JSON + the not-committed
    // metadata (rationale, strategy_tag) per D18. Daemon decrypts at
    // fallback_after if the agent hasn't revealed; agent reveals
    // voluntarily by re-posting the preimage to /v1/calls/:id/reveal.
    const envelopeBody = JSON.stringify({
      preimage_canonical,
      rationale: submission.rationale ?? null,
      strategy_tag: submission.strategy_tag ?? null,
    });
    const envelopeBytes = new TextEncoder().encode(envelopeBody);
    const encrypted = await encryptEnvelope(ageCtx, envelopeBytes);
    // fallback_after = accepted_at + horizon + REVEAL_GRACE_MS (D17).
    // The constant is locked, not configurable — see commit-preimage.ts.
    // P3: read horizon from the market row (not submission.horizon_hours)
    // so sub-hour markets compute fallback correctly when they're listed.
    //
    // P3 Phase 2a hardening (Codex audit): anchor fallback_after to the
    // CAPTURED accepted_at, not a fresh now() call. accepted_at was
    // stamped above for dedup; reusing it here keeps the receipt's
    // (accepted_at, fallback_after) pair coherent — a second now() can
    // drift by ~1s across the boundary, leaving fallback_after slightly
    // off the receipt-attested anchor.
    const fallback_after_ms =
      Date.parse(accepted_at) + market.horizon_seconds * 1_000 + REVEAL_GRACE_MS;
    const fallback_after = new Date(fallback_after_ms)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");

    // Optional parallel drand/tlock envelope (D21). Best-effort: a
    // network failure or schema mismatch falls back to age-only —
    // the receipt's `drand` block is only emitted on success so a
    // verifier knows whether the trustless reveal path is available.
    let drandEnvelope:
      | { chain_hash: string; round: number; ciphertext: string; ciphertext_hash: `0x${string}` }
      | null = null;
    const drandCtx = ctx.drandContext;
    if (drandCtx?.available) {
      try {
        drandEnvelope = await encryptToDrandRound(
          drandCtx,
          envelopeBytes,
          fallback_after_ms,
        );
      } catch (err) {
        // Don't fail the submit — drand is best-effort in v0.2; the
        // age envelope still lands. Log to stderr so an operator
        // notices repeated failures (e.g. drand network unreachable).
        const reason = err instanceof Error ? err.message : "unknown";
        console.warn(
          `[submit] drand timelock encrypt failed (call_id=${call_id}): ${reason}`,
        );
      }
    }
    // request_hash (D23) = keccak256 of canonical agent submission body.
    // Lets a verifier chain to an immutable input without trusting the
    // daemon to keep the request body around.
    //
    // P3: use the RAW wire payload (pre-normalization) so a verifier
    // re-canonicalizes exactly what the agent sent — never the daemon's
    // synthesized fields. Agents who sent { market_id } get a request_hash
    // over { market_id }; agents who sent { asset_id, horizon_hours } get
    // a request_hash over the legacy tuple. Either reproduces from the
    // agent's own bytes.
    const request_hash = canonicalHash(rawSubmission);
    const v2payload = AcceptanceReceiptPayloadSchema.parse({
      schema_version: 2,
      scoring_version: SCORING_VERSION,
      receipt_kind: "acceptance",
      call_id,
      agent_id: submission.agent_id,
      accepted_at,
      privacy_mode: "committed",
      commit: {
        hash: commit_hash,
        scheme: "keccak256",
        preimage_schema: usedPreimageSchema,
      },
      preflight,
      oracle_policy: oraclePolicy,
      agent_wallet: issuingAgent.wallet_address,
      chain_id: issuingAgent.chain_id,
      request_hash,
      fallback: {
        encrypted_body_alg: encrypted.alg,
        daemon_key_id: encrypted.daemon_key_id,
        encrypted_body_hash: encrypted.encrypted_body_hash,
        fallback_after,
      },
      ...(drandEnvelope
        ? {
            drand: {
              chain_hash: drandEnvelope.chain_hash,
              round: drandEnvelope.round,
              ciphertext_hash: drandEnvelope.ciphertext_hash,
            },
          }
        : {}),
    });
    receipt = buildAcceptanceReceipt(v2payload);
    privacyModeForRepo = "committed";
    commitHashForRepo = commit_hash;
    commitSchemeForRepo = "keccak256";
    envelopeForRepo = {
      encrypted_body: encrypted.ciphertext_base64,
      encrypted_body_alg: encrypted.alg,
      encrypted_body_hash: encrypted.encrypted_body_hash,
      daemon_key_id: encrypted.daemon_key_id,
      commit_preimage_schema: usedPreimageSchema,
      fallback_after,
      received_at: accepted_at,
      ...(drandEnvelope
        ? {
            drand_chain_hash: drandEnvelope.chain_hash,
            drand_round: drandEnvelope.round,
            drand_ciphertext: drandEnvelope.ciphertext,
            drand_ciphertext_hash: drandEnvelope.ciphertext_hash,
          }
        : {}),
    };
  } else {
    // v1 (legacy_plaintext) receipts embed the submission verbatim. The
    // wire schema rejects payloads carrying BOTH market_id and (asset_id,
    // horizon_hours), so the embedded submission keeps the legacy shape —
    // strip market_id from the embedded form. For agents that USED the
    // market_id wire shape, surface it at the receipt's top level
    // alongside market_config_version so verifiers can reproduce the
    // submitted selector even though v1 has no request_hash.
    const v1Submission: SubmittedCall = { ...submission };
    delete (v1Submission as { market_id?: string }).market_id;
    const v1payload = AcceptanceReceiptPayloadSchema.parse({
      schema_version: SCHEMA_VERSION,
      scoring_version: SCORING_VERSION,
      submission: v1Submission,
      preflight,
      oracle_policy: oraclePolicy,
      accepted_at,
      call_id,
      ...(issuingAgent?.wallet_address ? { agent_wallet: issuingAgent.wallet_address } : {}),
      ...(issuingAgent?.chain_id ? { chain_id: issuingAgent.chain_id } : {}),
      ...(wireUsedMarketId
        ? {
            market_id: market.market_id,
            market_config_version: market.market_config_version,
          }
        : {}),
    });
    receipt = buildAcceptanceReceipt(v1payload);
  }

  // 8. optional Filecoin pin
  let filecoin_cid: string | null = null;
  if (ctx.pinReceipt) {
    try {
      filecoin_cid = (await ctx.pinReceipt(receipt.canonical_json)) ?? null;
    } catch {
      // best-effort; do not block on Filecoin in v0.1
    }
  }

  // 9. construct AcceptedCall, validate, persist atomically
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
    preflight,
    oracle_policy: oraclePolicy,
    acceptance_receipt_hash: receipt.receipt_hash,
    acceptance_receipt_cid: filecoin_cid ?? undefined,
  });

  try {
    submissionsRepo.acceptCall(db, {
      submission,
      accepted,
      receipt: {
        hash: receipt.receipt_hash,
        canonical_json: receipt.canonical_json,
        filecoin_cid: filecoin_cid ?? undefined,
      },
      dedup_key,
      privacy_mode: privacyModeForRepo,
      market_id: market.market_id,
      market_config_version: market.market_config_version,
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
  const isCommittedEvent = privacyModeForRepo === "committed";
  usageRepo.emit(
    db,
    makeUsage(
      identity.agent_id,
      "submission_accepted",
      isCommittedEvent
        ? {
            call_id,
            privacy_mode: privacyModeForRepo,
            commit_hash: commitHashForRepo,
          }
        : {
            call_id,
            asset_id: submission.asset_id,
            side: submission.side,
            horizon_hours: submission.horizon_hours,
          },
      now,
    ),
  );

  // Scrub plaintext from the SSE/webhook event when committed-mode
  // (Phase E). Subscribers see commit_hash + acceptance_receipt_hash;
  // they can fetch /v1/calls/:id/envelope to attest the ciphertexts
  // committed to. The plaintext only fans out post-horizon.
  ctx.events?.emit({
    type: "call.accepted",
    call_id,
    agent_id: agent.agent_id,
    agent_slug: agent.display_slug,
    privacy_mode: privacyModeForRepo,
    accepted_at,
    ...(commitHashForRepo ? { commit_hash: commitHashForRepo } : {}),
    ...(receipt.receipt_hash ? { acceptance_receipt_hash: receipt.receipt_hash } : {}),
    ...(isCommittedEvent
      ? {}
      : {
          side: submission.side,
          asset_id: submission.asset_id,
          horizon_hours: submission.horizon_hours,
          confidence: submission.confidence,
        }),
  });

  return {
    call: accepted,
    receipt_hash: receipt.receipt_hash,
    filecoin_cid,
    status: "accepted",
    idempotent_hit: false,
  };
}

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

function loadExistingAcceptedCall(
  db: Database.Database,
  call_id: string,
  idempotent_hit: boolean,
): SubmitResult {
  // For v0.1 we reload the receipt + accepted snapshot via raw queries; this
  // is intentionally minimal — full hydrators land alongside the read API in
  // a later iteration.
  const stmt = db.prepare(`
    SELECT s.*, p.murmur_score, p.murmur_playbook, p.risk_flags_json,
           p.data_freshness_seconds, p.market_regime,
           op.primary_feed, op.fallback_feed, op.primary_max_staleness_sec,
           op.fallback_max_staleness_sec, op.t0_grace_seconds, op.t0_extended_grace_seconds,
           r.receipt_hash AS acceptance_receipt_hash, r.filecoin_cid AS acceptance_receipt_cid
    FROM submissions s
    JOIN preflights p ON p.call_id = s.call_id
    JOIN oracle_policies op ON op.call_id = s.call_id
    LEFT JOIN receipts r ON r.call_id = s.call_id AND r.kind = 'acceptance'
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
    preflight: {
      murmur_score: row.murmur_score,
      murmur_playbook: row.murmur_playbook,
      risk_flags: JSON.parse(row.risk_flags_json as string),
      data_freshness_seconds: row.data_freshness_seconds,
      market_regime: row.market_regime,
    },
    oracle_policy: {
      primary_feed: row.primary_feed,
      fallback_feed: row.fallback_feed,
      primary_max_staleness_sec: row.primary_max_staleness_sec,
      fallback_max_staleness_sec: row.fallback_max_staleness_sec,
      t0_grace_seconds: row.t0_grace_seconds,
      t0_extended_grace_seconds: row.t0_extended_grace_seconds,
    },
    acceptance_receipt_hash: row.acceptance_receipt_hash,
    acceptance_receipt_cid: row.acceptance_receipt_cid ?? undefined,
  });
  return {
    call: accepted,
    receipt_hash: accepted.acceptance_receipt_hash as `0x${string}`,
    filecoin_cid: accepted.acceptance_receipt_cid ?? null,
    status: "accepted",
    idempotent_hit,
  };
}
