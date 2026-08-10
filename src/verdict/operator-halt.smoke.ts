import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import { marketsRepo } from "./repos/market-registry-repo.js";
import { polymarketDiscoveryRepo } from "./repos/polymarket-discovery-repo.js";

// An operator halt must survive discovery.
//
// The first version of this marker lived on `polymarket_discovery_state` and
// was set with an UPDATE. That silently marked NOTHING for a market discovery
// had never seen — a manually registered one has no ledger row — so the halt
// evaporated and the next tick relisted the market. It now lives on `markets`,
// the row the admin path actually operates on.
process.stdout.write("murmur operator halt smoke\n");

const MARKET = `0x${"ab".repeat(32)}`;
const UNSEEN = `0x${"cd".repeat(32)}`;

const tmp = mkdtempSync(join(tmpdir(), "operator-halt-"));
try {
  const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });

  // openDb seeds the registry, so reuse whatever asset/oracle it created
  // rather than inventing a second one that collides on the primary key.
  const asset = db.prepare("SELECT asset_id FROM assets LIMIT 1").get() as {
    asset_id: string;
  };
  const oracle = db.prepare("SELECT oracle_id FROM oracles LIMIT 1").get() as {
    oracle_id: string;
  };

  const insertMarket = (id: string) =>
    db
      .prepare(
        `INSERT INTO markets (
           market_id, asset_id, market_kind, horizon_seconds, primary_oracle_id,
           primary_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds,
           void_band, scoring_kind, status, created_at
           , config_json
         ) VALUES (?, ?, 'event_binary', 3600, ?, 60, 30, 60, '0',
           'multinomial_brier', 'listed', '2026-07-01T00:00:00Z', '{}')`,
      )
      .run(id, asset.asset_id, oracle.oracle_id);

  insertMarket(MARKET);
  insertMarket(UNSEEN);
  // Only MARKET has ever been seen by discovery.
  polymarketDiscoveryRepo.upsertDraft(db, {
    condition_id: MARKET,
    question: "Bitcoin Up or Down",
    slug: "btc",
    end_date_epoch_s: 1_800_000_000,
    now_iso: "2026-07-26T01:00:00.000Z",
  });

  assert.equal(marketsRepo.isOperatorHalted(db, MARKET), false);
  assert.equal(marketsRepo.isOperatorHalted(db, UNSEEN), false);

  // Halting sets the status and the marker in one write.
  marketsRepo.haltByOperator(db, MARKET, "frozen", "2026-07-26T02:00:00.000Z");
  assert.equal(marketsRepo.get(db, MARKET)?.status, "frozen");
  assert.equal(marketsRepo.isOperatorHalted(db, MARKET), true);

  // THE REGRESSION: a market discovery has never seen must halt just the same.
  marketsRepo.haltByOperator(db, UNSEEN, "retired", "2026-07-26T02:00:00.000Z");
  assert.equal(
    marketsRepo.isOperatorHalted(db, UNSEEN),
    true,
    "halting a market with no discovery ledger row must still take effect",
  );
  assert.equal(marketsRepo.get(db, UNSEEN)?.status, "retired");

  // A halted DRAFT is still halted. "Draft" means an operator took it out of
  // service, not "discovery may resume it".
  marketsRepo.haltByOperator(db, MARKET, "draft", "2026-07-26T03:00:00.000Z");
  assert.equal(marketsRepo.isOperatorHalted(db, MARKET), true);
  assert.equal(marketsRepo.get(db, MARKET)?.status, "draft");

  // Only a full re-registration lifts it.
  marketsRepo.clearOperatorHalt(db, MARKET);
  assert.equal(marketsRepo.isOperatorHalted(db, MARKET), false);
  assert.equal(
    marketsRepo.isOperatorHalted(db, UNSEEN),
    true,
    "clearing one market's halt does not touch another's",
  );

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK operator halt smoke\n");
