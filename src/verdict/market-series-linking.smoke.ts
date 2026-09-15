import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GammaMarketSnapshot } from "../markets/polymarket-gamma/transform.js";
import { openDb } from "./db.js";
import { runPolymarketMarketRegistration } from "./polymarket-market-registration.js";
import { marketsRepo } from "./repos/market-registry-repo.js";
import { venueMarketSeriesRepo } from "./repos/venue-market-series-repo.js";

// Registration stamps venue_series_id from the validated config, on both insert and conflict-update.
process.stdout.write("murmur market series linking smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "market-series-linking-"));
try {
  const db = openDb({ path: join(tmp, "verdict.db") });
  const now = () => new Date("2026-06-12T09:30:00Z");

  // ── (a.1) end-to-end: a registered market with venue series data links, and
  //         the series row is created from the same projection ───────────────
  const conditionId = `0x${"ab".repeat(32)}`;
  const first = await runPolymarketMarketRegistration({
    db,
    conditionId,
    status: "draft",
    actor: "admin_token",
    newAgentSecurityEventId: () => "00000000-0000-4000-8000-000000000901",
    gammaLookup: {
      fetchMarketByConditionId: async (id) => ({
        snapshot: seriesSnapshot(id),
        error: null,
      }),
    },
    now,
  });
  assert.equal(first.status, 201, "a series-bearing market registers");

  const series = venueMarketSeriesRepo.get(db, "polymarket:eth-up-or-down-5m");
  assert.ok(series, "the venue series row is upserted from config_json fields");
  assert.equal(series?.series_title, "ETH Up or Down 5m");
  assert.equal(series?.series_slug, "eth-up-or-down-5m");
  assert.equal(
    series?.venue_category,
    "Crypto",
    "venue_category is the first top-level event tag, not re-parsed from the question",
  );
  assert.equal(series?.source_adapter_id, "polymarket-gamma");

  const inserted = marketsRepo.get(db, conditionId);
  assert.equal(
    inserted?.venue_series_id,
    "polymarket:eth-up-or-down-5m",
    "INSERT path stamps venue_series_id — the P0 the null markets exposed",
  );

  // ── (a.2) conflict-update keeps the link: re-registering the same draft goes
  //         through ON CONFLICT and must NOT strip venue_series_id ────────────
  const second = await runPolymarketMarketRegistration({
    db,
    conditionId,
    status: "draft",
    actor: "admin_token",
    newAgentSecurityEventId: () => "00000000-0000-4000-8000-000000000902",
    gammaLookup: {
      fetchMarketByConditionId: async (id) => ({
        snapshot: seriesSnapshot(id),
        error: null,
      }),
    },
    now,
  });
  assert.equal(second.status, 201, "re-registering a draft is allowed");
  assert.equal(
    marketsRepo.get(db, conditionId)?.venue_series_id,
    "polymarket:eth-up-or-down-5m",
    "CONFLICT UPDATE path re-stamps venue_series_id",
  );

  // ── (a.3) a market whose config names NO series stays null — never
  //         fabricated (reads downstream as "no series", i.e. unsellable) ─────
  const noSeriesId = `0x${"cd".repeat(32)}`;
  const noSeries = await runPolymarketMarketRegistration({
    db,
    conditionId: noSeriesId,
    status: "draft",
    actor: "admin_token",
    newAgentSecurityEventId: () => "00000000-0000-4000-8000-000000000903",
    gammaLookup: {
      fetchMarketByConditionId: async (id) => ({
        // No `events`, so no series/category is derivable.
        snapshot: bareSnapshot(id),
        error: null,
      }),
    },
    now,
  });
  assert.equal(noSeries.status, 201);
  assert.equal(
    marketsRepo.get(db, noSeriesId)?.venue_series_id,
    null,
    "no valid series in config → venue_series_id stays null, not invented",
  );

  // ── (a.4) repo-level proof that ON CONFLICT actually WRITES the column:
  //         an existing market's venue_series_id is overwritten S1 → S2 ───────
  const s1 = venueMarketSeriesRepo.upsert(db, {
    venue: "polymarket",
    series_slug: "series-one",
    series_title: "Series One",
    venue_category: null,
    source_adapter_id: "polymarket-gamma",
    now: "2026-06-12T09:30:00Z",
  });
  const s2 = venueMarketSeriesRepo.upsert(db, {
    venue: "polymarket",
    series_slug: "series-two",
    series_title: "Series Two",
    venue_category: null,
    source_adapter_id: "polymarket-gamma",
    now: "2026-06-12T09:30:00Z",
  });
  const repoMarket = `0x${"ef".repeat(32)}`;
  marketsRepo.upsertExternalMarket(db, {
    ...repoRow(repoMarket),
    venue_series_id: s1.venue_series_id,
  });
  assert.equal(
    marketsRepo.get(db, repoMarket)?.venue_series_id,
    s1.venue_series_id,
    "INSERT with an explicit series id sets it",
  );
  marketsRepo.upsertExternalMarket(db, {
    ...repoRow(repoMarket),
    venue_series_id: s2.venue_series_id,
  });
  assert.equal(
    marketsRepo.get(db, repoMarket)?.venue_series_id,
    s2.venue_series_id,
    "CONFLICT UPDATE overwrites venue_series_id with excluded.venue_series_id",
  );

  // Omitting the field binds null; the repo coalesces undefined, which better-sqlite3 rejects.
  const omittedMarket = `0x${"12".repeat(32)}`;
  marketsRepo.upsertExternalMarket(db, repoRow(omittedMarket));
  assert.equal(
    marketsRepo.get(db, omittedMarket)?.venue_series_id,
    null,
    "an omitted venue_series_id binds null, not an error",
  );

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK market series linking smoke\n");

/** A Gamma snapshot carrying an event with a recurring series and a top-level tag. */
function seriesSnapshot(conditionId: string): GammaMarketSnapshot {
  return {
    conditionId,
    slug: "eth-up-or-down-june-12-9pm",
    outcomes: JSON.stringify(["Up", "Down"]),
    outcomePrices: JSON.stringify(["0.5", "0.5"]),
    umaResolutionStatus: "active",
    umaResolutionStatuses: JSON.stringify(["active"]),
    closed: false,
    active: true,
    archived: false,
    endDate: "2026-06-12T10:30:00Z",
    events: [
      {
        series: [{ title: "ETH Up or Down 5m", slug: "eth-up-or-down-5m" }],
        tags: [{ slug: "crypto" }],
      },
    ],
  };
}

/** A snapshot with no parent event — no series identity is derivable. */
function bareSnapshot(conditionId: string): GammaMarketSnapshot {
  return {
    conditionId,
    slug: "one-off-market",
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["0.4", "0.6"]),
    umaResolutionStatus: "active",
    umaResolutionStatuses: JSON.stringify(["active"]),
    closed: false,
    active: true,
    archived: false,
    endDate: "2026-06-12T10:30:00Z",
  };
}

/** Minimal well-formed row for the direct repo-level upsert assertions. */
function repoRow(marketId: string) {
  return {
    market_id: marketId,
    asset_id: "polymarket:event",
    market_kind: "event_binary",
    horizon_seconds: 300,
    primary_oracle_id: "polymarket-gamma-oracle",
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
    scoring_kind: "multinomial_brier",
    config_json: JSON.stringify({ conditionId: marketId }),
    void_band: "0",
    status: "draft" as const,
    created_at: "2026-06-12T09:30:00Z",
  };
}
