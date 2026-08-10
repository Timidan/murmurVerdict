import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../../verdict/db.js";
import {
  marketClocksRepo,
  marketSeriesRepo,
  SeriesClockConflictError,
} from "../../verdict/repos/market-clocks-repo.js";
import { marketsRepo } from "../../verdict/repos/market-registry-repo.js";
import { deriveSeriesClock, type SeriesClockConfig } from "../../verdict/series-clock.js";
import { polymarketDiscoveryRepo } from "../../verdict/repos/polymarket-discovery-repo.js";
import { PolymarketDiscoveryEngine } from "./discovery.js";

process.stdout.write("murmur polymarket discovery engine smoke\n");

const CLOCK: SeriesClockConfig = {
  submissionOpenLeadSec: 300,
  commitMarginSec: 60,
  deliveryBudgetSec: 60,
  embargoSec: 600,
};
const SERIES_ID = "polymarket:binary-300s:v1";
const NOW_MS = Date.parse("2026-07-26T02:00:00.000Z");
const END_MS = Date.parse("2026-07-26T02:45:00.000Z");
const COND = "0x" + "ab".repeat(32);

/** A Gamma snapshot shaped like the 5-minute up/down series discovery accepts. */
function snapshot(conditionId: string, endMs: number) {
  const endIso = new Date(endMs).toISOString().replace(".000Z", "Z");
  return {
    conditionId,
    question: "Bitcoin Up or Down - July 26, 2:40AM-2:45AM ET",
    slug: "btc-updown-5m",
    // Gamma sends outcomes as a JSON-encoded STRING and parseOutcomeLabels
    // only accepts that shape. A real array here is silently rejected, so
    // every fresh candidate built from this fixture would be filtered out
    // before selection and any assertion about them would be vacuous.
    outcomes: '["Up", "Down"]',
    endDate: endIso,
    startDate: new Date(endMs - 86_400_000).toISOString(),
    active: true,
    closed: false,
    archived: false,
  } as never;
}

function newDb() {
  const tmp = mkdtempSync(join(tmpdir(), "disc-engine-"));
  const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
  return { db, tmp };
}

function engineWith(
  db: ReturnType<typeof openDb>,
  overrides: Record<string, unknown> = {},
  gamma?: Record<string, unknown>,
) {
  return new PolymarketDiscoveryEngine({
    db,
    // Never reached in these tests — they assert behaviour BEFORE any chain
    // write, which is the whole point.
    registrar: {
      chainId: 84532,
      contractAddress: "0x" + "11".repeat(20),
      relayerAddress: "0x" + "22".repeat(20),
      getChainId: async () => 84532,
      getOwner: async () => "0x" + "22".repeat(20),
      hasContractCode: async () => true,
      getMarket: async () => ({
        armCloseAt: 0n,
        submissionOpenAt: 0n,
        earlyAccessCutoffAt: 0n,
        submissionCloseAt: 0n,
        resolutionAt: 0n,
        publicRevealAt: 0n,
        active: false,
      }),
      getRelayerBalanceWei: async () => 10n ** 18n,
      estimateRegisterCostWei: async () => {
        throw new Error("estimateRegisterCostWei must not be reached in this test");
      },
      registerMarket: async () => {
        throw new Error("registerMarket must not be reached in this test");
      },
      waitForReceipt: async () => ({
        status: "success" as const,
        gasUsed: 1n,
        effectiveGasPriceWei: 1n,
        blockNumber: 1n,
      }),
      getReceipt: async () => null,
    },
    gamma: gamma ?? {
      fetchMarketsClosingBetween: async () => ({ snapshots: [], error: null }),
      fetchMarketByConditionId: async () => ({ snapshot: null, error: "n/a" }),
    },
    config: {
      chainId: 84532,
      tickSec: 30,
      lookaheadMin: 60,
      minLeadSec: 120,
      questionFilter: "Up or Down",
      assets: ["Bitcoin"],
      windowDurationSec: 300,
      seriesClock: CLOCK,
      maxArmedPerCall: 30,
      seriesVersion: 1,
      maxPerTick: 4,
      maxPerHour: 30,
      maxPerDay: 100,
      minBalanceWei: 0n,
      warnBalanceWei: 0n,
      maxRegisterCostWei: 10n ** 18n,
      ...overrides,
    },
    now: () => new Date(NOW_MS),
    logger: { log: () => {}, warn: () => {} },
  } as never);
}

// ── Series-config conflict fails the tick BEFORE mutating any market ────────
// A changed clock constant makes every already-registered market look like an
// on-chain mismatch. Without this preflight the tick would bulk-freeze live
// markets before the repository conflict check ever ran.
{
  const { db, tmp } = newDb();
  marketSeriesRepo.upsert(db, {
    series_id: SERIES_ID,
    venue: "polymarket",
    display_name: "BTC 5m",
    window_seconds: 300,
    clock: CLOCK,
    max_armed_per_call: 30,
    now: "2026-07-25T00:00:00.000Z",
  });

  const engine = engineWith(db, { seriesClock: { ...CLOCK, embargoSec: 99_999 } });
  await assert.rejects(
    () => engine.tick(),
    (e: unknown) => e instanceof SeriesClockConflictError,
    "a changed clock constant must fail the tick, not freeze markets",
  );

  // Nothing was touched.
  assert.equal(
    marketSeriesRepo.get(db, SERIES_ID)?.embargo_sec,
    600,
    "the stored series is untouched by a rejected tick",
  );
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── A matching config passes preflight ─────────────────────────────────────
{
  const { db, tmp } = newDb();
  marketSeriesRepo.upsert(db, {
    series_id: SERIES_ID,
    venue: "polymarket",
    display_name: "BTC 5m",
    window_seconds: 300,
    clock: CLOCK,
    max_armed_per_call: 30,
    now: "2026-07-25T00:00:00.000Z",
  });
  const res = await engineWith(db).tick();
  assert.equal(res.error, null, "an unchanged series config runs cleanly");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── An unscheduled market row is NOT treated as staged ─────────────────────
// An admin can create an unscheduled draft (drafts are inert, so that is
// allowed). Discovery must not treat the row's existence as proof of a
// schedule and promote it — a listed market with no embargo stamp disagrees
// with its own on-chain schedule and rejects every submission.
{
  const { db, tmp } = newDb();
  const asset = (db.prepare("SELECT asset_id FROM assets LIMIT 1").get() as { asset_id: string }).asset_id;
  const oracle = (db.prepare("SELECT oracle_id FROM oracles LIMIT 1").get() as { oracle_id: string }).oracle_id;
  db.prepare(
    `INSERT INTO markets (market_id, asset_id, horizon_seconds, primary_oracle_id,
       primary_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds,
       void_band, status, config_json, created_at)
     VALUES (@id, @asset, 300, @oracle, 60, 30, 60, '0', 'draft', @cfg, @now)`,
  ).run({
    id: COND,
    asset,
    oracle,
    cfg: JSON.stringify({ endDate: new Date(END_MS).toISOString() }),
    now: "2026-07-25T00:00:00.000Z",
  });

  // No clock snapshot exists for it — that is the defining property of an
  // unscheduled row.
  assert.equal(marketClocksRepo.get(db, COND), null);
  const market = marketsRepo.get(db, COND);
  assert.equal(market?.status, "draft", "an unscheduled admin row stays a draft");

  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── A clock snapshot from a DIFFERENT end date is stale, not usable ─────────
// The venue can move its end date after we froze the schedule. A stale
// snapshot must not be accepted as the market's schedule.
{
  const { db, tmp } = newDb();
  marketSeriesRepo.upsert(db, {
    series_id: SERIES_ID,
    venue: "polymarket",
    display_name: "BTC 5m",
    window_seconds: 300,
    clock: CLOCK,
    max_armed_per_call: 30,
    now: "2026-07-25T00:00:00.000Z",
  });
  const asset = (db.prepare("SELECT asset_id FROM assets LIMIT 1").get() as { asset_id: string }).asset_id;
  const oracle = (db.prepare("SELECT oracle_id FROM oracles LIMIT 1").get() as { oracle_id: string }).oracle_id;
  db.prepare(
    `INSERT INTO markets (market_id, asset_id, horizon_seconds, primary_oracle_id,
       primary_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds,
       void_band, status, config_json, created_at)
     VALUES (@id, @asset, 300, @oracle, 60, 30, 60, '0', 'draft', '{}', @now)`,
  ).run({ id: COND, asset, oracle, now: "2026-07-25T00:00:00.000Z" });

  marketClocksRepo.insert(db, {
    market_id: COND,
    series_id: SERIES_ID,
    clock: deriveSeriesClock({ endDateMs: END_MS, windowSec: 300, config: CLOCK }),
    derived_from_end_date_ms: END_MS,
    now: "2026-07-25T00:00:00.000Z",
  });

  const snap = marketClocksRepo.get(db, COND);
  assert.ok(snap);
  assert.equal(
    marketClocksRepo.hasDrifted(snap, END_MS + 60_000),
    true,
    "a moved end date is detected as drift against the frozen snapshot",
  );
  assert.equal(marketClocksRepo.hasDrifted(snap, END_MS), false);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── A rejected schedule write rolls back the market too ─────────────────────
// Schedule persistence shares the market upsert's transaction, so a series
// conflict must leave NO market row behind.
{
  const { db, tmp } = newDb();
  marketSeriesRepo.upsert(db, {
    series_id: SERIES_ID,
    venue: "polymarket",
    display_name: "BTC 5m",
    window_seconds: 300,
    clock: CLOCK,
    max_armed_per_call: 30,
    now: "2026-07-25T00:00:00.000Z",
  });
  assert.throws(
    () =>
      db.transaction(() => {
        marketSeriesRepo.upsert(db, {
          series_id: SERIES_ID,
          venue: "polymarket",
          display_name: "BTC 5m",
          window_seconds: 300,
          clock: { ...CLOCK, embargoSec: 12_345 },
          max_armed_per_call: 30,
          now: "2026-07-26T00:00:00.000Z",
        });
      })(),
    (e: unknown) => e instanceof SeriesClockConflictError,
  );
  assert.equal(
    marketSeriesRepo.get(db, SERIES_ID)?.embargo_sec,
    600,
    "rolled back — the stored constants are unchanged",
  );
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── ENGINE: a RECOVERY row past arm close is frozen, never estimated ────────
// Fresh candidates are already rejected at selection. Recovery rows (ones
// discovery already owns, replayed from the ledger) skip that filter, so they
// could reach gas estimation, revert, and abort the whole tick — and because
// estimation failures do not increment attempt_count, the same row headed the
// queue again every tick, starving every registrable candidate behind it.
//
// The registrar's estimate/register stubs THROW if reached, so reaching a
// chain write fails this test outright.
{
  const { db, tmp } = newDb();
  marketSeriesRepo.upsert(db, {
    series_id: SERIES_ID,
    venue: "polymarket",
    display_name: "BTC 5m",
    window_seconds: 300,
    clock: CLOCK,
    max_armed_per_call: 30,
    now: "2026-07-25T00:00:00.000Z",
  });

  // armCloseAt = end - 300 - 300 - 60 = end - 660s. Put "now" past it but
  // still before end, so the old minLeadSec filter would have admitted it.
  const endMs = NOW_MS + 400_000;

  // Seed a ledger row so this is a RECOVERY candidate, which bypasses the
  // fresh-selection filter.
  polymarketDiscoveryRepo.upsertDraft(db, {
    condition_id: COND,
    question: "Bitcoin Up or Down - July 26, 2:40AM-2:45AM ET",
    slug: "btc-updown-5m",
    end_date_epoch_s: Math.floor(endMs / 1000),
    now_iso: "2026-07-25T23:00:00.000Z",
  });

  const engine = engineWith(db, {}, {
    fetchMarketsClosingBetween: async () => ({ snapshots: [], error: null }),
    fetchMarketByConditionId: async () => ({ snapshot: snapshot(COND, endMs), error: null }),
  });

  const res = await engine.tick();
  assert.equal(res.error, null, "tick completes rather than aborting");
  assert.equal(
    res.registered,
    0,
    "an unregistrable candidate must never reach a chain write",
  );
  // Frozen — not merely skipped. This is the load-bearing assertion: it proves
  // the candidate WAS processed and terminally resolved, rather than filtered
  // out earlier for some unrelated reason. The registrar stubs throw if a
  // chain write is attempted, so reaching one would fail the test outright.
  assert.equal(res.frozen, 1, "the candidate is terminally frozen, not silently skipped");

  // POSITIVE CONTROL. Without this, the assertion above is one-sided: a
  // regression that disabled all chain writes would still pass it. A candidate
  // with the SAME setup but enough arm-window headroom must reach gas
  // estimation, proving the freeze above came from the arm-window guard and
  // not from something incidental.
  //
  // The Gamma stub must return a snapshot whose endDate matches this
  // candidate: recovery rows carry `snapshot: null`, so registration refetches
  // Gamma, and a null (or drifted) result bails out before estimation.
  {
    const okCond = "0x" + "cd".repeat(32);
    const okEnd = NOW_MS + 900_000; // armCloseAt = end - 660s → ~4 min headroom
    polymarketDiscoveryRepo.upsertDraft(db, {
      condition_id: okCond,
      question: "Bitcoin Up or Down - July 26, 2:40AM-2:45AM ET",
      slug: "btc-updown-5m",
      end_date_epoch_s: Math.floor(okEnd / 1000),
      now_iso: "2026-07-25T23:00:00.000Z",
    });

    let reachedEstimation = false;
    const engine2 = engineWith(db, {}, {
      fetchMarketsClosingBetween: async () => ({ snapshots: [], error: null }),
      fetchMarketByConditionId: async () => ({ snapshot: snapshot(okCond, okEnd), error: null }),
    });
    (engine2 as unknown as { registrar: Record<string, unknown> }).registrar = {
      ...(engine2 as unknown as { registrar: Record<string, unknown> }).registrar,
      estimateRegisterCostWei: async () => {
        reachedEstimation = true;
        throw new Error("stop — reaching estimation IS the assertion");
      },
    };
    await engine2.tick();
    assert.equal(
      reachedEstimation,
      true,
      "a registrable recovery candidate DOES reach gas estimation — so the frozen case above was blocked by the arm-window guard, not filtered out incidentally",
    );
  }

  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK polymarket discovery engine smoke\n");
