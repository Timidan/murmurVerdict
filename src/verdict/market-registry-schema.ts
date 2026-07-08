import { z } from "zod";

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
// schemas validate that the rows on the wire (admin upserts and public
// registry endpoints) match the table shapes. Runtime hot path still
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
