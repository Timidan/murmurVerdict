import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentsRepo,
  marketsRepo,
  openDb,
  resolutionsRepo,
  submissionsRepo,
} from "./db.js";
import {
  listMarketsWithVenueSurface,
  marketCallsSurface,
  marketDetailSurface,
  sendMarketReadJsonResponse,
} from "./market-read-surface.js";
import { PolymarketGammaClient } from "../markets/polymarket-gamma/client.js";
import {
  PolymarketVenueSnapshotProvider,
  type MarketVenueSnapshot,
} from "../markets/polymarket-gamma/venue-snapshot.js";

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

type VenueMarketRow = Record<string, unknown> & {
  market_id: string;
  venue?: MarketVenueSnapshot;
};

const tmp = mkdtempSync(join(tmpdir(), "murmur-market-detail-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur market detail surface smoke\n");
  const db = openDb({ path: dbPath });
  const servedAt = new Date("2026-06-12T09:30:00Z");
  const nowMs = () => servedAt.getTime();

  // ── Seed three Polymarket venue rows (mirrors admin registration) ────────
  const conditionIds = [
    `0x${"ab".repeat(32)}`,
    `0x${"cd".repeat(32)}`,
    `0x${"ef".repeat(32)}`,
  ] as const;
  const venueEndDate = "2026-08-01T00:00:00Z";
  const venueUrl = "https://polymarket.com/event/venue-smoke";
  for (const [index, conditionId] of conditionIds.entries()) {
    const config: Record<string, unknown> = {
      question: `Venue smoke market ${index}?`,
      slug: `venue-smoke-${index}`,
      outcomes: ["Yes", "No"],
      endDate: venueEndDate,
      gamma_url: venueUrl,
      // Third row deliberately lacks conditionId — the provider must fall
      // back to the static skeleton without attempting a fetch.
      ...(index < 2 ? { conditionId } : {}),
    };
    marketsRepo.upsertExternalMarket(db, {
      market_id: conditionId,
      asset_id: "polymarket:event",
      market_kind: "event_binary",
      horizon_seconds: 3600,
      primary_oracle_id: "polymarket-gamma-oracle",
      adapter_id: "polymarket-gamma",
      market_family: "prediction-market-binary",
      scoring_kind: "multinomial_brier",
      config_json: JSON.stringify(config),
      void_band: "0",
      status: "listed",
      created_at: "2026-06-12T09:00:00Z",
    });
  }

  // ── Venue providers: live-Gamma stub + hard-offline stub ─────────────────
  let gammaFetchCalls = 0;
  const liveClient = new PolymarketGammaClient({
    baseUrl: "https://gamma.example",
    fetchFn: async (url) => {
      gammaFetchCalls += 1;
      const requested =
        new URL(url).searchParams.get("condition_ids") ?? "missing";
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () =>
          JSON.stringify([
            {
              conditionId: requested,
              slug: "venue-smoke",
              outcomes: JSON.stringify(["Yes", "No"]),
              outcomePrices: JSON.stringify(["0.62", "0.38"]),
              volume: "123456.78",
              liquidity: "9876.5",
              closed: false,
              active: true,
              endDate: venueEndDate,
            },
          ]),
      };
    },
    maxRetries: 1,
    nowMs,
  });
  const liveVenue = new PolymarketVenueSnapshotProvider({
    client: liveClient,
    nowMs,
  });

  const offlineClient = new PolymarketGammaClient({
    fetchFn: async () => {
      throw new Error("offline");
    },
    maxRetries: 1,
    nowMs,
  });
  const offlineVenue = new PolymarketVenueSnapshotProvider({
    client: offlineClient,
    nowMs,
  });

  // ── (a) The removed native catalogue is gone entirely ────────────────────
  // MIGRATION_062 deleted the unreferenced native-price rows, so the legacy
  // id no longer resolves at all — murmur ships no markets of its own.
  const ethDetail = await marketDetailSurface({
    db,
    marketId: "eth.1h",
    servedAt,
    venue: liveVenue,
  });
  assert.equal(ethDetail.status, 404);
  assert.equal(gammaFetchCalls, 0);

  // ── (b) Unknown id → 404 market_not_found envelope ───────────────────────
  const unknownDetail = await marketDetailSurface({
    db,
    marketId: "doge.1h",
    servedAt,
    venue: liveVenue,
  });
  assert.equal(unknownDetail.status, 404);
  assert.deepEqual(unknownDetail.body, {
    code: "market_not_found",
    message: "market not found",
  });
  const unknownDetailRes = new FakeMarketReadJsonResponse();
  sendMarketReadJsonResponse(unknownDetailRes, unknownDetail);
  assert.equal(unknownDetailRes.statusCode, 404);

  // ── (c)+(d)+(f) List: venue on polymarket rows, native rows unchanged ────
  const listed = await listMarketsWithVenueSurface({
    db,
    query: { assetId: null, status: "listed" },
    servedAt,
    venue: liveVenue,
  });
  assert.equal(listed.status, 200);
  const listedBody = listed.body as {
    markets: VenueMarketRow[];
    served_at: string;
  };
  // The retired legacy market must NOT appear in the public listing: nothing
  // can be minted against it any more.
  assert.equal(
    listedBody.markets.find((m) => m.market_id === "eth.1h"),
    undefined,
    "retired native-price market must not be listed",
  );

  for (const conditionId of conditionIds.slice(0, 2)) {
    const row = listedBody.markets.find((m) => m.market_id === conditionId);
    assert.ok(row, `polymarket row ${conditionId} listed`);
    assert.ok(row.venue, `venue present on ${conditionId}`);
    assert.deepEqual(row.venue.prices, [
      { outcome: "Yes", price: 0.62 },
      { outcome: "No", price: 0.38 },
    ]);
    assert.equal(row.venue.volume, 123456.78);
    assert.equal(row.venue.liquidity, 9876.5);
    assert.equal(row.venue.end_date, venueEndDate);
    assert.equal(row.venue.url, venueUrl);
    assert.equal(row.venue.fetched_at, "2026-06-12T09:30:00Z");
  }
  assert.equal(gammaFetchCalls, 2);

  // Missing conditionId → static skeleton, no fetch attempted.
  const skeletonRow = listedBody.markets.find(
    (m) => m.market_id === conditionIds[2],
  );
  assert.ok(skeletonRow?.venue);
  assert.equal(skeletonRow.venue.prices, null);
  assert.equal(skeletonRow.venue.volume, null);
  assert.equal(skeletonRow.venue.liquidity, null);
  assert.equal(skeletonRow.venue.fetched_at, null);
  assert.equal(skeletonRow.venue.end_date, venueEndDate);
  assert.equal(skeletonRow.venue.url, venueUrl);
  assert.equal(gammaFetchCalls, 2);

  // Single endpoint carries the same venue block, served from the ~60s
  // TTL cache (no additional Gamma fetch).
  const venueDetail = await marketDetailSurface({
    db,
    marketId: conditionIds[0],
    servedAt,
    venue: liveVenue,
  });
  assert.equal(venueDetail.status, 200);
  const venueDetailBody = venueDetail.body as { market: VenueMarketRow };
  assert.deepEqual(venueDetailBody.market.venue?.prices, [
    { outcome: "Yes", price: 0.62 },
    { outcome: "No", price: 0.38 },
  ]);
  assert.equal(gammaFetchCalls, 2);

  // Gamma unreachable → venue skeleton with null live fields; still 200.
  const offlineListed = await listMarketsWithVenueSurface({
    db,
    query: { assetId: null, status: "listed" },
    servedAt,
    venue: offlineVenue,
  });
  assert.equal(offlineListed.status, 200);
  const offlineRow = (offlineListed.body as { markets: VenueMarketRow[] })
    .markets.find((m) => m.market_id === conditionIds[0]);
  assert.ok(offlineRow?.venue);
  assert.equal(offlineRow.venue.prices, null);
  assert.equal(offlineRow.venue.volume, null);
  assert.equal(offlineRow.venue.liquidity, null);
  assert.equal(offlineRow.venue.fetched_at, null);
  assert.equal(offlineRow.venue.end_date, venueEndDate);
  assert.equal(offlineRow.venue.url, venueUrl);

  // ── (e) Calls feed: empty, populated (sealed-privacy), unknown ───────────
  // conditionIds[2] is a registered external market with no calls yet.
  const emptyCalls = marketCallsSurface({
    db,
    marketId: conditionIds[2],
    query: { limit: 50 },
    servedAt,
  });
  assert.equal(emptyCalls.status, 200);
  assert.deepEqual(
    (emptyCalls.body as { calls: unknown[] }).calls,
    [],
  );
  assert.equal(
    (emptyCalls.body as { served_at: string }).served_at,
    "2026-06-12T09:30:00Z",
  );

  const agentId = randomUUID();
  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "venue-caller",
    kind: "agent",
    display_name: "Venue Caller",
    bio: "Market calls fixture",
    created_at: "2026-06-12T09:00:00Z",
  });
  const resolvedCallId = randomUUID();
  const pendingCallId = randomUUID();
  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: resolvedCallId,
    agent_id: agentId,
    client_order_id: "resolved-private-order",
    horizon_seconds: 3600,
    submitted_at: "2026-06-12T09:05:00Z",
    accepted_at: "2026-06-12T09:05:00Z",
    rationale: "resolved secret rationale",
    strategy_tag: "resolved-secret-tag",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${resolvedCallId}`,
    commit_hash: "a".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: conditionIds[0],
    market_config_version: 1,
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
  });
  resolutionsRepo.setResolution(db, {
    call_id: resolvedCallId,
    t1: "2026-06-12T09:20:00Z",
    p1: "YES",
    t1_feed: "polymarket-gamma-oracle",
    signed_return: "999",
    outcome: "win",
    call_score: 1,
    resolved_at: "2026-06-12T09:20:05Z",
  });
  submissionsRepo.setStatus(db, resolvedCallId, "resolved");
  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: pendingCallId,
    agent_id: agentId,
    client_order_id: "pending-private-order",
    horizon_seconds: 3600,
    submitted_at: "2026-06-12T09:10:00Z",
    accepted_at: "2026-06-12T09:10:00Z",
    rationale: "pending secret rationale",
    strategy_tag: "pending-secret-tag",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${pendingCallId}`,
    commit_hash: "b".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: conditionIds[0],
    market_config_version: 1,
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
  });

  const marketCalls = marketCallsSurface({
    db,
    marketId: conditionIds[0],
    query: { limit: 50 },
    servedAt,
  });
  assert.equal(marketCalls.status, 200);
  const marketCallsBody = marketCalls.body as {
    market_id: string;
    calls: Array<Record<string, unknown>>;
    served_at: string;
  };
  assert.equal(marketCallsBody.market_id, conditionIds[0]);
  assert.equal(marketCallsBody.calls.length, 2);
  const [newest, older] = marketCallsBody.calls as [
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  // Newest first; the pending sealed row exposes existence + timestamps +
  // agent identity only — never direction/confidence/rationale plaintext.
  assert.equal(newest.call_id, pendingCallId);
  assert.equal(newest.status, "accepted");
  assert.equal(newest.accepted_at, "2026-06-12T09:10:00Z");
  assert.equal(newest.agent_slug, "venue-caller");
  assert.equal(newest.display_name, "Venue Caller");
  assert.equal(newest.privacy_mode, "sealed_fhenix");
  assert.equal(newest.outcome, null);
  assert.equal("side" in newest, false);
  assert.equal("confidence" in newest, false);
  assert.equal("rationale" in newest, false);
  assert.equal("strategy_tag" in newest, false);
  assert.equal(older.call_id, resolvedCallId);
  assert.equal(older.status, "resolved");
  assert.equal(older.outcome, "win");
  assert.equal(older.call_score, 1);
  assert.equal(older.resolved_at, "2026-06-12T09:20:05Z");
  // Non-native venue rows never surface signed_return.
  assert.equal("signed_return" in older, false);
  const marketCallsText = JSON.stringify(marketCallsBody);
  assert.equal(marketCallsText.includes("secret"), false);
  assert.equal(marketCallsText.includes("private-order"), false);

  const limitedCalls = marketCallsSurface({
    db,
    marketId: conditionIds[0],
    query: { limit: 1 },
    servedAt,
  });
  assert.equal(
    (limitedCalls.body as { calls: unknown[] }).calls.length,
    1,
  );

  const unknownCalls = marketCallsSurface({
    db,
    marketId: "doge.1h",
    query: { limit: 50 },
    servedAt,
  });
  assert.equal(unknownCalls.status, 404);
  assert.deepEqual(unknownCalls.body, {
    code: "market_not_found",
    message: "market not found",
  });

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("market detail surface smoke ok\n");
