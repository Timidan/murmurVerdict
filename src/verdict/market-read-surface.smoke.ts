import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { marketsRepo, openDb } from "./db.js";
import {
  listMarketsSurface,
  marketLeaderboardSurface,
  marketTaxonomySurface,
  sendMarketReadJsonResponse,
} from "./market-read-surface.js";

class FakeMarketReadJsonResponse {
  statusCode: number | null = null;
  body: unknown = null;

  status(code: number): { json: (body: unknown) => void } {
    this.statusCode = code;
    return {
      json: (body: unknown) => {
        this.body = body;
      },
    };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-market-read-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur market read surface smoke\n");
  const db = openDb({ path: dbPath });
  const servedAt = new Date("2026-06-12T09:30:00Z");
  const marketId = `0x${"cd".repeat(32)}`;
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
      slug: "market-read-surface-smoke",
      outcomes: ["YES", "NO"],
      endDate: "2026-06-13T00:00:00Z",
      gamma_url: "https://polymarket.com/event/market-read-surface-smoke",
    }),
    void_band: "0",
    status: "listed",
    created_at: "2026-06-12T09:00:00Z",
  });

  const taxonomy = marketTaxonomySurface({ servedAt });
  assert.equal(taxonomy.status, 200);
  assert.equal(
    (taxonomy.body as { served_at: string }).served_at,
    "2026-06-12T09:30:00Z",
  );
  const taxonomyRes = new FakeMarketReadJsonResponse();
  sendMarketReadJsonResponse(taxonomyRes, taxonomy);
  assert.equal(taxonomyRes.statusCode, 200);
  assert.equal(
    (taxonomyRes.body as { taxonomy: { live_resolution_classes: string[] } }).taxonomy
      .live_resolution_classes.includes("event_binary"),
    true,
  );

  const listedMarkets = listMarketsSurface({
    db,
    query: { assetId: null, status: "listed" },
    servedAt,
  });
  assert.equal(listedMarkets.status, 200);
  const listedIds = (listedMarkets.body as {
    markets: Array<{ market_id: string }>;
  }).markets.map((market) => market.market_id);
  assert.equal(listedIds.includes(marketId), true);
  // MIGRATION_061 retired every seeded native-price market.
  assert.equal(listedIds.includes("eth.1h"), false);
  const listedRow = (listedMarkets.body as {
    markets: Array<{
      market_id: string;
      oracles?: {
        health?: string;
        primary?: { oracle_id?: string; status?: string; asset_match?: boolean };
      };
    }>;
  }).markets.find((market) => market.market_id === marketId);
  assert.equal(listedRow?.oracles?.health, "ok");
  assert.equal(listedRow?.oracles?.primary?.oracle_id, "polymarket-gamma-oracle");
  assert.equal(listedRow?.oracles?.primary?.status, "listed");
  assert.equal(listedRow?.oracles?.primary?.asset_match, true);

  const unknownMarket = marketLeaderboardSurface({
    db,
    marketId: "doge.1h",
    query: { limit: 20 },
    servedAt,
  });
  assert.equal(unknownMarket.status, 404);
  assert.deepEqual(unknownMarket.body, { error: "unknown_market" });
  const unknownMarketRes = new FakeMarketReadJsonResponse();
  sendMarketReadJsonResponse(unknownMarketRes, unknownMarket);
  assert.equal(unknownMarketRes.statusCode, 404);
  assert.deepEqual(unknownMarketRes.body, { error: "unknown_market" });

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("market read surface smoke ok\n");
