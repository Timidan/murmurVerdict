import { z } from "zod";

// ─── Asset registry ──────────────────────────────────────────────────────────
//
// Live asset_ids are "<protocol>:<kind>" synthetics (e.g. "polymarket:event").
// The retired "<chain>:<asset>:<quote>" form is admitted only so old rows stay readable.
// This regex is only the wire-shape gate; the registry decides listability.
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
// Wire validation for registry rows (admin upserts, public endpoints); hot reads use repo types directly.

export const REGISTRY_STATUSES = [
  "draft",
  "listed",
  "frozen",
  "retired",
] as const;
export const RegistryStatusSchema = z.enum(REGISTRY_STATUSES);
export type RegistryStatus = z.infer<typeof RegistryStatusSchema>;

// `event_binary` + `multinomial_brier` are the only mintable kinds.
// The legacy members exist only so retired rows parse; external-market-guard.ts refuses them on mint.
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

// Mirrors the SQL CHECK on `oracles.kind`; `external_adapter` covers adapter-resolved markets.
export const ORACLE_KINDS = [
  "chainlink_evm",
  "pyth_pull",
  "pyth_solana",
  "external_adapter",
] as const;
export const OracleKindSchema = z.enum(ORACLE_KINDS);
export type OracleKind = z.infer<typeof OracleKindSchema>;

// market_id: "0x" + 64 hex (venue conditionId), or the retired "<asset>.<horizon>" form (e.g. 'eth.1h')
// kept only so old rows parse. Mintability is decided by the registry and requireMintableExternalMarket.
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

/**
 * A `markets` registry row. The `*_staleness_sec` / `t0_*_grace_seconds` columns are
 * vestigial (external rows persist 0) and are not cross-checked.
 */
export const MarketRecordSchema = z
  .object({
    market_id: MarketIdSchema,
    asset_id: z.string().min(1),
    market_kind: MarketKindSchema,
    horizon_seconds: z.number().int().positive(),
    primary_oracle_id: OracleIdSchema,
    fallback_oracle_id: OracleIdSchema.nullable(),
    primary_max_staleness_sec: z.number().int().nonnegative(),
    fallback_max_staleness_sec: z.number().int().nonnegative().nullable(),
    t0_grace_seconds: z.number().int().nonnegative(),
    t0_extended_grace_seconds: z.number().int().nonnegative(),
    void_band: z.string().regex(/^0(\.[0-9]+)?$|^[1-9][0-9]*(\.[0-9]+)?$/),
    round_cadence_seconds: z.number().int().positive().nullable(),
    scoring_kind: ScoringKindSchema,
    market_config_version: z.number().int().positive(),
    status: RegistryStatusSchema,
    notes: z.string().max(512).nullable(),
    created_at: z.string().datetime({ offset: false }),
    // External-adapter identity. Nullable only so pre-adapter historical rows
    // still parse; the mint guard requires all three on anything listable.
    adapter_id: z.string().min(1).max(64).nullable().optional(),
    market_family: z.string().min(1).max(64).nullable().optional(),
    config_json: z.string().nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // event_binary must be scored by multinomial_brier.
    if (v.market_kind === "event_binary" && v.scoring_kind !== "multinomial_brier") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "event_binary markets require scoring_kind=multinomial_brier",
        path: ["scoring_kind"],
      });
    }
  });
export type MarketRecord = z.infer<typeof MarketRecordSchema>;
