import { z } from "zod";

export * from "./feed-contract-schema.js";
export * from "./market-registry-schema.js";

// ─── Version pins ────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1 as const;
export const SCORING_VERSION = 1 as const;

// Mirrors MurmurSealedVerdicts.publishReveal: a revealed value outside these
// bounds terminalizes the call as invalid. Every copy of the band reads from here.
export const CONFIDENCE_BPS_MIN = 5100;
export const CONFIDENCE_BPS_MAX = 9500;
export const VERDICT_BOUNDS = {
  binary_index: { min: 0, max: 1 },
  confidence_bps: { min: CONFIDENCE_BPS_MIN, max: CONFIDENCE_BPS_MAX },
} as const;

// ─── Identity ────────────────────────────────────────────────────────────────

//   benchmark     — murmur-run baselines. Not marketplace-eligible; they sit
//                   at the top of the leaderboard as anchor rows.
//   agent         — every operator-owned, FHE-submitting agent. Privy-bound at
//                   the account level; its call history is the only reputation.
//   internal_test — QA agents, never marketplace-eligible.
//   attested      — Olas bond + Safe multisig. An additional trust band over
//                   the same record as `agent`, not a separate pool.
export const AgentKindSchema = z.enum([
  "benchmark",
  "agent",
  "internal_test",
  "attested",
]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

// 3–32 chars, lowercase alphanumeric segments joined by single dashes.
// Rejects `--`, `-x`, `x-`, `__`, and uppercase.
export const AgentSlugSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "lowercase alphanumeric segments separated by single dashes",
  );

// CAIP-2 chain id, e.g. "eip155:8453" (Base mainnet), "eip155:11155111"
// (Sepolia). Stored as a string so multi-chain identity composes cleanly.
export const ChainIdSchema = z
  .string()
  .regex(/^[a-z0-9]+:[a-zA-Z0-9-]{1,32}$/, "CAIP-2 chain id e.g. eip155:8453");

// Lowercase 0x-prefixed 40-hex string. Validation is at the API edge via
// viem's getAddress(); this regex is a final-form check after normalization.
export const WalletAddressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, "lowercase 0x + 40 hex chars (use viem.getAddress to normalize)");

export const AgentProfileSchema = z.object({
  agent_id: z.string().uuid(),
  display_slug: AgentSlugSchema,
  kind: AgentKindSchema,
  display_name: z.string().min(1).max(64),
  bio: z.string().max(280).optional(),
  created_at: z.string().datetime({ offset: false }),
  // Lets a wallet-bound agent's receipts be verified off-Murmur. Optional:
  // older agents have no wallet binding.
  wallet_address: WalletAddressSchema.optional(),
  chain_id: ChainIdSchema.optional(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

// ─── Call lifecycle ───────────────────────────────────────────────────────────
// Authoritative state machine. Transitions:
//   submitted → preflighted → pending_t1 → resolved
//                                        → disputed → re_resolved
//   rejected (terminal at any point before acceptance)
//   invalid_reveal / missed_reveal (terminal sealed-Fhenix reveal failures)
//
// `accepted` and `pending_t0` are never written; they stay so stored rows stay
// readable and the resolver can drain them (DRAINING_STATUSES in resolver.ts).

export const CallStatusSchema = z.enum([
  "submitted",
  "preflighted",
  "accepted",
  "pending_t0",
  "pending_t1",
  "resolved",
  "disputed",
  "re_resolved",
  "rejected",
  "invalid_reveal",
  "missed_reveal",
]);
export type CallStatus = z.infer<typeof CallStatusSchema>;

// ─── Resolution outcomes ──────────────────────────────────────────────────────
//
// Frozen: stored in `t1_resolutions.outcome` and aggregated by the leaderboard.
// `oracle_unavailable` is the null-score bucket for a call Murmur could not
// score (missing or misconfigured adapter, unscoreable observation). The
// leaderboard excludes it and `void`.

export const OutcomeSchema = z.enum([
  "win",
  "loss",
  "void",
  "oracle_unavailable",
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

// SCHEMA_VERSION and SCORING_VERSION (top of file) stamp resolution rows and
// call envelopes.

// ─── Leaderboard view ────────────────────────────────────────────────────────

export const LeaderboardTierSchema = z.enum(["main", "provisional"]);
export type LeaderboardTier = z.infer<typeof LeaderboardTierSchema>;

export const LeaderboardRowSchema = z
  .object({
    agent_id: z.string().uuid(),
    display_slug: AgentSlugSchema,
    display_name: z.string(),
    kind: AgentKindSchema,
    tier: LeaderboardTierSchema,
    rank: z.number().int().positive().nullable(),
    /** Public predictive score: Brier-derived, 1-sigma lower bound. */
    verdict_score: z.number().nullable(),
    /** 95% lower bound on mean call_score. Marketplace sorts by this so 20
     *  lucky calls can't outrank 200 stable ones. */
    verdict_score_lb: z.number().nullable(),
    resolved_calls: z.number().int().nonnegative(),
    win_rate: z.number().min(0).max(1).nullable(),
    pending_calls: z.number().int().nonnegative(),
    last_resolved_at: z.string().datetime({ offset: false }).nullable(),
    /** Reveal reliability = non-daemon reveals / (non-daemon + daemon-fallback +
     *  genuine misses). Null until the agent has any terminal sealed reveal. */
    reveal_reliability: z.number().min(0).max(1).nullable(),
    /** Reveals published WITHOUT the murmur fallback (agent self-reveal or an
     *  unattributed external sender), by publish-tx `from`. */
    agent_reveals: z.number().int().nonnegative(),
    /** Reveals the murmur-owned fallback worker guaranteed (publish tx sent by
     *  the dedicated reveal EOA). */
    daemon_fallback_reveals: z.number().int().nonnegative(),
    /** True iff resolved_calls >= MIN_RESOLVED_CALLS_FOR_MARKETPLACE_TIER and
     *  verdict_score_lb >= 0. Stricter than `tier=main`. */
    marketplace_eligible: z.boolean(),
    /** Reserved; always null for now. Shape locked so they can be filled
     *  without a schema bump. */
    operator_trust_score: z.number().min(0).max(1).nullable().default(null),
    stake_at_risk: z.string().nullable().default(null),
  })
  .strict();
export type LeaderboardRow = z.infer<typeof LeaderboardRowSchema>;

// ─── Usage events (rail for future fee/burn metering) ────────────────────────

export const UsageEventKindSchema = z.enum([
  "submission_accepted",
  "submission_rejected",
  "resolution_completed",
  "dispute_filed",
  "dispute_resolved",
  "claim_initiated",
  "claim_completed",
  "shadow_card_posted",
  // Every destination_address mutation, so the 24h cooldown has an audit trail.
  "destination_address_updated",
  // Onboarding funnel, emitted by the dashboard via POST /v1/account/events.
  // The route handler enforces the same allowlist — keep both in sync.
  "landing.viewed",
  "privy.modal_opened",
  "privy.signed_in",
  "agent.created",
  "api_key.minted",
  "destination.set",
  // Reserved resolver-side hooks. No emit sites yet, but the allowlist accepts
  // them so the frontend can probe without a server roll.
  "call.first_submitted",
  "call.first_resolved",
  "call.tenth_submitted",
  // Emitted in the same transaction that attaches a Fhenix reveal, with
  // {call_id, tx_hash, sender, source}; source is agent | daemon_fallback |
  // unattributed_external. Audit trail behind the reveal_source column.
  "fhenix_reveal_published",
]);
export type UsageEventKind = z.infer<typeof UsageEventKindSchema>;

export const UsageEventSchema = z
  .object({
    event_id: z.string().uuid(),
    agent_id: z.string().uuid().nullable(),
    kind: UsageEventKindSchema,
    ts: z.string().datetime({ offset: false }),
    attributes: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type UsageEvent = z.infer<typeof UsageEventSchema>;

// ─── Agent security events ───────────────────────────────────────────────────
//
// Append-only audit log for admin/operator actions on agent ownership or
// sensitive registry slots. Mirrors the SQL CHECK in MIGRATION_032; change both.
export const AgentSecurityEventKindSchema = z.enum([
  // Operator attached an agent to an account via the admin-claim CLI.
  "admin_claim",
  // Operator upserted a Polymarket conditionId via POST
  // /v1/admin/markets/polymarket.
  "admin_polymarket_upsert",
  // Operator moved a registry market between draft/listed/frozen/retired.
  "admin_market_status_change",
  // Operator detached an agent from an account. Reserved; nothing emits it yet.
  "admin_account_unlink",
  // Operator forced a Fhenix gateway broadcast retry via the admin route.
  "admin_fhenix_gateway_retry",
  // Operator backfilled a Fhenix feed packet; only when a new row is inserted.
  "admin_fhenix_feed_packet_backfill",
  // Account owner engaged the kill switch via POST /v1/account/kill-switch:
  // agent_credentials_disabled_at set, all runtime keys revoked, all API
  // keys rotated out. actor is the Privy account, not an operator.
  "account_kill_switch_engaged",
  // Account owner released the kill switch. Revoked/rotated credentials stay
  // dead; only new mints and dispatch resume.
  "account_kill_switch_released",
]);
export type AgentSecurityEventKind = z.infer<
  typeof AgentSecurityEventKindSchema
>;

export const AgentSecurityEventSchema = z
  .object({
    event_id: z.string().uuid(),
    /** UUID when the action targets an existing agent; null for events
     *  whose `kind` operates on a different scope (e.g. ref bucket). */
    agent_id: z.string().uuid().nullable(),
    /** UUID when the action attaches/detaches an agent to an account;
     *  null for admin-only mutations that don't touch ownership. */
    account_id: z.string().uuid().nullable(),
    kind: AgentSecurityEventKindSchema,
    /** Free-text actor tag, e.g. 'admin_token' or 'cli:admin-claim'.
     *  Forensic only; never used for auth. */
    actor: z.string().min(1).max(64),
    payload: z.record(z.string(), z.unknown()).default({}),
    created_at: z.string().datetime({ offset: false }),
  })
  .strict();
export type AgentSecurityEvent = z.infer<typeof AgentSecurityEventSchema>;

// ─── Dispute ─────────────────────────────────────────────────────────────────

export const DisputeGroundsSchema = z.enum([
  "stale_feed",
  "wrong_feed_used",
  "wrong_timestamp",
  "calculation_bug",
  "chain_reorg",
  "oracle_revision_after_resolution",
]);
export type DisputeGrounds = z.infer<typeof DisputeGroundsSchema>;

export const DisputeStatusSchema = z.enum([
  "open",
  "replay_in_progress",
  "upheld",
  "rejected",
]);
export type DisputeStatus = z.infer<typeof DisputeStatusSchema>;

export const DisputeSchema = z
  .object({
    dispute_id: z.string().uuid(),
    // FK to submissions.call_id.
    target_call_id: z.string().uuid(),
    grounds: DisputeGroundsSchema,
    notes: z.string().max(1000).optional(),
    filed_by: z.string().min(1).max(128),
    filed_at: z.string().datetime({ offset: false }),
    status: DisputeStatusSchema,
    resolved_at: z.string().datetime({ offset: false }).nullable(),
  })
  .strict();
export type Dispute = z.infer<typeof DisputeSchema>;

// ─── Submission limits (anti-spam) ───────────────────────────────────────────

export const SUBMISSION_LIMITS = {
  max_active_calls_per_agent: 5,
  max_calls_per_asset_per_day: 24,
  /** dedup window = horizon_seconds / 4; floor of accepted_at into this bucket */
  dedup_bucket_divisor: 4,
} as const;

// ─── Error codes (stable wire contract) ──────────────────────────────────────

export const ERROR_CODES = {
  schema_invalid: "schema_invalid",
  duplicate: "duplicate",
  rate_limited: "rate_limited",
  risk_block: "risk_block",
  oracle_unavailable: "oracle_unavailable",
  unknown_agent: "unknown_agent",
  agent_not_authorized: "agent_not_authorized",
  /** Account doesn't own the slug it acted as. Separate from
   *  agent_not_authorized so the reason is precise without leaking whether
   *  the slug exists. */
  agent_not_owned_by_account: "agent_not_owned_by_account",
  /** Account owns several agents and sent no X-Murmur-Agent-Slug. */
  agent_slug_required: "agent_slug_required",
  /** agent_id is already owned by a different account. 409 from POST
   *  /v1/account/agents. */
  agent_already_owned_by_another_account: "agent_already_owned_by_another_account",
  asset_not_supported: "asset_not_supported",
  /**
   * A valid PoP-bound Runtime Key presented a missing, stale, replayed, or
   * invalid request signature. Fail-closed 401: never falls through to
   * API-key auth, so a stolen bearer secret alone can't downgrade auth.
   */
  runtime_key_signature_invalid: "runtime_key_signature_invalid",
  /** Kill switch engaged (accounts.agent_credentials_disabled_at). Blocks
   *  runtime-key/API-key dispatch, key mints, and gateway attempt claims. 403. */
  agent_credentials_disabled: "agent_credentials_disabled",
  /** Owner retired this agent (agents.retired_at). Blocks new calls only;
   *  record, history, and key reads keep working. 409. */
  agent_retired: "agent_retired",
  /**
   * Owner closed this account (accounts.deactivated_at). Terminal and
   * independent of the kill switch: releasing the kill switch must never
   * reopen a closed account. 403.
   */
  account_deactivated: "account_deactivated",
  /** Operator admin surface is disabled (VERDICT_ADMIN_TOKEN not set). 503. */
  admin_disabled: "admin_disabled",
  /** Admin route auth rejected the supplied/absent admin token. 403. */
  admin_forbidden: "admin_forbidden",
  internal_error: "internal_error",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class VerdictError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly httpStatus: number,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "VerdictError";
  }
}

// ─── Invariants (importable for runtime assertions and tests) ────────────────

export const CONFIDENCE_MIN = 0.51;
export const CONFIDENCE_MAX = 0.95;
export const MIN_RESOLVED_CALLS_FOR_MAIN_TIER = 20;
/** Marketplace booking gate; also requires verdict_score_lb >= 0. */
export const MIN_RESOLVED_CALLS_FOR_MARKETPLACE_TIER = 50;
export const SHADOW_CLAIM_LOOKBACK_DAYS = 30;
export const RATIONALE_MAX_CHARS = 240;
