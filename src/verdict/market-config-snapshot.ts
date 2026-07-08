import { z } from "zod";

import {
  MarketKindSchema,
  ScoringKindSchema,
  type MarketKind,
  type ScoringKind,
} from "./market-registry-schema.js";

export interface MarketConfigSnapshot {
  market_id: string;
  market_config_version: number;
  asset_id: string;
  market_kind: MarketKind;
  horizon_seconds: number;
  primary_oracle_id: string;
  fallback_oracle_id: string | null;
  primary_max_staleness_sec: number;
  fallback_max_staleness_sec: number | null;
  t0_grace_seconds: number;
  t0_extended_grace_seconds: number;
  void_band: string;
  round_cadence_seconds: number | null;
  scoring_kind: ScoringKind;
  recorded_at: string;
}

export type MarketConfigSnapshotSource = Omit<
  MarketConfigSnapshot,
  "recorded_at"
>;

const StoredMarketConfigSnapshotSchema = z
  .object({
    asset_id: z.string(),
    market_kind: MarketKindSchema,
    horizon_seconds: z.number().int(),
    primary_oracle_id: z.string(),
    fallback_oracle_id: z.string().nullable(),
    primary_max_staleness_sec: z.number().int(),
    fallback_max_staleness_sec: z.number().int().nullable(),
    t0_grace_seconds: z.number().int(),
    t0_extended_grace_seconds: z.number().int(),
    void_band: z.string(),
    round_cadence_seconds: z.number().int().nullable(),
    scoring_kind: ScoringKindSchema,
    market_config_version: z.number().int(),
  })
  .strict();

type StoredMarketConfigSnapshot = z.infer<typeof StoredMarketConfigSnapshotSchema>;

export interface MarketConfigSnapshotHistoryRow {
  market_id: string;
  snapshot_json: string;
  recorded_at: string;
}

export function storedMarketConfigSnapshot(
  source: MarketConfigSnapshotSource,
): StoredMarketConfigSnapshot {
  return {
    asset_id: source.asset_id,
    market_kind: source.market_kind,
    horizon_seconds: source.horizon_seconds,
    primary_oracle_id: source.primary_oracle_id,
    fallback_oracle_id: source.fallback_oracle_id,
    primary_max_staleness_sec: source.primary_max_staleness_sec,
    fallback_max_staleness_sec: source.fallback_max_staleness_sec,
    t0_grace_seconds: source.t0_grace_seconds,
    t0_extended_grace_seconds: source.t0_extended_grace_seconds,
    void_band: source.void_band,
    round_cadence_seconds: source.round_cadence_seconds,
    scoring_kind: source.scoring_kind,
    market_config_version: source.market_config_version,
  };
}

export function marketConfigSnapshotJson(
  source: MarketConfigSnapshotSource,
): string {
  return JSON.stringify(storedMarketConfigSnapshot(source));
}

export function marketConfigSnapshotFromHistoryRow(
  row: MarketConfigSnapshotHistoryRow,
): MarketConfigSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.snapshot_json) as unknown;
  } catch {
    return null;
  }
  const stored = StoredMarketConfigSnapshotSchema.safeParse(parsed);
  if (!stored.success) return null;
  return {
    market_id: row.market_id,
    ...stored.data,
    recorded_at: row.recorded_at,
  };
}
