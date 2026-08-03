import { z } from "zod";

export * from "./feed-contract-schema.js";
export * from "./market-registry-schema.js";

// ─── Version pins ────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1 as const;
export const SCORING_VERSION = 1 as const;

// ─── Identity ────────────────────────────────────────────────────────────────

// Wave 3 collapse — the agent.kind taxonomy compresses to four values now
// that the off-platform reputation pipes (verified/wallet_only via X/
// Telegram/wallet claim) and the shadow scraping pipeline are gone. Murmur
// reputation only accrues from on-platform FHE calls, so a single 'agent'
// kind covers everyone who submits via the Runtime Key Gateway; the other three are
// system-internal markers.
//
// Mapping handled in MIGRATION_031: legacy 'casual'/'shadow'/'verified'/
// 'wallet_only' rows all → 'agent'. The dashboard collapse in Wave 3a
// already renders the new enum.
//
//   benchmark    — Murmur-run baseline strategies (e.g. constant BUY/SELL,
//                  trend-follow). Excluded from the marketplace; sit at
//                  the top of the leaderboard as anchor rows.
//   agent        — every operator-owned, FHE-submitting agent. Identity is
//                  Privy-bound at the account level; the on-platform
//                  prediction history is the only reputation surface.
//   internal_test — Murmur-side QA agents, never marketplace-eligible.
//   attested     — Olas Service Registry bond + Safe multisig governance.
//                  Strong non-transferability (forfeits the OLAS bond on
//                  transfer). Sits on top of the same on-platform record
//                  as a regular `agent`; attestation is an additional
//                  trust band, not a separate reputation pool.
export const AgentKindSchema = z.enum([
  "benchmark",
  "agent",
  "internal_test",
  "attested",
]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

// 3–32 chars, lowercase alphanumeric, single dashes between segments,
// no leading/trailing dash, no double dashes. Rejects `--`, `-x`, `x-`,
// `xx`, `__`, uppercase, and slugs longer than 32 chars.
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
  // Pillar-4 marketplace portability: a wallet-bound agent's receipts
  // can be verified off-Murmur. Both fields are optional in v0.2 to keep
  // backwards-compat with pre-migration agents; mandatory at v0.3 fhEVM.
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
// LEGACY PERSISTED STATES. `accepted` and `pending_t0` belonged to the removed
// native-price two-phase resolver (anchor a t0 price, then settle at t1).
// Nothing writes them any more — acceptance stamps `pending_t1` directly — but
// they stay in the union so rows persisted before the cutover remain readable
// and the resolver can drain them (see DRAINING_STATUSES in resolver.ts).

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

// Wave 4b-2 — VerdictPreflight + MarketRegime were Santiment-derived
// decoration stamped onto every accepted call. The resolver never consulted
// them. The preflight struct, the /v1/market/preflight endpoint, the
// preflights table, and the entire scout → analyst pipeline are removed.
// Murmur is a pure referee: the external venue resolves its own market and
// murmur scores the sealed call against that outcome.

// ─── Resolution outcomes ──────────────────────────────────────────────────────
//
// LEGACY PERSISTED ENUM — every value below appears in `t1_resolutions.outcome`
// on live rows and the leaderboard aggregates on them, so the set is frozen.
// `oracle_unavailable` no longer means "a price oracle was down": it is the
// terminal null-score bucket for a call Murmur could not score at all (missing
// or misconfigured venue adapter, unscoreable observation). `void` is likewise
// a stored value the leaderboard excludes.

export const OutcomeSchema = z.enum([
  "win",
  "loss",
  "void",
  "oracle_unavailable",
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

// Wave 4b — receipt payload schemas (AcceptanceReceiptPayloadSchema,
// ResolutionReceiptPayloadSchema and their v1/v2 variants) were dropped
// alongside the receipts table. SCHEMA_VERSION + SCORING_VERSION below
// are still the canonical stamps for resolution rows and call envelopes.

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
    /** Public predictive score — Brier-derived, 1-sigma lower bound. */
    verdict_score: z.number().nullable(),
    /**
     * 95% lower-confidence bound on the mean call_score (Phase F D24).
     * Marketplace booking sorts by THIS instead of the raw verdict_score
     * so 20 lucky calls can't outrank 200 stable calls. Pillar-4 gate.
     */
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
     *  the dedicated reveal EOA). No longer hardcoded to 0. */
    daemon_fallback_reveals: z.number().int().nonnegative(),
    /**
     * Pillar-4 marketplace booking gate. True iff resolved_calls >=
     * MIN_RESOLVED_CALLS_FOR_MARKETPLACE_TIER AND verdict_score_lb >= 0.
     * Stricter than `tier=main`. Marketplace consumers filter on this
     * before recommending an agent.
     */
    marketplace_eligible: z.boolean(),
    /**
     * RESERVED axes for v0.3+ (D26 axes 2 + 3). Currently 0 / null;
     * shape is locked here so the v0.3 fhEVM port can populate them
     * without a schema bump.
     */
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
  // V2 §7.4 + §7.7 risk-1 — every destination_address mutation is recorded
  // here so the 24h cooldown enforcement has a full audit trail. Emitted by
  // the PATCH /v1/account/agents/:slug/destination-address handler after a
  // successful setDestinationAddress call.
  "destination_address_updated",
  // Phase 7d — Maya onboarding funnel events emitted by the dashboard via
  // POST /v1/account/events. account-scoped (agent_id is nullable on this
  // table), used to measure where casual-tier signups drop off between
  // first landing-pageview and first call submission. The allowlist is
  // also enforced server-side in the route handler; keep both in sync.
  "landing.viewed",
  "compete.clicked",
  "privy.modal_opened",
  "privy.signed_in",
  "agent.created",
  "api_key.minted",
  "destination.set",
  // Future waves (resolver-side hooks) — kinds reserved here so the
  // schema doesn't have to migrate when those land. Emit sites are not
  // wired in 7d, but the allowlist accepts them so the frontend can
  // start probing without a server roll.
  "call.first_submitted",
  "call.first_resolved",
  "call.tenth_submitted",
  // Reveal attribution (migration 057) — emitted in the SAME transaction that
  // attaches a valid or invalid Fhenix reveal, carrying
  // {call_id, tx_hash, sender, source}. `source` is agent | daemon_fallback |
  // unattributed_external (see fhenix-reveal-attribution.ts). The leaderboard
  // aggregates the normalized reveal_source column; this event is the durable
  // per-reveal audit trail behind it.
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

// ─── Agent security events (Wave 5) ──────────────────────────────────────────
//
// Append-only audit log for admin/operator actions that mutate an agent's
// ownership or a sensitive registry slot. The closed enum mirrors the SQL
// CHECK in MIGRATION_032 — adding a new event class requires touching both
// surfaces so emitters can't quietly grow the taxonomy unobserved.
export const AgentSecurityEventKindSchema = z.enum([
  // Operator manually attached an agent to an account (e.g. recovery
  // path when an operator loses Privy access). Emitted by the
  // admin-claim CLI.
  "admin_claim",
  // Operator upserted a Polymarket conditionId via POST
  // /v1/admin/markets/polymarket.
  "admin_polymarket_upsert",
  // Operator transitioned a registry market between
  // draft/listed/frozen/retired via an admin route. Not wired in
  // Wave 5 itself; reserved here so the taxonomy stays stable.
  "admin_market_status_change",
  // Operator deleted a ref_clicks bucket via DELETE /v1/refs/:ref.
  "admin_ref_delete",
  // Operator detached an agent from an account via the admin-claim
  // CLI's `--unlink` flag (recovery path for a slug that was claimed
  // to the wrong account). Not wired in Wave 5; reserved for a v0.3
  // follow-up.
  "admin_account_unlink",
  // Operator forced a Fhenix gateway broadcast attempt to retry now via
  // the admin retry route. Mutates relayer queue state — auditable so a
  // forensic timeline can reconstruct who poked the queue when.
  "admin_fhenix_gateway_retry",
  // Operator backfilled a Fhenix feed packet via the admin feed-packet
  // ingest route (recovery path when the watcher missed a packet).
  // Only emitted when the ingest call actually inserts a new row.
  "admin_fhenix_feed_packet_backfill",
  // Account owner engaged the kill switch via POST /v1/account/kill-switch:
  // agent_credentials_disabled_at set, all runtime keys revoked, all API
  // keys rotated out. actor is the Privy account, not an operator.
  "account_kill_switch_engaged",
  // Account owner released the kill switch (separate deliberate ceremony);
  // previously revoked/rotated credentials stay dead — only NEW mints and
  // dispatch resume.
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
    /** Free-text actor tag — e.g. 'admin_token' for HTTP routes or
     *  'cli:admin-claim' for tools/operations/admin-claim.ts. Read-only
     *  forensic context, never load-bearing for auth. */
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
    // Wave 4b — disputes now key on the call_id directly (FK to submissions).
    // Prior shape used target_resolution_receipt_hash + new_resolution_receipt_hash;
    // both went away with the receipts table.
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
  /**
   * The Privy-authenticated account does not own the agent slug it tried
   * to act as. Distinct from agent_not_authorized so the dispatcher can
   * surface a precise reason without leaking whether the slug exists.
   */
  agent_not_owned_by_account: "agent_not_owned_by_account",
  /**
   * The account owns multiple agents and the request did not specify
   * which one via X-Murmur-Agent-Slug. Dispatcher rejects with this
   * code so the caller can prompt for / persist a default.
   */
  agent_slug_required: "agent_slug_required",
  /**
   * Hard ownership conflict — the agent_id requested for link is already
   * owned by a DIFFERENT account. Surfaced as 409 by POST
   * /v1/account/agents (BLOCKER #4). Distinct from agent_not_authorized
   * because the caller's auth is valid; the resource is just claimed.
   */
  agent_already_owned_by_another_account: "agent_already_owned_by_another_account",
  asset_not_supported: "asset_not_supported",
  /**
   * A valid PoP-bound Runtime Key presented a missing, stale, replayed, or
   * cryptographically invalid request signature. Fail-closed 401: the
   * dispatcher throws instead of falling through to API-key auth, so a
   * stolen bearer secret alone can never downgrade to weaker auth.
   */
  runtime_key_signature_invalid: "runtime_key_signature_invalid",
  /**
   * The account engaged its kill switch (accounts.agent_credentials_disabled_at).
   * Every runtime-key/API-key dispatch, key mint, and gateway attempt claim
   * rejects with this code until the account re-enables agent access. 403.
   */
  agent_credentials_disabled: "agent_credentials_disabled",
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
/**
 * Phase F D25 — pillar-4 marketplace booking gate. Stricter than the
 * main-tier threshold: 50 resolved calls AND a non-negative
 * verdict_score_lb. Marketplace consumers should require both before
 * recommending an agent for a paid booking.
 */
export const MIN_RESOLVED_CALLS_FOR_MARKETPLACE_TIER = 50;
export const SHADOW_CLAIM_LOOKBACK_DAYS = 30;
export const RATIONALE_MAX_CHARS = 240;
