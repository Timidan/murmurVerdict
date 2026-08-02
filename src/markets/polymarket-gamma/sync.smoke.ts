import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { marketsRepo, openDb } from "../../verdict/db.js";
import { PolymarketGammaClient } from "./client.js";
import { PolymarketClobClient } from "./clob-client.js";
import { runPolymarketSyncTick, type SyncStateRow } from "./sync.js";

process.stdout.write("murmur Polymarket sync ticker smoke\n");

const conditionResolved = `0x${"a1".repeat(32)}`;
const conditionPending = `0x${"b2".repeat(32)}`;
const conditionVanished = `0x${"c3".repeat(32)}`;
const endDate = "2026-07-18T21:50:00Z";
let nowMs = Date.parse("2026-07-18T22:00:00Z");

const tmp = mkdtempSync(join(tmpdir(), "murmur-polymarket-sync-smoke-"));
try {
  const db = openDb({ path: join(tmp, "test.db") });
  for (const conditionId of [conditionResolved, conditionPending, conditionVanished]) {
    marketsRepo.upsertExternalMarket(db, {
      market_id: conditionId,
      asset_id: "polymarket:event",
      market_kind: "event_binary",
      horizon_seconds: 300,
      primary_oracle_id: "polymarket-gamma-oracle",
      adapter_id: "polymarket-gamma",
      market_family: "prediction-market-binary",
      scoring_kind: "multinomial_brier",
      config_json: JSON.stringify({
        conditionId,
        slug: `sync-smoke-${conditionId.slice(0, 10)}`,
        outcomes: ["Up", "Down"],
        clobTokenIds: { up: "111", down: "222" },
        endDate,
        gamma_url: `https://polymarket.com/event/sync-smoke`,
      }),
      void_band: "0",
      status: "listed",
      created_at: "2026-07-18T21:40:00Z",
    });
  }

  // Gamma has dropped ALL three micro-markets post-close: `200 []` → http_404.
  const gammaClient = new PolymarketGammaClient({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify([]),
    }),
    maxRetries: 1,
    nowMs: () => nowMs,
    sleepMs: async () => undefined,
  });
  // CLOB still serves two of them; the third is gone everywhere.
  const clobClient = new PolymarketClobClient({
    fetchFn: async (url) => {
      if (url.endsWith(conditionResolved)) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () =>
            JSON.stringify({
              condition_id: conditionResolved,
              closed: true,
              archived: false,
              accepting_orders: false,
              is_50_50_outcome: false,
              tokens: [
                { token_id: "111", outcome: "Up", price: 0, winner: false },
                { token_id: "222", outcome: "Down", price: 1, winner: true },
              ],
            }),
        };
      }
      if (url.endsWith(conditionPending)) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () =>
            JSON.stringify({
              condition_id: conditionPending,
              closed: true,
              archived: false,
              accepting_orders: false,
              is_50_50_outcome: false,
              tokens: [
                { token_id: "111", outcome: "Up", price: 0.5, winner: false },
                { token_id: "222", outcome: "Down", price: 0.5, winner: false },
              ],
            }),
        };
      }
      return {
        ok: false,
        status: 404,
        headers: { get: () => "application/json" },
        text: async () => "",
      };
    },
    maxRetries: 1,
    nowMs: () => nowMs,
    sleepMs: async () => undefined,
  });

  const alerts: Array<{ code: string; market_id: string }> = [];
  const tickOpts = {
    db,
    client: gammaClient,
    clobClient,
    nowMs: () => nowMs,
    onAlert: (alert: { code: string; market_id: string }) => {
      alerts.push({ code: alert.code, market_id: alert.market_id });
    },
  };

  const loadState = (market_id: string): SyncStateRow =>
    db
      .prepare("SELECT * FROM external_market_sync_state WHERE market_id = ?")
      .get(market_id) as SyncStateRow;

  const first = await runPolymarketSyncTick(tickOpts);
  assert.equal(first.scanned, 3);
  assert.equal(first.polled, 3);

  // CLOB confirms resolution → status resolved, failures reset, no incident.
  const resolvedRow = loadState(conditionResolved);
  assert.equal(resolvedRow.last_observed_status, "resolved");
  assert.equal(resolvedRow.consecutive_failures, 0);
  assert.equal(resolvedRow.last_error, null);

  // CLOB present but UMA not sealed → pending, not a disappearance incident.
  const pendingRow = loadState(conditionPending);
  assert.equal(pendingRow.last_observed_status, "pending");
  assert.equal(pendingRow.consecutive_failures, 0);
  assert.equal(pendingRow.last_error, null);

  // CLOB unavailable too → the existing 404 accounting is preserved.
  const vanishedRow = loadState(conditionVanished);
  assert.equal(vanishedRow.last_observed_status, "404");
  assert.equal(vanishedRow.consecutive_failures, 1);
  assert.equal(vanishedRow.last_error, "http_404");
  assert.deepEqual(alerts, []);

  // Push the vanished market to the MARKET_DISAPPEARED threshold and verify
  // the alert still fires — CLOB fallback must not swallow real incidents.
  db.prepare(
    `UPDATE external_market_sync_state
        SET consecutive_failures = 23, next_poll_at = NULL
      WHERE market_id = ?`,
  ).run(conditionVanished);
  nowMs += 6 * 60 * 1000; // past both Gamma's 5-min and CLOB's 45s negative TTLs

  const second = await runPolymarketSyncTick(tickOpts);
  assert.equal(second.alerts, 1);
  assert.deepEqual(alerts, [
    { code: "MARKET_DISAPPEARED", market_id: conditionVanished },
  ]);
  const vanishedAfter = loadState(conditionVanished);
  assert.equal(vanishedAfter.consecutive_failures, 24);
  assert.ok(vanishedAfter.alerted_disappeared_at !== null);
  // The resolved market is frozen out of the tick entirely.
  assert.equal(loadState(conditionResolved).last_observed_status, "resolved");

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("Polymarket sync ticker smoke ok\n");
