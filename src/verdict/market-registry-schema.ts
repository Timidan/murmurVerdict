import { z } from "zod";

// ─── Asset registry ──────────────────────────────────────────────────────────
//
// Live asset_ids are external-adapter synthetics: "<protocol>:<kind>" (e.g.
// "polymarket:event"). MIGRATION_029 seeded "polymarket:event" as the
// synthetic anchor for every Polymarket conditionId market; future venue
// families (Kalshi, Drift, …) follow the same pattern.
//
// The regex still admits the legacy three-segment "<chain>:<asset>:<quote>"
// form (e.g. "base:ETH:USD") purely so historical rows stay READABLE — those
// assets are retired by MIGRATION_061 and nothing can mint against them.
//
// The registry (assets table + adapter dispatch) is the source of truth for
// whether an asset_id is listable; this regex is only the wire-shape gate.
export const AssetIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9]+:[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)?$/,
    "asset_id shape: '<protocol>:<kind>' (external adapter) or the legacy '<chain>:<asset>:<quote>' read-compat form",
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

// `event_binary` is the ONE market kind Murmur mints against: a YES/NO market
// whose outcome an external venue publishes. `multinomial_brier` is the ONE
// scoring kind: the universal payout-vector scorer in markets-core::callScore.
//
// LEGACY READ UNIONS. `direction_binary` / `brier_direction` remain listed so
// the frozen native-price market row (retired by MIGRATION_061) still parses
// on a registry read. They are NOT writable: the shared external-market guard
// (external-market-guard.ts) accepts only event_binary + multinomial_brier,
// and MarketRecordSchema below rejects the pairing on any new write.
export const ACTIVE_MARKET_KINDS = ["event_binary"] as const;
export const LEGACY_READ_MARKET_KINDS = ["direction_binary"] as const;
export const MARKET_KINDS = [
  ...ACTIVE_MARKET_KINDS,
  ...LEGACY_READ_MARKET_KINDS,
] as const;
export const MarketKindSchema = z.enum(MARKET_KINDS);
export type MarketKind = z.infer<typeof MarketKindSchema>;

export const ACTIVE_SCORING_KINDS = ["multinomial_brier"] as const;
export const LEGACY_READ_SCORING_KINDS = ["brier_direction"] as const;
export const SCORING_KINDS = [
  ...ACTIVE_SCORING_KINDS,
  ...LEGACY_READ_SCORING_KINDS,
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

// market_id shapes:
//
//   External-adapter (live): "0x[0-9a-f]{64}" — a Polymarket conditionId, or
//     any future venue row whose canonical handle is a 32-byte hex hash.
//   Legacy read-compat: "<asset-short>.<horizon-label>" — lowercase ASCII
//     dot-separated, e.g. 'eth.1h'. Retained ONLY so the frozen native-price
//     row stays queryable; nothing mints against it.
//
// The regex tolerates either shape at the wire-validation layer; the market
// registry row lookup plus requireMintableExternalMarket are the authoritative
// "is this market mintable today?" gate.
export const MarketIdSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(
    /^([a-z0-9]+(\.[a-z0-9]+)+|0x[0-9a-f]{64})$/,
    "market_id: '0x[hex64]' (venue conditionId) or the legacy '<asset>.<horizon>' read-compat form",
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
    // Externally-resolved markets are scored by the universal payout-vector
    // scorer, and that is the only pairing this schema will VALIDATE. The
    // legacy direction_binary / brier_direction members exist purely so a
    // historical row parses on a read; writing that pairing is refused here.
    if (v.market_kind === "event_binary" && v.scoring_kind !== "multinomial_brier") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "event_binary markets require scoring_kind=multinomial_brier",
        path: ["scoring_kind"],
      });
    }
  });
export type MarketRecord = z.infer<typeof MarketRecordSchema>;
