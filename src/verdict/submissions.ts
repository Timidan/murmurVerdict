import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AcceptedCall,
  AcceptedCallSchema,
  CallStatus,
  DEFAULT_T0_POLICY,
  ERROR_CODES,
  StrategyTag,
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
  marketsRepo,
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
import { legacySubmissionToCommitment } from "./submission-normalizers.js";
import {
  derivePolicyFromMarket,
  PolicyDerivationError,
} from "./oracle-routing.js";
import type { MarketRow } from "./db.js";

/**
 * Privacy modes the daemon accepts at submit.
 *
 * Demand-evidence retreat: `fhe_direct` was previously accepted, but the
 * threshold-release pipeline that turned an encrypted score into a public
 * call_score was removed (retreat-001). Without a terminal decrypt path,
 * fhe_direct rows would sit at status='pending_t1' forever — accepting them
 * is operator-trapping, not operator-blind. Refuse them at the gate until
 * a real holder committee + sidecar decrypt path lands together.
 *
 * The mock FHE provider isn't "real" privacy. ZamaLocalFheProvider.decryptScore
 * deliberately throws ("Single-operator decrypt is refused"), so even with the
 * real Zama sidecar this mode has no terminal path. The honest fix: only accept
 * the mode the daemon can actually resolve end-to-end.
 */
export const ACCEPTED_PRIVACY_MODES: ReadonlySet<string> = new Set<string>([
  "legacy_plaintext",
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
  /** Cleartext legacy payload persisted separately from the post-031
   * submissions schema so the dropped plaintext columns stay dropped. */
  legacyPayloadJson?: string | null;
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

  // Demand-evidence retreat: fhe_direct submissions are refused at the
  // submit boundary because the threshold-release pipeline that turned
  // an encrypted score into a public call_score was removed
  // (retreat-001). Without a terminal path, accepting these submissions
  // leaves them stranded at pending_t1 — operator-trapping rather than
  // operator-blind. The /v2/calls route also rejects this case with a
  // matching 422; this branch is defense in depth for any internal
  // caller that bypasses the route.
  if (
    args.fheDirect !== undefined ||
    (isObject(payload) && payload.privacy_mode === "fhe_direct")
  ) {
    throw new VerdictError(
      "fhe_direct submissions are not currently supported: no terminal score-release path is wired. Use privacy_mode='legacy_plaintext'.",
      ERROR_CODES.asset_not_supported,
      422,
      { reason: "fhe_direct_unsupported_no_committee" },
    );
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
  let derivedOraclePolicy: T0Policy | null;
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
  // Wave 4a — null means adapter-resolved market (Polymarket Gamma +
  // future external adapters); the policy slot stays empty on the
  // AcceptedCall (optional per the operator-blind shape).
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
  // Wave 3 — the per-asset daily cap was removed alongside the asset_id
  // column drop in MIGRATION_031. The per-market cap below subsumes it
  // for the common case (one market per asset); a family-aggregate cap
  // can re-land on (agent_id, market_family) once we have load telemetry.
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
  // Wave 3 — the call_private_envelopes table was dropped, so the
  // envelope field is gone from AcceptanceWriteInput.
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
  const acceptedAssetId = submission.asset_id ?? market.asset_id;
  const acceptedHorizonHours =
    submission.horizon_hours ?? legacyHorizonHoursForMarket(market);
  const accepted: AcceptedCall = AcceptedCallSchema.parse({
    schema_version: SCHEMA_VERSION,
    scoring_version: SCORING_VERSION,
    call_id,
    agent_id: submission.agent_id,
    client_order_id: submission.client_order_id,
    asset_id: acceptedAssetId,
    side: submission.side,
    horizon_hours: acceptedHorizonHours,
    confidence: submission.confidence,
    submitted_at: submission.submitted_at,
    rationale: submission.rationale,
    strategy_tag: submission.strategy_tag,
    accepted_at,
    status: "accepted",
    ...(oraclePolicy ? { oracle_policy: oraclePolicy } : {}),
  });

  const expectedResolvesAtIso = nowIso(
    new Date(Date.parse(accepted_at) + market.horizon_seconds * 1000),
  );
  const commitment =
    precomputedCommitment ??
    legacySubmissionToCommitment({
      side: submission.side,
      confidence: submission.confidence,
      asset_id: acceptedAssetId,
      horizon_hours: acceptedHorizonHours,
      expected_resolves_at_iso: expectedResolvesAtIso,
      market_id: market.market_id,
      market_config_version: market.market_config_version,
    });
  const commitmentWire = commitmentToWire(commitment);
  const commitmentJsonStamp = JSON.stringify(commitmentWire);
  const predictedOutcomeJsonStamp = JSON.stringify(commitmentWire.predictedOutcome);
  const outcomeLabelsJsonStamp = args.outcomeLabels
    ? JSON.stringify([...args.outcomeLabels])
    : null;
  const legacyPayloadJsonStamp =
    args.legacyPayloadJson ??
    JSON.stringify({
      side: submission.side,
      asset_id: acceptedAssetId,
      horizon_hours: acceptedHorizonHours,
      confidence: submission.confidence,
      market_id: market.market_id,
    });

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
      legacy_payload_json: legacyPayloadJsonStamp,
      ...(commitHashForRepo ? { commit_hash: commitHashForRepo } : {}),
      ...(commitSchemeForRepo ? { commit_scheme: commitSchemeForRepo } : {}),
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

  // 5. Derive oracle policy. Wave 4a — `derivePolicyFromMarket` returns
  //    null for adapter-resolved markets (Polymarket Gamma + future
  //    event-adapter markets). The AcceptedCall's oracle_policy slot is
  //    optional in that case; adapter dispatch handles resolution end-
  //    to-end via observeResolution.
  let oraclePolicy: T0Policy | null;
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

  // 7. accepted_at stamp + dedup-key bucket. Wave 3 — `side` is no
  //    longer part of the key (buildMarketDedupKey collapses opposite
  //    directions in the same bucket). The fhe_direct path was the
  //    last consumer that needed the side-free shape; with the legacy
  //    plaintext path's bucket realigned, both paths now produce the
  //    same per-(agent, market, bucket) key.
  const accepted_at = nowIso(now());
  const dedup_key = buildMarketDedupKey({
    agent_id: identity.agent_id,
    market_id: market.market_id,
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

  // 10. Persist. Wave 3 — the four plaintext columns (side / asset_id /
  //     horizon_hours / confidence) are gone from the submissions table;
  //     the AcceptedCall type's matching fields are now optional. The
  //     synthesized acceptedRow leaves them undefined so the operator-
  //     blind invariant is enforced at the SCHEMA layer, not by a
  //     downstream null-out UPDATE. The Commitment ciphertext on
  //     fhe_call_ciphertexts remains the only durable record of the
  //     prediction.
  const submittedAt =
    submission.submitted_at ?? accepted_at;
  // FheDirectPayloadSchema types `strategy_tag` as a bounded free-form
  // string (operator label, no enum); AcceptedCallSchema narrows it to
  // the StrategyTag enum for v1 receipt back-compat. The cast bridges
  // the two — operator-blind privacy doesn't care about the label
  // taxonomy, so loosening the AcceptedCall side is a Wave 4a chore.
  const acceptedRow: AcceptedCall = {
    schema_version: SCHEMA_VERSION,
    scoring_version: SCORING_VERSION,
    call_id,
    agent_id: submission.agent_id,
    client_order_id: submission.client_order_id,
    submitted_at: submittedAt,
    ...(submission.rationale !== undefined
      ? { rationale: submission.rationale }
      : {}),
    ...(submission.strategy_tag !== undefined
      ? { strategy_tag: submission.strategy_tag as StrategyTag }
      : {}),
    accepted_at,
    status: "accepted",
    ...(oraclePolicy ? { oracle_policy: oraclePolicy } : {}),
  };

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
          // The repo uses these fields only for the legacy v1 row
          // shape; the FHE-direct write path doesn't persist any of
          // them onto the submissions row anymore (MIGRATION_031
          // dropped the columns). Pass a minimal valid SubmittedCall
          // shape so the AcceptanceWriteInput typecheck succeeds.
          market_id: market.market_id,
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
        // Operator-blind invariant: the Commitment + Outcome rows on
        // submissions stay NULL for FHE-direct calls. The encrypted
        // prediction lives in fhe_call_ciphertexts; the resolver's
        // universal hot path short-circuits to the threshold-release
        // path instead of decoding commitment_json.
        commitment_json: null,
        predicted_outcome_json: null,
        outcome_labels_json: null,
        commit_hash: fheCommit.commit_hash,
        commit_scheme: "keccak256",
      });
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
 * Idempotent loader for fhe_direct rows. Wave 3 — the oracle_policies
 * table is gone (MIGRATION_031); T0Policy is re-derived from the call's
 * market_id via derivePolicyFromMarket(). The four plaintext market-
 * signal columns are gone too, so an idempotent retry rebuilds exactly
 * the operator-blind AcceptedCall the original submit returned.
 */
function loadExistingFheDirectCall(
  db: Database.Database,
  call_id: string,
  idempotent_hit: boolean,
): SubmitResult {
  const row = db
    .prepare(
      `SELECT call_id, agent_id, client_order_id, submitted_at,
              accepted_at, strategy_tag, rationale,
              schema_version, scoring_version, market_id
       FROM submissions
       WHERE call_id = ?`,
    )
    .get(call_id) as Record<string, unknown> | undefined;
  if (!row) {
    throw new VerdictError(
      "call vanished after insert",
      ERROR_CODES.internal_error,
      500,
    );
  }
  const retryPolicy = resolveOraclePolicyFromMarket(db, row.market_id);
  const accepted: AcceptedCall = {
    schema_version: row.schema_version as 1,
    scoring_version: row.scoring_version as 1,
    call_id: row.call_id as string,
    agent_id: row.agent_id as string,
    client_order_id: row.client_order_id as string,
    submitted_at: row.submitted_at as string,
    accepted_at: row.accepted_at as string,
    status: "accepted",
    ...(typeof row.rationale === "string" ? { rationale: row.rationale } : {}),
    ...(typeof row.strategy_tag === "string"
      ? { strategy_tag: row.strategy_tag as StrategyTag }
      : {}),
    ...(retryPolicy ? { oracle_policy: retryPolicy } : {}),
  };
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
  // Wave 3 — the four plaintext market-signal columns are gone, and the
  // oracle_policies join with them. Idempotent retries reconstruct the
  // AcceptedCall from the surviving columns + a fresh derivePolicyFromMarket
  // lookup. AcceptedCallSchema's plaintext fields are now optional, so the
  // parse succeeds without them.
  const stmt = db.prepare(`
    SELECT schema_version, scoring_version,
           call_id, agent_id, client_order_id,
           submitted_at, accepted_at, rationale, strategy_tag, market_id,
           legacy_payload_json
    FROM submissions
    WHERE call_id = ?
  `);
  const row = stmt.get(call_id) as Record<string, unknown> | undefined;
  if (!row) {
    throw new VerdictError(
      "call vanished after insert",
      ERROR_CODES.internal_error,
      500,
    );
  }
  const retryPolicy = resolveOraclePolicyFromMarket(db, row.market_id);
  const legacyPayload = parseLegacyPayloadJson(row.legacy_payload_json);
  const accepted = AcceptedCallSchema.parse({
    schema_version: row.schema_version,
    scoring_version: row.scoring_version,
    call_id: row.call_id,
    agent_id: row.agent_id,
    client_order_id: row.client_order_id,
    ...legacyPayload,
    submitted_at: row.submitted_at,
    rationale: row.rationale ?? undefined,
    strategy_tag: row.strategy_tag ?? undefined,
    accepted_at: row.accepted_at,
    status: "accepted",
    ...(retryPolicy ? { oracle_policy: retryPolicy } : {}),
  });
  return {
    call: accepted,
    status: "accepted",
    idempotent_hit,
  };
}

/**
 * Resolve a call's T0Policy by re-deriving it from the call's market_id.
 * Wave 3 replaced the per-call oracle_policies row with a fresh lookup
 * on the markets registry every time a hydrated AcceptedCall is needed.
 *
 * Codex Wave 3b review MAJOR #2 — the idempotent retry path needs to
 * survive a market that was retired or had a policy derivation glitch
 * between the original submit and the retry. The original submission
 * succeeded, so the retry MUST also succeed with the same call_id; the
 * AcceptedCall it returns is read-only for the client (the resolver does
 * its own per-tick policy walk via Resolver#policyFromCtx and routes its
 * own failures into oracle_unavailable). So when the live lookup blows
 * up, fall back to the v0.2 DEFAULT_T0_POLICY (ETH chainlink/pyth pair)
 * rather than 500-ing on the agent's retry. The DEFAULT_T0_POLICY is a
 * cosmetic value here — never used by the resolver, which reads its
 * own policy on each tick from the live registry (and surfaces
 * oracle_unavailable if the market is truly gone).
 *
 * A persistent per-call policy snapshot is Wave 4a/5 work; for v0.3
 * we'll either re-add a typed audit log keyed on market_config_version
 * or pin the policy into the FHE Commitment's marketRef.
 */
function resolveOraclePolicyFromMarket(
  db: Database.Database,
  market_id: unknown,
): T0Policy | null {
  if (typeof market_id !== "string" || market_id.length === 0) {
    return DEFAULT_T0_POLICY;
  }
  const market = marketsRepo.get(db, market_id);
  if (!market) {
    return DEFAULT_T0_POLICY;
  }
  try {
    // Wave 4a — null comes back for adapter-resolved markets
    // (Polymarket Gamma + future event-feed adapters); callers omit
    // the oracle_policy slot entirely in that case.
    return derivePolicyFromMarket(db, market);
  } catch (err) {
    // Half-configured fallback / unknown adapter in the markets row —
    // log + fall back. The resolver's per-tick path will mark the call
    // oracle_unavailable next tick if the market is genuinely broken.
    void err;
    return DEFAULT_T0_POLICY;
  }
}

function commitmentToWire(c: Commitment): {
  marketRef: Commitment["marketRef"];
  predictedOutcome: {
    kind: Commitment["predictedOutcome"]["kind"];
    payoutNumerators: string[];
    payoutDenominator: string;
    scalarValue?: string;
  };
  horizon: Commitment["horizon"];
  confidence: number;
} {
  return {
    marketRef: c.marketRef,
    predictedOutcome: {
      kind: c.predictedOutcome.kind,
      payoutNumerators: c.predictedOutcome.payoutNumerators.map((n) =>
        n.toString(),
      ),
      payoutDenominator: c.predictedOutcome.payoutDenominator.toString(),
      ...(c.predictedOutcome.scalarValue !== undefined
        ? { scalarValue: c.predictedOutcome.scalarValue.toString() }
        : {}),
    },
    horizon: c.horizon,
    confidence: c.confidence,
  };
}

const LegacyPayloadJsonSchema = z
  .object({
    side: z.enum(["BUY", "SELL"]),
    asset_id: z.string().min(1),
    horizon_hours: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(4),
      z.literal(24),
      z.literal(168),
    ]),
    confidence: z.number().min(0.51).max(0.95),
  })
  .strict();

function parseLegacyPayloadJson(
  raw: unknown,
): Partial<Pick<AcceptedCall, "side" | "asset_id" | "horizon_hours" | "confidence">> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    return LegacyPayloadJsonSchema.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}
