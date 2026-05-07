import { z } from "zod";

// ─── Version pins ────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1 as const;
export const SCORING_VERSION = 1 as const;

// ─── Asset registry ──────────────────────────────────────────────────────────
// asset_id = "<chain>:<asset>:<quote>". v0.1 only inserts base:ETH:USD;
// BTC/SOL etc. become additions, never refactors.

export const REGISTERED_ASSET_IDS = ["base:ETH:USD"] as const;
export const AssetIdSchema = z.enum(REGISTERED_ASSET_IDS);
export type AssetId = z.infer<typeof AssetIdSchema>;

// ─── Strategy tag registry ────────────────────────────────────────────────────
// Operators pick a tag from this fixed set OR supply a bounded rationale.

export const REGISTERED_STRATEGY_TAGS = [
  "momentum",
  "mean_reversion",
  "breakout",
  "fade",
  "macro",
  "narrative",
  "technical",
  "onchain",
  "sentiment",
] as const;
export const StrategyTagSchema = z.enum(REGISTERED_STRATEGY_TAGS);
export type StrategyTag = z.infer<typeof StrategyTagSchema>;

// ─── Oracle feed registry ─────────────────────────────────────────────────────

export const REGISTERED_ORACLE_FEEDS = [
  "chainlink:base:ETH-USD",
  "pyth:base:ETH-USD",
] as const;
export const OracleFeedSchema = z.enum(REGISTERED_ORACLE_FEEDS);
export type OracleFeed = z.infer<typeof OracleFeedSchema>;

// ─── Identity ────────────────────────────────────────────────────────────────

export const VerifiedIdentityKindSchema = z.enum([
  "x",
  "telegram",
  "wallet",
  "openserv",
]);
export type VerifiedIdentityKind = z.infer<typeof VerifiedIdentityKindSchema>;

export const VerifiedIdentitySchema = z.object({
  kind: VerifiedIdentityKindSchema,
  value: z.string().min(1).max(256),
  verified_at: z.string().datetime({ offset: false }),
});
export type VerifiedIdentity = z.infer<typeof VerifiedIdentitySchema>;

export const AgentKindSchema = z.enum([
  "benchmark",
  "shadow",
  "verified",
  "internal_test",
  // wallet_only: agents that self-registered via /claim/wallet-only — they
  // proved control of a wallet but have no public X/Telegram identity.
  // Marketplace participants; appear on the default leaderboard but are
  // tagged distinctly from `verified` (which requires public identity).
  "wallet_only",
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
  verified_identities: z.array(VerifiedIdentitySchema).default([]),
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
//   submitted → preflighted → accepted (= pending_t0)
//             → pending_t1 → resolved
//             → disputed → re_resolved
//   rejected (terminal at any point before accepted)

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
]);
export type CallStatus = z.infer<typeof CallStatusSchema>;

export const SideSchema = z.enum(["BUY", "SELL"]);
export type Side = z.infer<typeof SideSchema>;

export const HORIZONS_HOURS = [1, 4, 24, 168] as const;
export const HorizonHoursSchema = z.union([
  z.literal(1),
  z.literal(4),
  z.literal(24),
  z.literal(168),
]);
export type HorizonHours = (typeof HORIZONS_HOURS)[number];

// ─── SubmittedCall (agent-supplied) ──────────────────────────────────────────
// Either `rationale` (≤ 240 chars) OR `strategy_tag` MUST be present. This is
// enforced via .superRefine so spam-empty submissions are rejected at the edge.

export const SubmittedCallSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    agent_id: z.string().uuid(),
    client_order_id: z.string().min(8).max(128),
    asset_id: AssetIdSchema,
    side: SideSchema,
    horizon_hours: HorizonHoursSchema,
    confidence: z.number().min(0.51).max(0.95),
    submitted_at: z.string().datetime({ offset: false }),
    rationale: z.string().max(240).optional(),
    strategy_tag: StrategyTagSchema.optional(),
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
export type SubmittedCall = z.infer<typeof SubmittedCallSchema>;

// ─── Preflight (Murmur-supplied during acceptance) ───────────────────────────

export const MarketRegimeSchema = z.enum(["bullish", "bearish", "neutral"]);
export type MarketRegime = z.infer<typeof MarketRegimeSchema>;

export const VerdictPreflightSchema = z
  .object({
    murmur_score: z.number().min(-1).max(1),
    murmur_playbook: z.string().min(1),
    risk_flags: z.array(z.string()).default([]),
    data_freshness_seconds: z.number().int().min(0),
    market_regime: MarketRegimeSchema,
  })
  .strict();
export type VerdictPreflight = z.infer<typeof VerdictPreflightSchema>;

// ─── T0 / oracle anchoring policy ────────────────────────────────────────────

export const T0PolicySchema = z
  .object({
    primary_feed: z.literal("chainlink:base:ETH-USD"),
    fallback_feed: z.literal("pyth:base:ETH-USD"),
    primary_max_staleness_sec: z.number().int().positive(),
    fallback_max_staleness_sec: z.number().int().positive(),
    t0_grace_seconds: z.number().int().positive(),
    t0_extended_grace_seconds: z.number().int().positive(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.t0_extended_grace_seconds < v.t0_grace_seconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "t0_extended_grace_seconds must be ≥ t0_grace_seconds",
        path: ["t0_extended_grace_seconds"],
      });
    }
  });
export type T0Policy = z.infer<typeof T0PolicySchema>;

export const DEFAULT_T0_POLICY: T0Policy = {
  primary_feed: "chainlink:base:ETH-USD",
  fallback_feed: "pyth:base:ETH-USD",
  primary_max_staleness_sec: 60,
  fallback_max_staleness_sec: 30,
  t0_grace_seconds: 120,
  t0_extended_grace_seconds: 300,
};

// ─── AcceptedCall (post-preflight, receipt issued) ───────────────────────────

export const AcceptedCallSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    scoring_version: z.literal(SCORING_VERSION),
    call_id: z.string().uuid(),
    agent_id: z.string().uuid(),
    client_order_id: z.string().min(8).max(128),
    asset_id: AssetIdSchema,
    side: SideSchema,
    horizon_hours: HorizonHoursSchema,
    confidence: z.number().min(0.51).max(0.95),
    submitted_at: z.string().datetime({ offset: false }),
    rationale: z.string().max(240).optional(),
    strategy_tag: StrategyTagSchema.optional(),
    accepted_at: z.string().datetime({ offset: false }),
    status: z.literal("accepted"),
    preflight: VerdictPreflightSchema,
    oracle_policy: T0PolicySchema,
    acceptance_receipt_hash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/, "keccak256 hex"),
    acceptance_receipt_cid: z.string().min(1).optional(),
  })
  .strict();
export type AcceptedCall = z.infer<typeof AcceptedCallSchema>;

// ─── Resolution outcomes ──────────────────────────────────────────────────────

export const OutcomeSchema = z.enum([
  "win",
  "loss",
  "void",
  "oracle_unavailable",
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const VerdictResolutionSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    scoring_version: z.literal(SCORING_VERSION),
    call_id: z.string().uuid(),
    t0: z.string().datetime({ offset: false }),
    p0: z.string().regex(/^[0-9]+(\.[0-9]+)?$/, "decimal string"),
    t0_feed: OracleFeedSchema,
    t1: z.string().datetime({ offset: false }),
    p1: z.string().regex(/^[0-9]+(\.[0-9]+)?$/, "decimal string"),
    t1_feed: OracleFeedSchema,
    signed_return: z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/),
    outcome: OutcomeSchema,
    call_score: z.number().nullable(),
    resolved_at: z.string().datetime({ offset: false }),
    resolution_receipt_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
    resolution_receipt_cid: z.string().min(1).optional(),
    previous_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.outcome === "win" || v.outcome === "loss") && v.call_score === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "call_score required for win/loss outcomes",
        path: ["call_score"],
      });
    }
    if ((v.outcome === "void" || v.outcome === "oracle_unavailable") && v.call_score !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "call_score must be null for void / oracle_unavailable",
        path: ["call_score"],
      });
    }
  });
export type VerdictResolution = z.infer<typeof VerdictResolutionSchema>;

// ─── Receipt payloads (canonicalized before hashing) ─────────────────────────
// These are the EXACT shapes that get keccak256-hashed. Field order does not
// matter (canonicalization sorts keys), but the field SET is invariant.

export const AcceptanceReceiptPayloadSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    scoring_version: z.literal(SCORING_VERSION),
    submission: SubmittedCallSchema,
    preflight: VerdictPreflightSchema,
    oracle_policy: T0PolicySchema,
    accepted_at: z.string().datetime({ offset: false }),
    call_id: z.string().uuid(),
  })
  .strict();
export type AcceptanceReceiptPayload = z.infer<
  typeof AcceptanceReceiptPayloadSchema
>;

export const ResolutionReceiptPayloadSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    scoring_version: z.literal(SCORING_VERSION),
    call_id: z.string().uuid(),
    acceptance_receipt_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
    t0: z.string().datetime({ offset: false }),
    p0: z.string().regex(/^[0-9]+(\.[0-9]+)?$/),
    t0_feed: OracleFeedSchema,
    t1: z.string().datetime({ offset: false }),
    p1: z.string().regex(/^[0-9]+(\.[0-9]+)?$/),
    t1_feed: OracleFeedSchema,
    signed_return: z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/),
    outcome: OutcomeSchema,
    call_score: z.number().nullable(),
    resolved_at: z.string().datetime({ offset: false }),
  })
  .strict();
export type ResolutionReceiptPayload = z.infer<
  typeof ResolutionReceiptPayloadSchema
>;

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
    verdict_score: z.number().nullable(),
    resolved_calls: z.number().int().nonnegative(),
    win_rate: z.number().min(0).max(1).nullable(),
    pending_calls: z.number().int().nonnegative(),
    last_resolved_at: z.string().datetime({ offset: false }).nullable(),
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

// ─── Claim challenge (Challenge-Link flow) ───────────────────────────────────

export const ClaimChallengeSchema = z
  .object({
    challenge_id: z.string().uuid(),
    agent_id: z.string().uuid(),
    target_identity: VerifiedIdentitySchema.pick({ kind: true, value: true }),
    nonce: z.string().min(16).max(64),
    challenge_text: z.string(),
    wallet_to_bind: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "EIP-55 address"),
    expires_at: z.string().datetime({ offset: false }),
    status: z.enum(["pending", "verified", "expired", "rejected"]),
    // Storage created_at — set when the challenge row is inserted. Earlier
    // releases stuffed `expires_at` into the `created_at` column by mistake;
    // migration 005 leaves legacy rows alone (they expire-and-GC anyway) and
    // every new row gets the correct creation timestamp.
    created_at: z.string().datetime({ offset: false }),
  })
  .strict();
export type ClaimChallenge = z.infer<typeof ClaimChallengeSchema>;

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
    target_resolution_receipt_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
    grounds: DisputeGroundsSchema,
    notes: z.string().max(1000).optional(),
    filed_by: z.string().min(1).max(128),
    filed_at: z.string().datetime({ offset: false }),
    status: DisputeStatusSchema,
    resolved_at: z.string().datetime({ offset: false }).nullable(),
    new_resolution_receipt_hash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();
export type Dispute = z.infer<typeof DisputeSchema>;

// ─── Submission limits (anti-spam) ───────────────────────────────────────────

export const SUBMISSION_LIMITS = {
  max_active_calls_per_agent: 5,
  max_calls_per_asset_per_day: 24,
  /** dedup window = horizon_hours / 4, in hours; floor of submitted_at into this bucket */
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
  asset_not_supported: "asset_not_supported",
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
export const VOID_BAND = 0.002; // |signed_return| < this → void
export const MIN_RESOLVED_CALLS_FOR_MAIN_TIER = 20;
export const SHADOW_CLAIM_LOOKBACK_DAYS = 30;
export const RATIONALE_MAX_CHARS = 240;
