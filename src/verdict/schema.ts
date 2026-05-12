import { z } from "zod";

// ─── Version pins ────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1 as const;
export const SCORING_VERSION = 1 as const;

// ─── Asset registry ──────────────────────────────────────────────────────────
//
// Wave 4a — opened from the closed native-price enum to a structural
// regex that admits two adapter families:
//
//   - Native-price: "<chain>:<asset>:<quote>" (e.g. "base:ETH:USD",
//     "base:BTC:USD"). Lowercase chain + uppercase asset/quote tickers.
//   - External-adapter synthetic: "<protocol>:<kind>" (e.g.
//     "polymarket:event"). MIGRATION_029 seeded "polymarket:event" as
//     the synthetic anchor for every Polymarket conditionId market;
//     future adapter families (Kalshi, Drift, etc.) follow the same
//     "<protocol>:<kind>" pattern.
//
// The registry (assets table + adapter dispatch) remains the source of
// truth for whether a given asset_id is listable; this regex is just
// the wire-shape gate. Closed-enum rejection of typos moves up one
// layer to the registry lookup (which already 404s an unknown asset
// before the submission lands).
//
// REGISTERED_ASSET_IDS stays around as a back-compat list of the four
// native-price assets that originally seeded the registry — call sites
// that iterated it for benchmark/test setup keep working unchanged.
export const REGISTERED_ASSET_IDS = [
  "base:ETH:USD",
  "base:BTC:USD",
  "base:SOL:USD",
  "base:BNB:USD",
] as const;
export const AssetIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9]+:[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)?$/,
    "asset_id shape: '<chain>:<asset>:<quote>' (native-price) or '<protocol>:<kind>' (external adapter)",
  );
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

// P3 Phase 2b: enum widened to cover the four seeded assets × Chainlink/Pyth
// providers. New feeds land by adding a row in `oracles` registry AND a
// matching enum entry here AND a row in oracle-routing's bidirectional map.
// The enum stays closed so a typo in a market row's primary_oracle_id
// surfaces at submit time via derivePolicyFromMarket() rather than the
// resolver tick.
export const REGISTERED_ORACLE_FEEDS = [
  "chainlink:base:ETH-USD",
  "chainlink:base:BTC-USD",
  "chainlink:base:SOL-USD",
  "pyth:base:ETH-USD",
  "pyth:base:BTC-USD",
  "pyth:base:SOL-USD",
  "pyth:base:BNB-USD",
] as const;
export const OracleFeedSchema = z.enum(REGISTERED_ORACLE_FEEDS);
export type OracleFeed = z.infer<typeof OracleFeedSchema>;

// ─── Market registry (multi-asset / multi-horizon / multi-kind) ─────────────
//
// Migration 008 introduced data-driven assets/oracles/markets tables. These
// schemas validate that the rows on the wire (admin upserts, MCP responses,
// public registry endpoints) match the table shapes. Runtime hot path still
// uses the `db.ts` repo types directly to avoid a parse on every read.
//
// `market_kind` is a string, not an enum at the wire layer, so future kinds
// (e.g. "depeg_event_v2") can land without a schema bump on the client. The
// runtime registry is the source of truth — clients reject unknown kinds,
// the daemon emits known ones.

export const REGISTRY_STATUSES = [
  "draft",
  "listed",
  "frozen",
  "retired",
] as const;
export const RegistryStatusSchema = z.enum(REGISTRY_STATUSES);
export type RegistryStatus = z.infer<typeof RegistryStatusSchema>;

// Wave 4b — `event_binary` covers Polymarket-style YES/NO markets where
// the outcome is delivered by an external adapter (no price feed). Score
// kind for those markets is the universal multinomial Brier, scored by
// markets-core::callScore on the payout vector. Native-price direction
// markets continue to use direction_binary + brier_direction.
export const MARKET_KINDS = [
  "direction_binary",
  "price_point",
  "price_bracket",
  "depeg_threshold",
  "event_binary",
] as const;
export const MarketKindSchema = z.enum(MARKET_KINDS);
export type MarketKind = z.infer<typeof MarketKindSchema>;

export const SCORING_KINDS = [
  "brier_direction",
  "rank_proximity_l1",
  "bracket_hit",
  "threshold_hit",
  "multinomial_brier",
] as const;
export const ScoringKindSchema = z.enum(SCORING_KINDS);
export type ScoringKind = z.infer<typeof ScoringKindSchema>;

// Wave 4a — MIGRATION_029 widened the SQL CHECK on `oracles.kind` to
// include 'external_adapter' for adapter-resolved markets (Polymarket
// Gamma is the first such adapter; future Kalshi / Drift / event-feed
// adapters reuse the same value with their own oracle_id). The Zod enum
// here mirrors the SQL CHECK so registry admin writes are bounded the
// same way at the API edge.
export const ORACLE_KINDS = [
  "chainlink_evm",
  "pyth_pull",
  "pyth_solana",
  "external_adapter",
] as const;
export const OracleKindSchema = z.enum(ORACLE_KINDS);
export type OracleKind = z.infer<typeof OracleKindSchema>;

// Wave 4a — market_id is now a union of two adapter-specific shapes:
//
//   Native-price: "<asset-short>.<horizon-label>" — lowercase ASCII
//     dot-separated, e.g. 'eth.1h', 'btc.5m'. Immutable per Codex audit
//     (never rename post-launch).
//   External-adapter: "0x[0-9a-f]{64}" — a Polymarket conditionId or
//     any future external-adapter row whose canonical handle is a
//     32-byte hex hash. Polymarket Gamma is the first such adapter;
//     Kalshi (when it lands) will likely follow a UUID or
//     adapter-namespaced shape that we'd add here.
//
// The regex tolerates either shape at the wire-validation layer; the
// market registry's row lookup is the authoritative "is this market
// listable today?" gate.
export const MarketIdSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(
    /^([a-z0-9]+(\.[a-z0-9]+)+|0x[0-9a-f]{64})$/,
    "market_id: '<asset>.<horizon>' (native-price) or '0x[hex64]' (Polymarket conditionId)",
  );
export type MarketId = z.infer<typeof MarketIdSchema>;

export const OracleIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9-]+$/,
    "lowercase alphanumeric + dashes, e.g. 'pyth-base-eth-usd'",
  );
export type OracleId = z.infer<typeof OracleIdSchema>;

export const AssetRecordSchema = z
  .object({
    asset_id: z.string().min(1),
    display_short: z.string().min(1).max(16),
    display_name: z.string().min(1).max(64),
    native_chain: z.string().min(1).max(64),
    pyth_feed_id: z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),
    chainlink_base_address: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .nullable(),
    decimals_hint: z.number().int().min(0).max(36),
    status: RegistryStatusSchema,
    notes: z.string().max(512).nullable(),
    created_at: z.string().datetime({ offset: false }),
  })
  .strict();
export type AssetRecord = z.infer<typeof AssetRecordSchema>;

export const OracleRecordSchema = z
  .object({
    oracle_id: OracleIdSchema,
    asset_id: z.string().min(1),
    kind: OracleKindSchema,
    adapter: z.string().min(1).max(64),
    chain: z.string().min(1).max(64),
    config_json: z.string(),
    status: RegistryStatusSchema,
    created_at: z.string().datetime({ offset: false }),
  })
  .strict();
export type OracleRecord = z.infer<typeof OracleRecordSchema>;

export const MarketRecordSchema = z
  .object({
    market_id: MarketIdSchema,
    asset_id: z.string().min(1),
    market_kind: MarketKindSchema,
    horizon_seconds: z.number().int().positive(),
    primary_oracle_id: OracleIdSchema,
    fallback_oracle_id: OracleIdSchema.nullable(),
    primary_max_staleness_sec: z.number().int().positive(),
    fallback_max_staleness_sec: z.number().int().positive().nullable(),
    t0_grace_seconds: z.number().int().positive(),
    t0_extended_grace_seconds: z.number().int().positive(),
    void_band: z.string().regex(/^0(\.[0-9]+)?$|^[1-9][0-9]*(\.[0-9]+)?$/),
    round_cadence_seconds: z.number().int().positive().nullable(),
    scoring_kind: ScoringKindSchema,
    market_config_version: z.number().int().positive(),
    status: RegistryStatusSchema,
    notes: z.string().max(512).nullable(),
    created_at: z.string().datetime({ offset: false }),
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
    // direction_binary markets use Brier; the other kinds need their own
    // scoring functions. Catch a config mismatch at write time.
    if (v.market_kind === "direction_binary" && v.scoring_kind !== "brier_direction") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "direction_binary markets require scoring_kind=brier_direction",
        path: ["scoring_kind"],
      });
    }
    // Wave 4b — event_binary markets are adapter-resolved (Polymarket
    // Gamma + future event-feed adapters). The universal payout-vector
    // scorer (multinomial_brier) is the only legal scoring kind; bespoke
    // direction-Brier doesn't apply because there is no price feed.
    if (v.market_kind === "event_binary" && v.scoring_kind !== "multinomial_brier") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "event_binary markets require scoring_kind=multinomial_brier",
        path: ["scoring_kind"],
      });
    }
    // Round-based scoring (rank_proximity_l1, bracket_hit) must declare a
    // cadence so the resolver knows when to close the cohort.
    const roundBased =
      v.scoring_kind === "rank_proximity_l1" ||
      v.scoring_kind === "bracket_hit";
    if (roundBased && v.round_cadence_seconds === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "round-based scoring (rank_proximity_l1 / bracket_hit) requires round_cadence_seconds",
        path: ["round_cadence_seconds"],
      });
    }
  });
export type MarketRecord = z.infer<typeof MarketRecordSchema>;

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

// Wave 3 collapse — the agent.kind taxonomy compresses to four values now
// that the off-platform reputation pipes (verified/wallet_only via X/
// Telegram/wallet claim) and the shadow scraping pipeline are gone. Murmur
// reputation only accrues from on-platform FHE calls, so a single 'agent'
// kind covers everyone who submits via /v2/calls; the other three are
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

// Phase 2c relaxed the runtime CHECK on submissions.horizon_hours from
// IN (1,4,24,168) to >= 0. Phase 2d adds 0 here as a sentinel meaning
// "sub-hour market, canonical horizon is in horizon_seconds." The four
// hour-aligned values stay valid; sub-hour callers stamp 0 so v1 receipt
// subjects (which embed SubmittedCallSchema) parse without conditional
// schema selection.
//
// Note: scoring (see scoring.ts::scoreCall) still uses horizon_hours for
// the Brier formula. For 0-stamped sub-hour calls the score falls back
// to the smallest available bucket (1h vol → 0.006). Phase 2e will route
// scoring through horizon_seconds; until then, sub-hour markets are
// best treated as unranked.
export const HORIZONS_HOURS = [0, 1, 4, 24, 168] as const;
export const HorizonHoursSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(4),
  z.literal(24),
  z.literal(168),
]);
export type HorizonHours = (typeof HORIZONS_HOURS)[number];

// ─── SubmittedCall (agent-supplied) ──────────────────────────────────────────
// Either `rationale` (≤ 240 chars) OR `strategy_tag` MUST be present. This is
// enforced via .superRefine so spam-empty submissions are rejected at the edge.
//
// P3 — markets registry wiring (Codex D1):
// Two wire shapes are accepted, exactly one per submission:
//   (legacy)  { asset_id, horizon_hours, ... }    — pre-P3 agents, benchmarks
//   (market)  { market_id,                ... }   — new agents, multi-asset
// Both shapes hash deterministically into the request body for v2 receipts;
// the daemon must NOT mutate the wire payload before computing request_hash.
// Schema-version stays 1 — no schema_version bump needed (Codex P3 D1).

export const SubmittedCallSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    agent_id: z.string().uuid(),
    client_order_id: z.string().min(8).max(128),
    // Legacy tuple — optional in v0.2.5+ wire shape; required only when
    // market_id is absent. Wave 4a opened AssetIdSchema from a closed
    // native-price enum to an open '<chain>:<asset>:<quote>' /
    // '<protocol>:<kind>' regex; the markets registry remains the
    // authoritative "is this asset listable?" gate.
    asset_id: AssetIdSchema.optional(),
    horizon_hours: HorizonHoursSchema.optional(),
    // New shape — registry-driven market identity. Wave 4a opened
    // MarketIdSchema to also accept '0x[hex64]' Polymarket conditionIds.
    // The daemon still rejects market_id values that don't resolve to a
    // listed `markets` row, regardless of which legal shape was supplied.
    market_id: MarketIdSchema.optional(),
    side: SideSchema,
    confidence: z.number().min(0.51).max(0.95),
    submitted_at: z.string().datetime({ offset: false }),
    rationale: z.string().max(240).optional(),
    strategy_tag: StrategyTagSchema.optional(),
    // P2 commit-reveal opt-in. Defaults to undefined → daemon picks
    // legacy_plaintext for backwards compat. When the agent submits
    // privacy_mode='committed', the daemon computes commit_hash from
    // the canonical preimage (D13) using THIS submission's plaintext
    // plus the agent-supplied salt + daemon-canonical t0, encrypts the
    // body to its age recipient + drand round, and stores ONLY the
    // commit_hash + envelope. Public surfaces never see the plaintext.
    // String, NOT enum, so v0.3 can introduce 'fhevm' without a schema
    // bump (Codex compat note).
    privacy_mode: z.string().optional(),
    // Agent-supplied entropy for the commit preimage. 32 random bytes
    // hex (64 chars). REQUIRED when privacy_mode='committed'; daemon
    // rejects with schema_invalid if missing in that mode. Without it
    // the commit_hash leaks (side, asset, horizon, confidence) via a
    // ~80k-entry dictionary attack.
    salt: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "32-byte hex (64 chars, lowercase preferred)")
      .optional(),
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
    if (v.privacy_mode === "committed" && !v.salt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "salt is required when privacy_mode is 'committed'",
        path: ["salt"],
      });
    }
    // P3 D1: exactly one of {market_id} XOR {asset_id + horizon_hours}.
    const hasMarket = typeof v.market_id === "string";
    const hasLegacy =
      typeof v.asset_id === "string" && typeof v.horizon_hours === "number";
    if (hasMarket && hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "supply EITHER market_id OR (asset_id + horizon_hours), never both",
        path: ["market_id"],
      });
    }
    if (!hasMarket && !hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "must supply market_id OR (asset_id + horizon_hours)",
        path: ["market_id"],
      });
    }
    if (
      !hasMarket &&
      typeof v.asset_id === "string" &&
      typeof v.horizon_hours !== "number"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "horizon_hours required when asset_id is present (legacy shape)",
        path: ["horizon_hours"],
      });
    }
  });
export type SubmittedCall = z.infer<typeof SubmittedCallSchema>;

// Wave 4b-2 — VerdictPreflight + MarketRegime were Santiment-derived
// decoration stamped onto every accepted call. Resolver never consulted
// them; calls settle against Chainlink/Pyth oracles. The preflight
// struct, the /v1/market/preflight endpoint, the preflights table, and
// the entire scout → analyst pipeline are removed. Murmur is a pure
// ranking layer over canonical price/event oracles.

// ─── T0 / oracle anchoring policy ────────────────────────────────────────────

// P3 Phase 2b: feeds widened from ETH literals to the full OracleFeedSchema
// enum. submitCall now derives T0Policy from the resolved market row via
// derivePolicyFromMarket() — receipts for non-ETH markets carry their own
// feeds, not synthesized ETH. Existing v1 receipts already issued only
// referenced ETH feeds, which still pass the wider enum.
//
// P3 Phase 2d: fallback_feed + fallback_max_staleness_sec are optional.
// Codex's audit recommended sub-hour markets be Pyth-only (Chainlink Base
// heartbeat is too coarse for 5m/15m horizons). For markets without a
// fallback configured (eth.5m, eth.15m, BNB at every horizon), receipts
// omit those fields entirely. Verifiers reading existing v1 receipts with
// both fields keep parsing — the .strict() schema accepts the additional
// fields when they were stamped, and accepts their absence for new
// sub-hour calls. The pair is enforced together via superRefine: either
// BOTH fallback fields are present or NEITHER is.
export const T0PolicySchema = z
  .object({
    primary_feed: OracleFeedSchema,
    fallback_feed: OracleFeedSchema.optional(),
    primary_max_staleness_sec: z.number().int().positive(),
    fallback_max_staleness_sec: z.number().int().positive().optional(),
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
    // Phase 2d: fallback fields travel as a pair. Permitting one without
    // the other would leave the resolver in an undefined state when it
    // walks past primary grace.
    const hasFallbackFeed = v.fallback_feed !== undefined;
    const hasFallbackStaleness = v.fallback_max_staleness_sec !== undefined;
    if (hasFallbackFeed !== hasFallbackStaleness) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "fallback_feed and fallback_max_staleness_sec must both be present, or both absent",
        path: ["fallback_feed"],
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

// ─── AcceptedCall (post-acceptance, public-shape projection) ────────────────
//
// Wave 3 made the four plaintext market-signal fields optional (operator-
// blind invariant under FHE-direct submit). Wave 4a additionally makes
// `oracle_policy` optional so external-adapter markets (Polymarket Gamma,
// future Kalshi/Drift/event-feed adapters) can mint without forcing a
// Chainlink/Pyth-shaped policy struct: those markets resolve through
// `adapter.observeResolution(...)` and never anchor against a price feed.
//
// Native-price markets continue to stamp the T0Policy because the
// resolver's tick-time `policyFromCtx` walks the registry separately —
// the policy on the wire is essentially cosmetic / for receipt echoing.
//
// market_id remains the canonical handle the resolver/dispatch/
// leaderboard chain on; absence of oracle_policy is the signal that the
// market is adapter-resolved, not feed-anchored.
export const AcceptedCallSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    scoring_version: z.literal(SCORING_VERSION),
    call_id: z.string().uuid(),
    agent_id: z.string().uuid(),
    client_order_id: z.string().min(8).max(128),
    asset_id: AssetIdSchema.optional(),
    side: SideSchema.optional(),
    horizon_hours: HorizonHoursSchema.optional(),
    confidence: z.number().min(0.51).max(0.95).optional(),
    submitted_at: z.string().datetime({ offset: false }),
    rationale: z.string().max(240).optional(),
    strategy_tag: StrategyTagSchema.optional(),
    accepted_at: z.string().datetime({ offset: false }),
    status: z.literal("accepted"),
    oracle_policy: T0PolicySchema.optional(),
    // Wave 4b — receipts subsystem dropped. acceptance_receipt_hash and
    // acceptance_receipt_cid no longer exist on AcceptedCall; the call_id
    // itself is the canonical identifier downstream consumers chain on.
    // Wave 4b-2 — preflight (Santiment-derived) dropped from the wire shape.
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
    /**
     * Reveal reliability for committed-mode agents (D26 axis 1).
     *   = agent_reveals / (agent_reveals + fallback_reveals)
     * Null when the agent has no committed-mode resolved calls yet.
     * Excludes legacy_plaintext + fhevm_compute so the metric reflects
     * the v0.2 commit-reveal contract. The compatibility field named
     * daemon_fallback_reveals includes both daemon_fallback and
     * drand_fallback rows.
     */
    reveal_reliability: z.number().min(0).max(1).nullable(),
    agent_reveals: z.number().int().nonnegative(),
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
/**
 * Phase F D25 — pillar-4 marketplace booking gate. Stricter than the
 * main-tier threshold: 50 resolved calls AND a non-negative
 * verdict_score_lb. Marketplace consumers should require both before
 * recommending an agent for a paid booking.
 */
export const MIN_RESOLVED_CALLS_FOR_MARKETPLACE_TIER = 50;
export const SHADOW_CLAIM_LOOKBACK_DAYS = 30;
export const RATIONALE_MAX_CHARS = 240;
