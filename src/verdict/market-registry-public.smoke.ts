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
  const market = marketsRepo.get(db, "eth.1h");
  assert.ok(market);

  const publicRow = publicMarketRegistryRow(market);
  assert.equal(publicRow.market_id, "eth.1h");
  assert.equal(publicRow.adapter_id, "native-price");
  assert.equal(publicRow.market_taxonomy.resolution_class, "price_direction");
  assert.equal("config_json" in publicRow, false);
  assert.equal("oracles" in publicRow, false);

  const publicRowWithOracles = publicMarketRegistryRow(market, { db });
  assert.equal(publicRowWithOracles.oracles?.health, "ok");
  assert.equal(publicRowWithOracles.oracles?.primary.oracle_id, "chainlink-base-eth-usd");
  assert.equal(publicRowWithOracles.oracles?.primary.status, "listed");
  assert.equal(publicRowWithOracles.oracles?.primary.asset_match, true);
  assert.equal(publicRowWithOracles.oracles?.fallback?.oracle_id, "pyth-base-eth-usd");

  const enriched = enrichedMarketRegistryRow(market, { db });
  assert.equal(enriched.config_json, market.config_json);
  assert.equal(enriched.adapter_id, "native-price");
  assert.equal(enriched.market_taxonomy.resolution_class, "price_direction");
  assert.equal(enriched.oracles?.health, "ok");

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
    query: "eth",
    adapter_id: "native-price",
    resolution_class: "price_direction",
    limit: 5,
  });
  assert.ok(search.some((item) => item.market_id === "eth.1h"));

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
  const listedEth = body.markets.find((item) => item.market_id === "eth.1h");
  assert.equal(listedEth?.config_json, market.config_json);
  assert.equal(listedEth?.market_taxonomy?.resolution_class, "price_direction");
  assert.equal(listedEth?.oracles?.health, "ok");

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("market registry public smoke ok\n");
