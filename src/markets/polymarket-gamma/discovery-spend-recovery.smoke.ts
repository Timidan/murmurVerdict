import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../../verdict/db.js";
import { marketSeriesRepo } from "../../verdict/repos/market-clocks-repo.js";
import { marketsRepo } from "../../verdict/repos/market-registry-repo.js";
import { polymarketDiscoveryRepo } from "../../verdict/repos/polymarket-discovery-repo.js";
import { deriveSeriesClock, type SeriesClockConfig } from "../../verdict/series-clock.js";
import { PolymarketDiscoveryEngine } from "./discovery.js";

// Discovery's hourly/daily spend caps count `registered_onchain_at`, and the
// per-tick budget is computed ONCE before candidates are processed. A recovery
// that stamps a previously-unrecorded registration therefore has to be charged
// to that same budget, or the pre-recovery allowance stays fully available and
// later candidates in the same tick broadcast past the cap.
//
// This regression has two halves and both are pinned here:
//   1. the stamp itself must happen exactly once, from any branch that reaches
//      it (repo-level, below);
//   2. the tick budget must actually shrink when it does (engine-level).
process.stdout.write("murmur polymarket discovery spend-recovery smoke\n");

const CLOCK: SeriesClockConfig = {
  submissionOpenLeadSec: 300,
  commitMarginSec: 60,
  deliveryBudgetSec: 60,
  embargoSec: 600,
};
const SERIES_ID = "polymarket:binary-300s:v1";
const NOW_MS = Date.parse("2026-07-26T02:00:00.000Z");
const END_MS = Date.parse("2026-07-26T02:45:00.000Z");
/** The next window in the series, so FRESH is a distinct candidate. */
const FRESH_END_MS = END_MS + 300_000;
const RECOVERED = "0x" + "ab".repeat(32);
const FRESH = "0x" + "cd".repeat(32);

function newDb() {
  const tmp = mkdtempSync(join(tmpdir(), "disc-spend-"));
  const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
  return { db, tmp };
}

function snapshot(conditionId: string, endMs: number) {
  // The window length is parsed out of the question text, so it has to agree
  // with endDate.
  const startLabel = hhmm(endMs - 300_000);
  const endLabel = hhmm(endMs);
  return {
    conditionId,
    question: `Bitcoin Up or Down - July 26, ${startLabel}-${endLabel} ET`,
    slug: "btc-updown-5m",
    // Gamma sends outcomes as a JSON-encoded STRING, and
    // parseOutcomeLabels only accepts that shape — a real array is
    // rejected, and the candidate silently never gets selected.
    outcomes: '["Up", "Down"]',
    endDate: new Date(endMs).toISOString().replace(".000Z", "Z"),
    startDate: new Date(endMs - 86_400_000).toISOString(),
    active: true,
    closed: false,
    archived: false,
  } as never;
}

/** 12-hour clock label in the shape Polymarket puts in the question text. */
function hhmm(ms: number): string {
  const d = new Date(ms);
  const h24 = d.getUTCHours();
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(d.getUTCMinutes()).padStart(2, "0")}${suffix}`;
}

function draftRow(conditionId: string) {
  return {
    condition_id: conditionId,
    question: "Bitcoin Up or Down - July 26, 2:40AM-2:45AM ET",
    slug: "btc-updown-5m",
    end_date_epoch_s: Math.floor(END_MS / 1000),
    now_iso: "2026-07-26T01:00:00.000Z",
  };
}

function onchainScheduleFor(endMs: number) {
  const clock = deriveSeriesClock({
    endDateMs: endMs,
    windowSec: 300,
    config: CLOCK,
  });
  return {
    armCloseAt: BigInt(Math.floor(clock.armCloseAtMs / 1000)),
    submissionOpenAt: BigInt(Math.floor(clock.submissionOpenAtMs / 1000)),
    earlyAccessCutoffAt: BigInt(Math.floor(clock.earlyAccessCutoffAtMs / 1000)),
    submissionCloseAt: BigInt(Math.floor(clock.submissionCloseAtMs / 1000)),
    resolutionAt: BigInt(Math.floor(clock.marketResolutionAtMs / 1000)),
    publicRevealAt: BigInt(Math.floor(clock.publicRevealAtMs / 1000)),
    active: true,
  };
}

const UNREGISTERED = {
  armCloseAt: 0n,
  submissionOpenAt: 0n,
  earlyAccessCutoffAt: 0n,
  submissionCloseAt: 0n,
  resolutionAt: 0n,
  publicRevealAt: 0n,
  active: false,
};

// ── 1. The stamp is exactly-once, and narrower than markConfirmed ───────────
{
  const { db, tmp } = newDb();
  try {
    polymarketDiscoveryRepo.upsertDraft(db, draftRow(RECOVERED));

    const first = polymarketDiscoveryRepo.stampRegisteredOnchain(db, {
      condition_id: RECOVERED,
      tx_hash: "0xfeed",
      gas_used: "21000",
      effective_gas_price_wei: "7",
      now_iso: "2026-07-26T02:00:00.000Z",
    });
    assert.equal(first, true, "the first stamp reports that it did the work");

    const second = polymarketDiscoveryRepo.stampRegisteredOnchain(db, {
      condition_id: RECOVERED,
      tx_hash: "0xbeef",
      gas_used: null,
      effective_gas_price_wei: null,
      now_iso: "2026-07-26T02:05:00.000Z",
    });
    assert.equal(
      second,
      false,
      "a second stamp must report false so the spend caps cannot double-count",
    );

    const row = polymarketDiscoveryRepo.get(db, RECOVERED);
    assert.equal(row?.registered_onchain_at, "2026-07-26T02:00:00.000Z");
    assert.equal(row?.tx_hash, "0xfeed", "the original tx hash is not overwritten");
    assert.equal(
      row?.gas_used,
      "21000",
      "gas telemetry survives a later stamp attempt (markConfirmed used to null it)",
    );

    // A `listed` row keeps its status: back-filling a stamp must not demote a
    // live market to `confirmed` and make its coverage look understated.
    polymarketDiscoveryRepo.upsertDraft(db, draftRow(FRESH));
    polymarketDiscoveryRepo.markListed(db, {
      condition_id: FRESH,
      now_iso: "2026-07-26T01:30:00.000Z",
    });
    polymarketDiscoveryRepo.stampRegisteredOnchain(db, {
      condition_id: FRESH,
      tx_hash: null,
      gas_used: null,
      effective_gas_price_wei: null,
      now_iso: "2026-07-26T02:00:00.000Z",
    });
    assert.equal(polymarketDiscoveryRepo.get(db, FRESH)?.status, "listed");

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 2. A recovered registration consumes this tick's budget ─────────────────
// One hourly slot remains. The tick sees a recoverable candidate (already on
// chain, never stamped) and a fresh one. Stamping the first consumes the slot,
// so the second must NOT be broadcast.
{
  const { db, tmp } = newDb();
  try {
    marketSeriesRepo.upsert(db, {
      series_id: SERIES_ID,
      venue: "polymarket",
      display_name: "BTC 5m",
      window_seconds: 300,
      clock: CLOCK,
      max_armed_per_call: 30,
      now: "2026-07-25T00:00:00.000Z",
    });
    polymarketDiscoveryRepo.upsertDraft(db, draftRow(RECOVERED));

    const registerCalls: string[] = [];
    const exact = onchainScheduleFor(END_MS);
    const engine = new PolymarketDiscoveryEngine({
      db,
      registrar: {
        chainId: 84532,
        contractAddress: "0x" + "11".repeat(20),
        relayerAddress: "0x" + "22".repeat(20),
        getChainId: async () => 84532,
        getOwner: async () => "0x" + "22".repeat(20),
        hasContractCode: async () => true,
        // RECOVERED is already registered with the exact expected schedule;
        // FRESH is not registered at all.
        getMarket: async (id: string) =>
          id.toLowerCase() === RECOVERED.toLowerCase() ? exact : UNREGISTERED,
        getRelayerBalanceWei: async () => 10n ** 18n,
        estimateRegisterCostWei: async () => 1n,
        registerMarket: async (id: string) => {
          registerCalls.push(id.toLowerCase());
          return "0x" + "99".repeat(32);
        },
        waitForReceipt: async () => ({
          status: "success" as const,
          gasUsed: 1n,
          effectiveGasPriceWei: 1n,
          blockNumber: 1n,
        }),
        getReceipt: async () => null,
      },
      gamma: {
        fetchMarketsClosingBetween: async () => ({
          snapshots: [snapshot(RECOVERED, END_MS), snapshot(FRESH, FRESH_END_MS)],
          error: null,
        }),
        fetchMarketByConditionId: async (id: string) => ({
          snapshot: snapshot(
            id,
            id.toLowerCase() === FRESH.toLowerCase() ? FRESH_END_MS : END_MS,
          ),
          error: null,
        }),
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
        // ONE slot left this hour. The recovery must take it.
        maxPerHour: 1,
        maxPerDay: 100,
        minBalanceWei: 0n,
        warnBalanceWei: 0n,
        maxRegisterCostWei: 10n ** 18n,
      },
      now: () => new Date(NOW_MS),
      logger: { log: () => {}, warn: () => {} },
    } as never);

    await engine.tick();

    assert.equal(
      polymarketDiscoveryRepo.get(db, RECOVERED)?.registered_onchain_at !== null,
      true,
      "the on-chain-but-unstamped registration is recovered",
    );
    assert.deepEqual(
      registerCalls,
      [],
      "the recovered registration consumed the hourly slot, so no further " +
        "market may be broadcast in this tick",
    );

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 3. An operator halt survives a full discovery tick ─────────────────────
// The halt marker used to live on discovery's ledger and be set with an
// UPDATE, so a market discovery had never seen was never actually marked. Even
// once it moved to `markets`, discovery reached shared registration — which
// cleared the halt — and the receipt path then listed the market. This drives
// a whole tick against a halted market with NO ledger row and NO clock
// snapshot: the exact shape that got through.
{
  const { db, tmp } = newDb();
  try {
    marketSeriesRepo.upsert(db, {
      series_id: SERIES_ID,
      venue: "polymarket",
      display_name: "BTC 5m",
      window_seconds: 300,
      clock: CLOCK,
      max_armed_per_call: 30,
      now: "2026-07-25T00:00:00.000Z",
    });

    const asset = db.prepare("SELECT asset_id FROM assets LIMIT 1").get() as {
      asset_id: string;
    };
    const oracle = db.prepare("SELECT oracle_id FROM oracles LIMIT 1").get() as {
      oracle_id: string;
    };
    db.prepare(
      `INSERT INTO markets (
         market_id, asset_id, market_kind, horizon_seconds, primary_oracle_id,
         primary_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds,
         void_band, scoring_kind, status, created_at, config_json
       ) VALUES (?, ?, 'event_binary', 3600, ?, 60, 30, 60, '0',
         'multinomial_brier', 'listed', '2026-07-01T00:00:00Z', '{}')`,
    ).run(RECOVERED, asset.asset_id, oracle.oracle_id);
    marketsRepo.haltByOperator(db, RECOVERED, "frozen", "2026-07-26T01:30:00.000Z");

    const registerCalls: string[] = [];
    const engine = new PolymarketDiscoveryEngine({
      db,
      registrar: {
        chainId: 84532,
        contractAddress: "0x" + "11".repeat(20),
        relayerAddress: "0x" + "22".repeat(20),
        getChainId: async () => 84532,
        getOwner: async () => "0x" + "22".repeat(20),
        hasContractCode: async () => true,
        getMarket: async () => UNREGISTERED,
        getRelayerBalanceWei: async () => 10n ** 18n,
        estimateRegisterCostWei: async () => 1n,
        registerMarket: async (id: string) => {
          registerCalls.push(id.toLowerCase());
          return "0x" + "99".repeat(32);
        },
        waitForReceipt: async () => ({
          status: "success" as const,
          gasUsed: 1n,
          effectiveGasPriceWei: 1n,
          blockNumber: 1n,
        }),
        getReceipt: async () => null,
      },
      gamma: {
        fetchMarketsClosingBetween: async () => ({
          snapshots: [snapshot(RECOVERED, END_MS)],
          error: null,
        }),
        fetchMarketByConditionId: async (id: string) => ({
          snapshot: snapshot(id, END_MS),
          error: null,
        }),
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
        maxPerHour: 10,
        maxPerDay: 100,
        minBalanceWei: 0n,
        warnBalanceWei: 0n,
        maxRegisterCostWei: 10n ** 18n,
      },
      now: () => new Date(NOW_MS),
      logger: { log: () => {}, warn: () => {} },
    } as never);

    await engine.tick();

    assert.equal(
      marketsRepo.isOperatorHalted(db, RECOVERED),
      true,
      "discovery must not clear an operator halt",
    );
    assert.equal(
      marketsRepo.get(db, RECOVERED)?.status,
      "frozen",
      "the halted market is not relisted",
    );
    assert.deepEqual(
      registerCalls,
      [],
      "no gas is spent registering a market an operator pulled",
    );

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.stdout.write("polymarket discovery spend-recovery smoke ok\n");
