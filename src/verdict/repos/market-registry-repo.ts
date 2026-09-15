import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import {
  marketConfigSnapshotFromHistoryRow,
  marketConfigSnapshotJson,
  type MarketConfigSnapshot,
} from "../market-config-snapshot.js";
import type {
  MarketKind,
  OracleKind,
  RegistryStatus,
  ScoringKind,
} from "../market-registry-schema.js";

export type {
  MarketKind,
  RegistryStatus,
  ScoringKind,
} from "../market-registry-schema.js";
export type { MarketConfigSnapshot } from "../market-config-snapshot.js";

export interface AssetRow {
  asset_id: string;
  display_short: string;
  display_name: string;
  native_chain: string;
  pyth_feed_id: string | null;
  chainlink_base_address: string | null;
  decimals_hint: number;
  status: RegistryStatus;
  notes: string | null;
  created_at: string;
}

export interface OracleRow {
  oracle_id: string;
  asset_id: string;
  kind: OracleKind;
  adapter: string;
  chain: string;
  config_json: string;
  status: RegistryStatus;
  created_at: string;
}

export interface MarketRow {
  /** Set when an operator pulled this market; discovery never relists over it. */
  operator_halted_at?: string | null;
  market_id: string;
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
  market_config_version: number;
  status: RegistryStatus;
  notes: string | null;
  created_at: string;
  adapter_id: string | null;
  market_family: string | null;
  config_json: string;
  /** The venue series this instance belongs to, or null; null reads downstream as unsellable. */
  venue_series_id: string | null;
}

export const assetsRepo = {
  list(db: Database.Database, status?: RegistryStatus): AssetRow[] {
    const sql = status
      ? `SELECT * FROM assets WHERE status = ? ORDER BY display_short`
      : `SELECT * FROM assets ORDER BY display_short`;
    const stmt = prep(db, sql);
    return (status ? stmt.all(status) : stmt.all()) as AssetRow[];
  },

  get(db: Database.Database, asset_id: string): AssetRow | null {
    return (
      (prep(db, `SELECT * FROM assets WHERE asset_id = ?`).get(
        asset_id,
      ) as AssetRow | undefined) ?? null
    );
  },

  bySlug(db: Database.Database, display_short: string): AssetRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM assets WHERE display_short = ? COLLATE NOCASE`,
      ).get(display_short) as AssetRow | undefined) ?? null
    );
  },

  setStatus(
    db: Database.Database,
    asset_id: string,
    status: RegistryStatus,
  ): void {
    prep(db, `UPDATE assets SET status = ? WHERE asset_id = ?`).run(
      status,
      asset_id,
    );
  },
};

export const oraclesRepo = {
  list(db: Database.Database, status?: RegistryStatus): OracleRow[] {
    const sql = status
      ? `SELECT * FROM oracles WHERE status = ? ORDER BY oracle_id`
      : `SELECT * FROM oracles ORDER BY oracle_id`;
    const stmt = prep(db, sql);
    return (status ? stmt.all(status) : stmt.all()) as OracleRow[];
  },

  get(db: Database.Database, oracle_id: string): OracleRow | null {
    return (
      (prep(db, `SELECT * FROM oracles WHERE oracle_id = ?`).get(
        oracle_id,
      ) as OracleRow | undefined) ?? null
    );
  },

  listForAsset(db: Database.Database, asset_id: string): OracleRow[] {
    return prep(
      db,
      `SELECT * FROM oracles WHERE asset_id = ? ORDER BY oracle_id`,
    ).all(asset_id) as OracleRow[];
  },

  setStatus(
    db: Database.Database,
    oracle_id: string,
    status: RegistryStatus,
  ): void {
    prep(db, `UPDATE oracles SET status = ? WHERE oracle_id = ?`).run(
      status,
      oracle_id,
    );
  },
};

export const marketsRepo = {
  /** Replace a market's adapter config; registration stamps series values (e.g. `embargoSec`) here. */
  setConfigJson(db: Database.Database, marketId: string, configJson: string): void {
    db.prepare(
      `UPDATE markets SET config_json = @config_json WHERE market_id = @market_id`,
    ).run({ market_id: marketId, config_json: configJson });
  },

  /**
   * Halt a market by operator and set its status in one write. The marker lets discovery tell
   * an operator's freeze from its own repair freeze, so it never relists over it.
   */
  haltByOperator(
    db: Database.Database,
    marketId: string,
    status: RegistryStatus,
    nowIso: string,
  ): void {
    prep(
      db,
      `UPDATE markets
          SET status = @status, operator_halted_at = @now
        WHERE market_id = @market_id`,
    ).run({ market_id: marketId, status, now: nowIso });
  },

  /**
   * True when an operator has halted this market. Discovery must treat it as
   * terminal on EVERY listing path — including a halted `draft`, which is
   * still "an operator took this out of service", not "resume it".
   */
  isOperatorHalted(db: Database.Database, marketId: string): boolean {
    const row = prep(
      db,
      `SELECT operator_halted_at FROM markets WHERE market_id = ?`,
    ).get(marketId) as { operator_halted_at: string | null } | undefined;
    return Boolean(row?.operator_halted_at);
  },

  /** Lifted only by a full re-registration, which restates the schedule. */
  clearOperatorHalt(db: Database.Database, marketId: string): void {
    prep(
      db,
      `UPDATE markets SET operator_halted_at = NULL WHERE market_id = ?`,
    ).run(marketId);
  },

  list(db: Database.Database, status?: RegistryStatus): MarketRow[] {
    const sql = status
      ? `SELECT * FROM markets WHERE status = ? ORDER BY asset_id, horizon_seconds`
      : `SELECT * FROM markets ORDER BY asset_id, horizon_seconds`;
    const stmt = prep(db, sql);
    return (status ? stmt.all(status) : stmt.all()) as MarketRow[];
  },

  listed(db: Database.Database): MarketRow[] {
    return this.list(db, "listed");
  },

  get(db: Database.Database, market_id: string): MarketRow | null {
    return (
      (prep(db, `SELECT * FROM markets WHERE market_id = ?`).get(
        market_id,
      ) as MarketRow | undefined) ?? null
    );
  },

  /**
   * Read-time helper for legacy submissions (market_id IS NULL): synthesize
   * a market_id from (asset_id, horizon_hours) so feed/leaderboard can join
   * unified rows. Mapping is:
   *   base:ETH:USD + 1h   -> eth.1h
   *   base:ETH:USD + 4h   -> eth.4h
   *   base:ETH:USD + 24h  -> eth.24h
   *   base:ETH:USD + 168h -> eth.7d
   * Returns null for unknown asset/horizon pairs (legacy never had these).
   */
  legacyIdFor(asset_id: string, horizon_hours: number): string | null {
    const horizonLabel = LEGACY_HORIZON_LABELS[horizon_hours];
    if (!horizonLabel) return null;
    const slug = LEGACY_ASSET_SHORT[asset_id];
    if (!slug) return null;
    return `${slug}.${horizonLabel}`;
  },

  setStatus(
    db: Database.Database,
    market_id: string,
    status: RegistryStatus,
  ): void {
    prep(db, `UPDATE markets SET status = ? WHERE market_id = ?`).run(
      status,
      market_id,
    );
  },

  upsertExternalMarket(
    db: Database.Database,
    row: {
      market_id: string;
      asset_id: string;
      market_kind: string;
      horizon_seconds: number;
      primary_oracle_id: string;
      adapter_id: string;
      market_family: string;
      scoring_kind: string;
      config_json: string;
      void_band: string;
      status: RegistryStatus;
      created_at: string;
      /**
       * The venue series this instance belongs to, or null. Written on insert and on
       * conflict, from the same projection as config_json, so the two never disagree.
       */
      venue_series_id?: string | null;
    },
  ): void {
    prep(
      db,
      `INSERT INTO markets (
         market_id, asset_id, market_kind, horizon_seconds,
         primary_oracle_id, fallback_oracle_id,
         primary_max_staleness_sec, fallback_max_staleness_sec,
         t0_grace_seconds, t0_extended_grace_seconds,
         void_band, round_cadence_seconds, scoring_kind,
         market_config_version, status, notes, created_at,
         adapter_id, market_family, config_json, venue_series_id
       ) VALUES (
         @market_id, @asset_id, @market_kind, @horizon_seconds,
         @primary_oracle_id, NULL,
         0, NULL,
         0, 0,
         @void_band, NULL, @scoring_kind,
         1, @status, NULL, @created_at,
         @adapter_id, @market_family, @config_json, @venue_series_id
       )
       ON CONFLICT(market_id) DO UPDATE SET
         config_json     = excluded.config_json,
         market_kind     = excluded.market_kind,
         scoring_kind    = excluded.scoring_kind,
         status          = excluded.status,
         adapter_id      = excluded.adapter_id,
         market_family   = excluded.market_family,
         horizon_seconds = excluded.horizon_seconds,
         venue_series_id = excluded.venue_series_id`,
      // better-sqlite3 rejects an absent/undefined named parameter, so a caller
      // that omits venue_series_id must still bind an explicit null.
    ).run({ ...row, venue_series_id: row.venue_series_id ?? null });
  },

  bumpConfig(
    db: Database.Database,
    market_id: string,
    patch: Partial<
      Pick<
        MarketRow,
        | "primary_oracle_id"
        | "fallback_oracle_id"
        | "primary_max_staleness_sec"
        | "fallback_max_staleness_sec"
        | "t0_grace_seconds"
        | "t0_extended_grace_seconds"
        | "void_band"
        | "scoring_kind"
        | "round_cadence_seconds"
      >
    >,
  ): void {
    const fields = Object.keys(patch).filter(
      (k) => (patch as Record<string, unknown>)[k] !== undefined,
    );
    if (fields.length === 0) return;
    const setClause = fields.map((f) => `${f} = @${f}`).join(", ");

    db.transaction(() => {
      prep(
        db,
        `UPDATE markets
         SET ${setClause}, market_config_version = market_config_version + 1
         WHERE market_id = @market_id`,
      ).run({ ...patch, market_id });

      const snapshot = prep(
        db,
        `SELECT * FROM markets WHERE market_id = @market_id`,
      ).get({ market_id }) as MarketRow | undefined;
      if (!snapshot) return;

      prep(
        db,
        `INSERT INTO market_config_history
           (market_id, market_config_version, snapshot_json, recorded_at)
         VALUES (
           @market_id,
           @market_config_version,
           @snapshot_json,
           strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         )`,
      ).run({
        market_id: snapshot.market_id,
        market_config_version: snapshot.market_config_version,
        snapshot_json: marketConfigSnapshotJson(snapshot),
      });
    })();
  },

  getConfigAt(
    db: Database.Database,
    market_id: string,
    market_config_version: number,
  ): MarketConfigSnapshot | null {
    const row = prep(
      db,
      `SELECT snapshot_json, recorded_at FROM market_config_history
       WHERE market_id = ? AND market_config_version = ?`,
    ).get(market_id, market_config_version) as
      | { snapshot_json: string; recorded_at: string }
      | undefined;
    if (!row) return null;
    return marketConfigSnapshotFromHistoryRow({
      market_id,
      snapshot_json: row.snapshot_json,
      recorded_at: row.recorded_at,
    });
  },
};

const LEGACY_HORIZON_LABELS: Record<number, string> = {
  1: "1h",
  4: "4h",
  24: "24h",
  168: "7d",
};

const LEGACY_ASSET_SHORT: Record<string, string> = {
  "base:ETH:USD": "eth",
  "base:BTC:USD": "btc",
  "base:SOL:USD": "sol",
  "base:BNB:USD": "bnb",
};
