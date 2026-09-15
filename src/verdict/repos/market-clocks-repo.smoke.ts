import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../db.js";
import { deriveSeriesClock, type SeriesClockConfig } from "../series-clock.js";
import {
  marketClocksRepo,
  marketSeriesRepo,
  SeriesCapConflictError,
  SeriesClockConflictError,
} from "./market-clocks-repo.js";

process.stdout.write("murmur market clocks repo smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "market-clocks-"));
const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });

const clockConfig: SeriesClockConfig = {
  submissionOpenLeadSec: 300,
  commitMarginSec: 60,
  deliveryBudgetSec: 60,
  embargoSec: 600,
};
const SERIES = "polymarket:btc-updown-5m";
const NOW = "2026-07-25T00:00:00.000Z";
const endDateMs = Date.parse("2026-07-26T02:45:00.000Z");

marketSeriesRepo.upsert(db, {
  series_id: SERIES,
  venue: "polymarket",
  display_name: "BTC up/down 5m",
  window_seconds: 300,
  clock: clockConfig,
  max_armed_per_call: 30,
  now: NOW,
});

const series = marketSeriesRepo.get(db, SERIES);
assert.ok(series, "series row round-trips");
assert.equal(series.submission_open_lead_sec, 300);
assert.equal(series.embargo_sec, 600);
assert.equal(series.status, "active");

// The display name is the only mutable field.
marketSeriesRepo.upsert(db, {
  series_id: SERIES,
  venue: "polymarket",
  display_name: "BTC up/down 5m (renamed)",
  window_seconds: 300,
  clock: clockConfig,
  max_armed_per_call: 30,
  now: "2026-07-25T01:00:00.000Z",
});
const reread = marketSeriesRepo.get(db, SERIES);
assert.equal(reread?.display_name, "BTC up/down 5m (renamed)", "display name updates");

// The cohort cap fails closed too: eligibility reads the current series row.
assert.throws(
  () =>
    marketSeriesRepo.upsert(db, {
      series_id: SERIES,
      venue: "polymarket",
      display_name: "BTC up/down 5m",
      window_seconds: 300,
      clock: clockConfig,
      max_armed_per_call: 40,
      now: "2026-07-25T02:00:00.000Z",
    }),
  (err) => err instanceof SeriesCapConflictError,
  "changing a series' cohort cap requires a version bump",
);
assert.equal(
  marketSeriesRepo.get(db, SERIES)?.max_armed_per_call,
  30,
  "the stored cap is untouched by the rejected upsert",
);

// Changing a clock constant under an existing series id must throw, not be ignored.
assert.throws(
  () =>
    marketSeriesRepo.upsert(db, {
      series_id: SERIES,
      venue: "polymarket",
      display_name: "BTC up/down 5m",
      window_seconds: 300,
      clock: { ...clockConfig, embargoSec: 99_999 },
      max_armed_per_call: 30,
      now: "2026-07-25T02:00:00.000Z",
    }),
  (e: unknown) => e instanceof SeriesClockConflictError,
  "changing embargoSec under an existing series id must fail closed",
);
assert.throws(
  () =>
    marketSeriesRepo.upsert(db, {
      series_id: SERIES,
      venue: "polymarket",
      display_name: "BTC up/down 5m",
      window_seconds: 900,
      clock: clockConfig,
      max_armed_per_call: 30,
      now: "2026-07-25T02:00:00.000Z",
    }),
  (e: unknown) => e instanceof SeriesClockConflictError,
  "changing the window length under an existing series id must fail closed",
);
assert.equal(
  marketSeriesRepo.get(db, SERIES)?.embargo_sec,
  600,
  "a rejected upsert leaves the stored constants untouched",
);

// market_clocks.market_id is an FK to markets; seed minimal markets from the base schema's assets and oracles.
const seededAsset = (db.prepare("SELECT asset_id FROM assets LIMIT 1").get() as { asset_id: string }).asset_id;
const seededOracle = (db.prepare("SELECT oracle_id FROM oracles LIMIT 1").get() as { oracle_id: string }).oracle_id;

function seedMarket(marketId: string): void {
  db.prepare(
    `INSERT INTO markets (
       market_id, asset_id, horizon_seconds, primary_oracle_id,
       primary_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds,
       void_band, created_at)
     VALUES (@id, @asset, 300, @oracle, 60, 30, 60, '0', @now)`,
  ).run({ id: marketId, asset: seededAsset, oracle: seededOracle, now: NOW });
}
seedMarket("0xmarket1");
seedMarket("0xbad");

const clock = deriveSeriesClock({ endDateMs, windowSec: 300, config: clockConfig });
marketClocksRepo.insert(db, {
  market_id: "0xmarket1",
  series_id: SERIES,
  clock,
  derived_from_end_date_ms: endDateMs,
  now: NOW,
});

const row = marketClocksRepo.get(db, "0xmarket1");
assert.ok(row, "clock snapshot round-trips");
assert.equal(row.public_reveal_at_ms, clock.publicRevealAtMs);
assert.equal(row.resolution_at_ms, endDateMs);
assert.ok(
  row.public_reveal_at_ms > row.resolution_at_ms,
  "reveal is embargoed strictly past resolution",
);
assert.equal(row.drift_detected_at, null);

// The snapshot is insert-only. A second write would be a retime.
assert.throws(
  () =>
    marketClocksRepo.insert(db, {
      market_id: "0xmarket1",
      series_id: SERIES,
      clock,
      derived_from_end_date_ms: endDateMs + 60_000,
      now: NOW,
    }),
  "re-writing a clock snapshot must throw, never retime",
);

// Drift detection compares against the derived-from end date, not the schedule.
assert.equal(marketClocksRepo.hasDrifted(row, endDateMs), false);
assert.equal(marketClocksRepo.hasDrifted(row, endDateMs + 60_000), true);

assert.equal(marketClocksRepo.flagDrift(db, "0xmarket1", NOW), true);
assert.equal(
  marketClocksRepo.flagDrift(db, "0xmarket1", NOW),
  false,
  "flagging is idempotent — the first detection wins",
);
const flagged = marketClocksRepo.get(db, "0xmarket1");
assert.equal(flagged?.drift_detected_at, NOW);
// Flagging records drift; it must never move the schedule.
assert.equal(flagged?.public_reveal_at_ms, clock.publicRevealAtMs);
assert.equal(flagged?.submission_close_at_ms, clock.submissionCloseAtMs);

// SQL CHECK constraints must reject an inverted snapshot outright.
assert.throws(
  () =>
    marketClocksRepo.insert(db, {
      market_id: "0xbad",
      series_id: SERIES,
      clock: { ...clock, publicRevealAtMs: clock.marketResolutionAtMs },
      derived_from_end_date_ms: endDateMs,
      now: NOW,
    }),
  "reveal must be strictly after resolution at the DB layer too",
);

// ── The acceptance-equality invariant ──────────────────────────────────────
// Acceptance needs exact equality with the on-chain publicRevealAt (endDate + embargo). The
// adapter defaults embargoSec to 0, so registration must stamp it into config_json.
{
  const { expectedRevealOpenMsForMarket, marketResolutionMsForMarket } = await import(
    "../market-adapter-config.js"
  );
  const marketRow = {
    adapter_id: "polymarket-gamma",
    market_id: "0xmarket1",
    market_config_version: 1,
    horizon_seconds: 300,
    config_json: JSON.stringify({
      endDate: new Date(endDateMs).toISOString(),
      embargoSec: clockConfig.embargoSec,
    }),
  };

  assert.equal(
    expectedRevealOpenMsForMarket(marketRow as never, endDateMs - 600_000),
    clock.publicRevealAtMs,
    "stamped config must reproduce the on-chain publicRevealAt exactly",
  );

  // ...and the resolution horizon must NOT pick up the embargo, or every
  // commitment would claim the venue settles at murmur's reveal deadline.
  assert.equal(
    marketResolutionMsForMarket(marketRow as never, endDateMs - 600_000),
    endDateMs,
    "resolution horizon is the venue end date, embargo excluded",
  );

  // The failure mode the stamp exists to prevent.
  const unstamped = {
    ...marketRow,
    config_json: JSON.stringify({ endDate: new Date(endDateMs).toISOString() }),
  };
  assert.notEqual(
    expectedRevealOpenMsForMarket(unstamped as never, endDateMs - 600_000),
    clock.publicRevealAtMs,
    "an unstamped market silently disagrees with the chain — this is the bug",
  );
}

db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("OK market clocks repo smoke\n");
