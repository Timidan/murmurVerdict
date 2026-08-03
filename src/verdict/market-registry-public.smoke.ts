import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import { marketsRepo } from "./repos/market-registry-repo.js";
import {
  enrichedMarketRegistryRow,
  publicMarketConfigSummary,
  publicMarketRegistryRow,
  searchPublicMarkets,
} from "./market-registry-public.js";
import { listMarketsSurface } from "./market-read-surface.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-market-registry-public-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur market registry public smoke\n");
  const db = openDb({ path: dbPath });
  const servedAt = new Date("2026-06-12T09:30:00Z");
  const marketId = `0x${"ab".repeat(32)}`;
  marketsRepo.upsertExternalMarket(db, {
    market_id: marketId,
    asset_id: "polymarket:event",
    market_kind: "event_binary",
    horizon_seconds: 3600,
    primary_oracle_id: "polymarket-gamma-oracle",
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
    scoring_kind: "multinomial_brier",
    config_json: JSON.stringify({
      conditionId: marketId,
      slug: "eth-up-registry-smoke",
      outcomes: ["YES", "NO"],
      endDate: "2026-06-13T00:00:00Z",
      gamma_url: "https://polymarket.com/event/eth-up-registry-smoke",
    }),
    void_band: "0",
    status: "listed",
    created_at: "2026-06-12T09:00:00Z",
  });
  const market = marketsRepo.get(db, marketId);
  assert.ok(market);

  const publicRow = publicMarketRegistryRow(market);
  assert.equal(publicRow.market_id, marketId);
  assert.equal(publicRow.adapter_id, "polymarket-gamma");
  assert.equal(publicRow.market_taxonomy.resolution_class, "event_binary");
  assert.equal("config_json" in publicRow, false);
  assert.equal("oracles" in publicRow, false);

  // The registry oracle slot is now purely the EXTERNAL adapter identity —
  // markets.primary_oracle_id is still NOT NULL/FK-shaped, and Polymarket
  // registration writes the synthetic polymarket-gamma-oracle row.
  const publicRowWithOracles = publicMarketRegistryRow(market, { db });
  assert.equal(publicRowWithOracles.oracles?.health, "ok");
  assert.equal(
    publicRowWithOracles.oracles?.primary.oracle_id,
    "polymarket-gamma-oracle",
  );
  assert.equal(publicRowWithOracles.oracles?.primary.kind, "external_adapter");
  assert.equal(publicRowWithOracles.oracles?.primary.status, "listed");
  assert.equal(publicRowWithOracles.oracles?.primary.asset_match, true);
  assert.equal(publicRowWithOracles.oracles?.fallback, null);

  const enriched = enrichedMarketRegistryRow(market, { db });
  assert.equal(enriched.config_json, market.config_json);
  assert.equal(enriched.adapter_id, "polymarket-gamma");
  assert.equal(enriched.market_taxonomy.resolution_class, "event_binary");
  assert.equal(enriched.oracles?.health, "ok");

  // MIGRATION_061 retired every seeded native-price market and MIGRATION_062
  // deleted the unreferenced ones; none of them may
  // ever surface on a `listed` public read again.
  assert.equal(marketsRepo.get(db, "eth.1h"), null,
    "MIGRATION_062 deletes the unreferenced native market rows outright");

  assert.deepEqual(
    publicMarketConfigSummary(JSON.stringify({
      conditionId: "0xabc",
      slug: "eth-up",
      outcomes: ["YES", "NO"],
      endDate: "2026-06-13T00:00:00Z",
      gamma_url: "https://gamma.example/markets/eth-up",
      private_note: "do not expose",
    })),
    {
      conditionId: "0xabc",
      slug: "eth-up",
      outcomes: ["YES", "NO"],
      endDate: "2026-06-13T00:00:00Z",
      gamma_url: "https://gamma.example/markets/eth-up",
    },
  );
  assert.deepEqual(publicMarketConfigSummary("{"), {});
  assert.deepEqual(publicMarketConfigSummary("[]"), {});

  const search = searchPublicMarkets(db, {
    query: "eth-up-registry-smoke",
    adapter_id: "polymarket-gamma",
    resolution_class: "event_binary",
    limit: 5,
  });
  assert.ok(search.some((item) => item.market_id === marketId));
  assert.equal(search.some((item) => item.market_id === "eth.1h"), false);

  const listed = listMarketsSurface({
    db,
    query: { assetId: null, status: "listed" },
    servedAt,
  });
  assert.equal(listed.status, 200);
  const body = listed.body as {
    markets: Array<{
      market_id: string;
      config_json?: string;
      market_taxonomy?: { resolution_class?: string };
      oracles?: { health?: string };
    }>;
  };
  const listedRow = body.markets.find((item) => item.market_id === marketId);
  assert.equal(listedRow?.config_json, market.config_json);
  assert.equal(listedRow?.market_taxonomy?.resolution_class, "event_binary");
  assert.equal(listedRow?.oracles?.health, "ok");
  assert.equal(body.markets.some((item) => item.market_id === "eth.1h"), false);

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("market registry public smoke ok\n");
