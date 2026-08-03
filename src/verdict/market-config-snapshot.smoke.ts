import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  marketConfigSnapshotFromHistoryRow,
  marketConfigSnapshotJson,
  storedMarketConfigSnapshot,
} from "./market-config-snapshot.js";
import { marketsRepo } from "./repos/market-registry-repo.js";

process.stdout.write("murmur market config snapshot smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "murmur-market-config-snapshot-"));
const dbPath = join(tmp, "test.db");

try {
  const db = openDb({ path: dbPath });
  // Seed the fixture rather than leaning on a seeded catalogue: murmur ships
  // no markets of its own (MIGRATION_062 removed the last native rows), so a
  // fresh database is intentionally empty until an external one is registered.
  const marketId = `0x${"5c".repeat(32)}`;
  marketsRepo.upsertExternalMarket(db, {
    market_id: marketId,
    asset_id: "polymarket:event",
    market_kind: "event_binary",
    horizon_seconds: 3600,
    primary_oracle_id: "polymarket-gamma-oracle",
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
    scoring_kind: "multinomial_brier",
    config_json: JSON.stringify({ conditionId: marketId, outcomes: ["Up", "Down"] }),
    void_band: "0",
    status: "listed",
    created_at: "2026-05-14T12:00:00Z",
  });
  const market = marketsRepo.get(db, marketId);
  assert.ok(market);

  assert.deepEqual(storedMarketConfigSnapshot(market), {
    asset_id: market.asset_id,
    market_kind: market.market_kind,
    horizon_seconds: market.horizon_seconds,
    primary_oracle_id: market.primary_oracle_id,
    fallback_oracle_id: market.fallback_oracle_id,
    primary_max_staleness_sec: market.primary_max_staleness_sec,
    fallback_max_staleness_sec: market.fallback_max_staleness_sec,
    t0_grace_seconds: market.t0_grace_seconds,
    t0_extended_grace_seconds: market.t0_extended_grace_seconds,
    void_band: market.void_band,
    round_cadence_seconds: market.round_cadence_seconds,
    scoring_kind: market.scoring_kind,
    market_config_version: market.market_config_version,
  });

  assert.deepEqual(
    marketConfigSnapshotFromHistoryRow({
      market_id: market.market_id,
      snapshot_json: marketConfigSnapshotJson(market),
      recorded_at: "2026-06-12T09:30:00Z",
    }),
    {
      market_id: market.market_id,
      ...storedMarketConfigSnapshot(market),
      recorded_at: "2026-06-12T09:30:00Z",
    },
  );

  assert.equal(
    marketConfigSnapshotFromHistoryRow({
      market_id: market.market_id,
      snapshot_json: "{broken",
      recorded_at: "2026-06-12T09:30:00Z",
    }),
    null,
  );
  assert.equal(
    marketConfigSnapshotFromHistoryRow({
      market_id: market.market_id,
      snapshot_json: JSON.stringify({
        ...storedMarketConfigSnapshot(market),
        horizon_seconds: "3600",
      }),
      recorded_at: "2026-06-12T09:30:00Z",
    }),
    null,
  );

  marketsRepo.bumpConfig(db, market.market_id, {
    void_band: "0.075",
    round_cadence_seconds: 900,
  });
  const bumped = marketsRepo.get(db, market.market_id);
  assert.ok(bumped);
  const history = marketsRepo.getConfigAt(
    db,
    market.market_id,
    bumped.market_config_version,
  );
  assert.ok(history);
  assert.equal(history.market_id, market.market_id);
  assert.equal(history.market_config_version, bumped.market_config_version);
  assert.equal(history.void_band, "0.075");
  assert.equal(history.round_cadence_seconds, 900);
  assert.match(history.recorded_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("market config snapshot smoke ok\n");
