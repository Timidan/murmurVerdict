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
  buildDedupKey,
  isUniqueViolation,
  submissionsRepo,
  usageRepo,
} from "./db.js";
import { buildAcceptanceReceipt } from "../receipts/verdictReceipt.js";
import { evaluateRisk, type MarketContext } from "./risk.js";
import type { VerdictEventBus } from "./events.js";

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
  const submission: SubmittedCall = parsed.data;

  if (submission.agent_id !== identity.agent_id) {
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

  // 3. idempotency on (agent_id, client_order_id)
  const existing = submissionsRepo.findByClientOrderId(
    db,
    identity.agent_id,
    submission.client_order_id,
  );
  if (existing) {
    return loadExistingAcceptedCall(db, existing.call_id, true);
  }

  // 4. rate limits
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
  const todayCount = submissionsRepo.countCallsForAgentAssetWindow(
    db,
    identity.agent_id,
    submission.asset_id,
    since,
  );
  if (todayCount >= SUBMISSION_LIMITS.max_calls_per_asset_per_day) {
    usageRepo.emit(db, makeUsage(identity.agent_id, "submission_rejected", { reason: "daily_cap" }, now));
    throw new VerdictError(
      `max ${SUBMISSION_LIMITS.max_calls_per_asset_per_day} calls per asset per day`,
      ERROR_CODES.rate_limited,
      429,
    );
  }

  // 5. dedup — uses SERVER time (accepted_at), not agent-supplied submitted_at,
  //    so an agent cannot replay the same call with different submitted_at
  //    strings and slip past dedup on the wire.
  const accepted_at = nowIso(now());
  const dedup_key = buildDedupKey({
    agent_id: identity.agent_id,
    asset_id: submission.asset_id,
    side: submission.side,
    horizon_hours: submission.horizon_hours,
    submitted_at_iso: accepted_at,
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

  // 6. preflight via risk evaluator
  const market = await ctx.marketContext(submission.asset_id);
  const { preflight } = evaluateRisk(submission, market);

  // 7. build acceptance receipt
  const call_id = randomUUID();
  // accepted_at already computed above for dedup; reuse so the receipt records
  // the same instant we used for dedup bucketing.
  const acceptancePayload = AcceptanceReceiptPayloadSchema.parse({
    schema_version: SCHEMA_VERSION,
    scoring_version: SCORING_VERSION,
    submission,
    preflight,
    oracle_policy: oraclePolicy,
    accepted_at,
    call_id,
  });
  const receipt = buildAcceptanceReceipt(acceptancePayload);

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
      { call_id, asset_id: submission.asset_id, side: submission.side, horizon_hours: submission.horizon_hours },
      now,
    ),
  );

  ctx.events?.emit({
    type: "call.accepted",
    call_id,
    agent_id: agent.agent_id,
    agent_slug: agent.display_slug,
    side: submission.side,
    asset_id: submission.asset_id,
    horizon_hours: submission.horizon_hours,
    confidence: submission.confidence,
    accepted_at,
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
