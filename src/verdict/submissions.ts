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
import { canonicalHash, canonicalize } from "../receipts/canonical.js";
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
  legacyHorizonHoursForMarket,
  perMarketDailyCap,
  resolveMarketFromPayload,
} from "./markets.js";
import {
  legacySubmissionToCommitment,
  type LegacySubmissionForCommitment,
} from "./submission-normalizers.js";
import type { Commitment } from "./markets-core.js";
import {
  derivePolicyFromMarket,
  PolicyDerivationError,
} from "./oracle-routing.js";
import type { MarketRow } from "./db.js";

/**
 * Privacy modes the v0.2 daemon accepts at submit. Codex Phase B review
 * H2: an unrecognized privacy_mode (typo, future v0.3 mode) MUST NOT
 * silently fall through to legacy plaintext — that's an accidental
 * privacy downgrade vector. v0.3 will extend this set with 'fhevm' (or
 * similar) only when the daemon has the corresponding code path; until
 * then, any string outside this set is rejected with schema_invalid.
 *
 * Z0 — operator-blind privacy foundation: when MURMUR_FHE_DIRECT_ENABLED=1,
 * we extend the set with 'fhe_direct' so the schema validator stops
 * fail-closing on it. The submission path itself still rejects with a
 * clear `z1_not_implemented` error — the encrypted submission code path
 * (`fhe.encrypted_predicted_outcome`, ciphertext binding, keyset FK)
 * lands in Z1. The flag is checked at module load via a closure so
 * test code that mutates process.env post-import doesn't see stale
 * state if it re-imports; the export is `readonly` to discourage
 * mutation from anywhere else.
 */
export const ACCEPTED_PRIVACY_MODES: ReadonlySet<string> = (() => {
  const base = new Set<string>(["committed", "legacy_plaintext"]);
  if (process.env.MURMUR_FHE_DIRECT_ENABLED === "1") {
    base.add("fhe_direct");
  }
  return base;
})();
import { encryptEnvelope, type AgeContext } from "./age-envelope.js";
import { encryptToDrandRound, type DrandContext } from "./drand-envelope.js";
import type { FheProvider } from "./fhe/provider.js";

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
   * Phase 4 /v2/calls handoff. When the request entered through the v2
   * surface, the route handler pre-validates the universal Commitment
   * via `adapter.commitmentSchema.parse(...)` and passes the resulting
   * runtime Commitment here. submitCall stamps it verbatim into
   * `submissions.commitment_json` / `predicted_outcome_json`.
   *
   * When omitted (every /v1 path), submitCall derives the Commitment
   * via `legacySubmissionToCommitment` so legacy + v2 paths produce
   * byte-identical universal columns for the same fundamental call.
   */
  precomputedCommitment?: Commitment;
  /** Phase 4 — render-only labels for the payout vector positions. Today
   *  always ['UP','DOWN'] for native-price; future adapters supply their
   *  own (e.g. ['YES','NO'] or category names). NEVER load-bearing for
   *  scoring (V2 §2.3); the leaderboard / dashboard just renders them. */
  outcomeLabels?: readonly string[];
}): Promise<SubmitResult> {
  const { db, ctx, identity, payload, precomputedCommitment } = args;
  const now = ctx.now ?? (() => new Date());
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

  // P2 committed mode: when the agent opted in via privacy_mode='committed',
  // build the commit_hash + age envelope. Falls back to legacy_plaintext for
  // benchmark/shadow agents (D20). Wave 4b — receipt building is gone;
  // commit_hash itself stays the canonical commitment artifact.
  let envelopeForRepo: AcceptanceWriteInput["envelope"];
  let privacyModeForRepo: string = "legacy_plaintext";
  let commitHashForRepo: string | undefined;
  let commitSchemeForRepo: string | undefined;

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

  // Z0 — fhe_direct is structurally accepted (so a 4xx upstream of the
  // submission path doesn't leak whether the operator has the flag on)
  // but the submission CODE PATH is owned by Z1. Return a precise,
  // documented error so callers don't mistake this for a transient
  // failure or silently degrade to legacy_plaintext. This branch goes
  // away when Z1 lands `src/verdict/fhe/submission.ts`.
  if (submission.privacy_mode === "fhe_direct") {
    throw new VerdictError(
      "fhe_direct submission path lands in Z1 (operator-blind submission); current daemon accepts the privacy_mode string but does not yet store encrypted predictions",
      ERROR_CODES.schema_invalid,
      501,
      { z1_not_implemented: true },
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
    // request_hash (D23) is still computed for committed-mode submissions:
    // it acts as the authenticated input bind even without a receipt to
    // anchor it. Future verify endpoints can recompute and compare against
    // an out-of-band record, but Wave 4b doesn't persist it.
    void canonicalHash(rawSubmission);
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
  }
  // Legacy plaintext branch falls through with privacyModeForRepo='legacy_plaintext'
  // — no commit_hash, no envelope. The submissions row carries the call's
  // canonical state directly; nothing else to stamp.

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

  // Phase 4 — derive (or reuse) the universal Commitment so /v1 and /v2
  // submit paths produce the same `commitment_json` / `predicted_outcome_json`
  // shape on disk. The resolver's universal hot path (Phase 5) reads
  // these columns directly; falling back to legacySubmissionToCommitment
  // there is the safety net but stamping at submit closes the gap so
  // every fresh row carries the canonical wire bytes already.
  //
  // Committed-mode (privacy_mode='committed') — these columns reveal the
  // predicted vector, which would defeat commit-reveal privacy. Skip the
  // stamp so committed rows keep `commitment_json IS NULL` until the
  // agent reveals.
  const commitmentForStamp: Commitment | null =
    privacyModeForRepo === "committed"
      ? null
      : (precomputedCommitment ??
        deriveLegacyCommitment(submission, market, accepted_at));
  const commitmentJsonStamp = commitmentForStamp
    ? canonicalize(commitmentToWire(commitmentForStamp))
    : null;
  const predictedOutcomeJsonStamp = commitmentForStamp
    ? canonicalize(commitmentToWire(commitmentForStamp).predictedOutcome)
    : null;
  // Render-only label vector. /v2 callers can pass adapter-specific
  // labels via args.outcomeLabels; legacy /v1 native-price rows default
  // to the canonical UP/DOWN pair so the dashboard chip code doesn't
  // need a per-row family fallback.
  const outcomeLabelsJsonStamp = commitmentForStamp
    ? JSON.stringify(args.outcomeLabels ?? ["UP", "DOWN"])
    : null;

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
  // (Phase E). Subscribers see commit_hash; they can fetch
  // /v1/calls/:id/envelope to attest the ciphertexts committed to.
  // The plaintext only fans out post-horizon.
  ctx.events?.emit({
    type: "call.accepted",
    call_id,
    agent_id: agent.agent_id,
    agent_slug: agent.display_slug,
    privacy_mode: privacyModeForRepo,
    accepted_at,
    ...(commitHashForRepo ? { commit_hash: commitHashForRepo } : {}),
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
  // Wave 4b — receipts subsystem is gone; idempotent retries hydrate from
  // the submissions row alone. The call_id is the only canonical identifier
  // an old client expected back from this path.
  // Wave 4b-2 — preflights table dropped; oracle_policies remains as the
  // sole join below.
  const stmt = db.prepare(`
    SELECT s.*,
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

// ─── Phase 4 — universal Commitment derivation helpers ──────────────────────

/**
 * Derive a runtime {@link Commitment} from a normalized SubmittedCall +
 * MarketRow tuple. Legacy /v1 callers don't supply a Commitment on the
 * wire; we synthesize one here from the legacy fields so /v1 + /v2 paths
 * agree on the byte shape stamped into `submissions.commitment_json`.
 *
 * Mirrors the inverse {@link legacySubmissionToCommitment} (used by the
 * resolver hot path on rows missing commitment_json) — the two helpers
 * MUST stay byte-identical or the resolver / submit boundary will see
 * drift on otherwise-equivalent calls.
 */
function deriveLegacyCommitment(
  submission: SubmittedCall,
  market: MarketRow,
  accepted_at_iso: string,
): Commitment {
  // accepted_at + horizon_seconds == expected resolution. The Commitment's
  // `horizon.iso` is render-only (resolver never reads it) so an
  // approximate ISO is fine; we still match what the resolver-side
  // synthesizer at submission-normalizers.ts:50 does to keep drift zero.
  const horizonMs =
    Date.parse(accepted_at_iso) + market.horizon_seconds * 1000;
  const expectedIso = new Date(horizonMs)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const legacy: LegacySubmissionForCommitment = {
    side: submission.side,
    confidence: submission.confidence,
    asset_id: submission.asset_id ?? market.asset_id,
    horizon_hours: submission.horizon_hours ?? Math.round(market.horizon_seconds / 3600),
    expected_resolves_at_iso: expectedIso,
    market_id: market.market_id,
    market_config_version: market.market_config_version,
  };
  return legacySubmissionToCommitment(legacy);
}

/**
 * Bigint → wire-string transform for canonicalization. {@link canonicalize}
 * runs through `JSON.stringify` which throws on bigint, so the
 * payoutNumerators / payoutDenominator / scalarValue fields are pre-mapped
 * to decimal-digit strings here (round-trips through CommitmentSchema and
 * back to bigint via {@link parseStoredCommitment}).
 */
function commitmentToWire(c: Commitment): {
  marketRef: { protocol: string; sourceId: string; configVersion: number };
  predictedOutcome: {
    kind: string;
    payoutNumerators: string[];
    payoutDenominator: string;
    scalarValue?: string;
  };
  horizon: { iso: string; resolvesAfterMin?: number };
  confidence: number;
} {
  return {
    marketRef: {
      protocol: c.marketRef.protocol,
      sourceId: c.marketRef.sourceId,
      configVersion: c.marketRef.configVersion,
    },
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
