import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { openDb } from "./db.js";
import { LATEST_DB_MIGRATION_VERSION } from "./db-migrations.js";
import { agentMarketRegistrationsRepo } from "./repos/agent-market-registrations-repo.js";
import { agentProviderTermsRepo } from "./repos/agent-provider-terms-repo.js";
import { venueMarketSeriesRepo } from "./repos/venue-market-series-repo.js";

// ─── Migration 075: the venue's durable series identity ────────────────────
//
// Instances are ephemeral, so 075 moves the recurring series into
// venue_market_series, links instances, backfills registrations from
// submissions, and rekeys provider terms to (agent, series).
process.stdout.write("murmur venue market series smoke\n");

type Db = Database.Database;

const NOW = "2026-08-20T00:00:00Z";

// The pre-075 shape of agent_provider_terms (migration 069): keyed by agent
// alone. The rewind restores it so reopening replays 075 as a real upgrade.
const OLD_AGENT_PROVIDER_TERMS = `
  CREATE TABLE agent_provider_terms (
    agent_id              TEXT PRIMARY KEY REFERENCES agents(agent_id),
    price_atoms           TEXT NOT NULL CHECK (
                            price_atoms GLOB '[0-9]*' AND CAST(price_atoms AS INTEGER) > 0
                          ),
    currency              TEXT NOT NULL,
    pricing_version       TEXT NOT NULL,
    max_subscribers_per_call INTEGER CHECK (
                            max_subscribers_per_call IS NULL
                            OR max_subscribers_per_call > 0
                          ),
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  );
`;

/**
 * Strip every migration-075 object from an already-migrated database and stamp
 * it back to 74, so the next openDb replays 075 as a genuine v74 → v75 upgrade.
 * Foreign keys are toggled off for the surgery only — reopening enforces them.
 */
function rewindToV74(db: Db): void {
  db.pragma("foreign_keys = OFF");
  db.exec("DROP TABLE agent_provider_terms;");
  db.exec("DROP TABLE agent_market_registrations;");
  db.exec("DROP INDEX IF EXISTS idx_markets_venue_series;");
  db.exec("ALTER TABLE markets DROP COLUMN venue_series_id;");
  db.exec("DROP TABLE venue_market_series;");
  db.exec(OLD_AGENT_PROVIDER_TERMS);
  db.prepare("UPDATE schema_meta SET value='74' WHERE key='schema_version'").run();
  db.pragma("foreign_keys = ON");
}

const scalar = <T>(db: Db, sql: string, ...args: unknown[]): T =>
  db.prepare(sql).get(...args) as T;

// ── 1. v74 → v75 upgrade: series creation, linking, and the CLOCK left alone ─
{
  const dir = mkdtempSync(join(tmpdir(), "vms-upgrade-"));
  const path = join(dir, "verdict.db");

  const setup = openDb({ path });
  const assetId = scalar<{ asset_id: string }>(
    setup,
    "SELECT asset_id FROM assets LIMIT 1",
  ).asset_id;
  const oracleId = scalar<{ oracle_id: string }>(
    setup,
    "SELECT oracle_id FROM oracles LIMIT 1",
  ).oracle_id;

  rewindToV74(setup);

  // A sentinel row in the UNRELATED market_series (064) CLOCK table. 075 must
  // not read or write it — same word, different concept.
  setup
    .prepare(
      `INSERT INTO market_series (series_id, venue, display_name, window_seconds,
         submission_open_lead_sec, commit_margin_sec, delivery_budget_sec,
         embargo_sec, max_armed_per_call, created_at, updated_at)
       VALUES ('polymarket:binary-300s:v1','polymarket','300s clock',300,
         120,10,60,30,25,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    )
    .run();
  const clockBefore = setup
    .prepare("SELECT * FROM market_series WHERE series_id='polymarket:binary-300s:v1'")
    .get();

  // Fixture markets, as they would sit at v74: config carries the series in
  // JSON, the column does not exist yet.
  const insMarket = setup.prepare(
    `INSERT INTO markets (market_id, asset_id, horizon_seconds, primary_oracle_id,
       primary_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds,
       void_band, scoring_kind, status, created_at, config_json, adapter_id)
     VALUES (@market_id, @asset_id, 300, @oracle_id, 60, 0, 0, '0',
       'brier_direction', 'listed', '2026-08-01T00:00:00Z', @config_json,
       'polymarket-gamma')`,
  );
  const seriesFix: ReadonlyArray<readonly [string, string]> = [
    ["btc-up-or-down-5m", "BTC Up or Down 5m"],
    ["eth-up-or-down-5m", "ETH Up or Down 5m"],
    ["sol-up-or-down-5m", "SOL Up or Down 5m"],
    ["xrp-up-or-down-5m", "XRP Up or Down 5m"],
    ["doge-up-or-down-5m", "DOGE Up or Down 5m"],
  ];
  const marketIds: Record<string, string> = {};
  for (const [slug, title] of seriesFix) {
    const id = `mkt-${slug}-${randomUUID().slice(0, 8)}`;
    marketIds[slug] = id;
    insMarket.run({
      market_id: id,
      asset_id: assetId,
      oracle_id: oracleId,
      config_json: JSON.stringify({ series_slug: slug, series_title: title }),
    });
  }
  // A second instance of the btc series → the series must de-duplicate to one.
  const btc2 = `mkt-btc2-${randomUUID().slice(0, 8)}`;
  insMarket.run({
    market_id: btc2,
    asset_id: assetId,
    oracle_id: oracleId,
    config_json: JSON.stringify({
      series_slug: "btc-up-or-down-5m",
      series_title: "BTC Up or Down 5m",
    }),
  });
  // A slug with NO title is not a complete series and must NOT create a row.
  const orphan = `mkt-orphan-${randomUUID().slice(0, 8)}`;
  insMarket.run({
    market_id: orphan,
    asset_id: assetId,
    oracle_id: oracleId,
    config_json: JSON.stringify({ series_slug: "orphan-5m" }),
  });
  // A market naming no series at all.
  const bare = `mkt-bare-${randomUUID().slice(0, 8)}`;
  insMarket.run({
    market_id: bare,
    asset_id: assetId,
    oracle_id: oracleId,
    config_json: "{}",
  });

  // An agent with a historical submission into the btc market — it must be
  // backfilled as registered for that series, and nothing else.
  const agentId = randomUUID();
  setup
    .prepare(
      `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
       VALUES (?, ?, 'agent', 'Hist Agent', NULL, '2026-08-01T00:00:00Z')`,
    )
    .run(agentId, `hist-${agentId.slice(0, 8)}`);
  setup
    .prepare(
      `INSERT INTO submissions (call_id, agent_id, client_order_id, submitted_at,
         accepted_at, schema_version, scoring_version, dedup_key, status,
         horizon_seconds, market_id)
       VALUES (?, ?, 'o1', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 1, 1,
         ?, 'pending_t1', 300, ?)`,
    )
    .run(randomUUID(), agentId, `d-${randomUUID()}`, marketIds["btc-up-or-down-5m"]);

  setup.close();

  // Reopen → migration 075 runs the whole backfill.
  const up = openDb({ path });

  assert.equal(
    scalar<{ v: string }>(up, "SELECT value v FROM schema_meta WHERE key='schema_version'").v,
    String(LATEST_DB_MIGRATION_VERSION),
    "the upgrade reaches the latest schema version",
  );
  // The suite rewinds to 74 and replays 075, so 075 must lie on the path.
  assert.ok(
    LATEST_DB_MIGRATION_VERSION >= 75,
    "075 must still be replayed on the way to the latest version",
  );

  // Exactly the 5 distinct valid series: btc de-duplicated, orphan excluded.
  const series = venueMarketSeriesRepo.list(up);
  assert.equal(series.length, 5, "one row per distinct valid series");
  assert.deepEqual(
    series.map((s) => s.venue_series_id).sort(),
    [
      "polymarket:btc-up-or-down-5m",
      "polymarket:doge-up-or-down-5m",
      "polymarket:eth-up-or-down-5m",
      "polymarket:sol-up-or-down-5m",
      "polymarket:xrp-up-or-down-5m",
    ],
    "the five 5m crypto series, in Polymarket id form",
  );

  const btc = venueMarketSeriesRepo.get(up, "polymarket:btc-up-or-down-5m");
  assert.ok(btc, "btc series exists");
  assert.equal(btc.venue, "polymarket");
  assert.equal(btc.series_slug, "btc-up-or-down-5m");
  assert.equal(btc.series_title, "BTC Up or Down 5m");
  assert.equal(btc.venue_category, null, "the 5m crypto series carries no tag → NULL");
  assert.equal(btc.source_adapter_id, "polymarket-gamma");

  // Linking: both btc instances point at the one series; orphan + bare stay NULL.
  const vsidOf = (mid: string): string | null =>
    scalar<{ v: string | null }>(up, "SELECT venue_series_id v FROM markets WHERE market_id=?", mid).v;
  assert.equal(vsidOf(marketIds["btc-up-or-down-5m"]), "polymarket:btc-up-or-down-5m");
  assert.equal(vsidOf(btc2), "polymarket:btc-up-or-down-5m", "the second instance links to the same series");
  assert.equal(vsidOf(marketIds["doge-up-or-down-5m"]), "polymarket:doge-up-or-down-5m");
  assert.equal(vsidOf(orphan), null, "a slug with no title yields no series, so no link");
  assert.equal(vsidOf(bare), null, "a market naming no series stays null — never fabricated");

  // Registration backfilled from submission history — exactly the btc series.
  const regs = agentMarketRegistrationsRepo.listForAgent(up, agentId);
  assert.equal(regs.length, 1, "one historical series");
  assert.equal(regs[0].venue_series_id, "polymarket:btc-up-or-down-5m");

  // The CLOCK series table is byte-for-byte what it was.
  const clockAfter = up
    .prepare("SELECT * FROM market_series WHERE series_id='polymarket:binary-300s:v1'")
    .get();
  assert.deepEqual(clockAfter, clockBefore, "market_series (the CLOCK series) is untouched");

  // Terms rebuilt empty on the new composite key.
  const aptCols = up.prepare("PRAGMA table_info(agent_provider_terms)").all() as {
    name: string;
  }[];
  assert.ok(
    aptCols.some((c) => c.name === "venue_series_id"),
    "agent_provider_terms is rekeyed with venue_series_id",
  );
  assert.equal(
    scalar<{ c: number }>(up, "SELECT count(*) c FROM agent_provider_terms").c,
    0,
    "the rekeyed table starts empty",
  );

  up.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── 2. A non-empty legacy agent_provider_terms ABORTS the migration ────────
{
  const dir = mkdtempSync(join(tmpdir(), "vms-legacy-"));
  const path = join(dir, "verdict.db");

  const setup = openDb({ path });
  rewindToV74(setup);
  const agentId = randomUUID();
  setup
    .prepare(
      `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
       VALUES (?, ?, 'agent', 'Legacy', NULL, '2026-08-01T00:00:00Z')`,
    )
    .run(agentId, `legacy-${agentId.slice(0, 8)}`);
  // An agent-wide price, the exact shape 075 refuses to guess a series for.
  setup
    .prepare(
      `INSERT INTO agent_provider_terms
         (agent_id, price_atoms, currency, pricing_version,
          max_subscribers_per_call, created_at, updated_at)
       VALUES (?, '10000', 'USDC', 'v1', 40, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
    )
    .run(agentId);
  setup.close();

  assert.throws(
    () => openDb({ path }),
    (err: unknown) =>
      err instanceof Error && /agent_provider_terms holds 1 legacy/.test(err.message),
    "a non-empty legacy terms table aborts the 075 migration",
  );

  // Aborted, not half-applied: still honestly at 74, the row intact, no new tables.
  const after = new Database(path);
  assert.equal(
    scalar<{ v: string }>(after, "SELECT value v FROM schema_meta WHERE key='schema_version'").v,
    "74",
    "the DB stays honestly at 74",
  );
  assert.equal(
    scalar<{ c: number }>(after, "SELECT count(*) c FROM agent_provider_terms").c,
    1,
    "the legacy row is left untouched",
  );
  assert.equal(
    Boolean(
      after
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='venue_market_series'")
        .get(),
    ),
    false,
    "no 075 tables were created",
  );
  after.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── 3. Series identity is (venue, series_slug): duplicates are rejected ─────
{
  const dir = mkdtempSync(join(tmpdir(), "vms-dup-"));
  const db = openDb({ path: join(dir, "verdict.db") });
  const first = venueMarketSeriesRepo.upsert(db, {
    venue: "polymarket",
    series_slug: "dup-5m",
    series_title: "Dup",
    venue_category: null,
    source_adapter_id: "polymarket-gamma",
    now: NOW,
  });
  // A repeat upsert is the same identity — it updates, never a second row.
  venueMarketSeriesRepo.upsert(db, {
    venue: "polymarket",
    series_slug: "dup-5m",
    series_title: "Dup Renamed",
    venue_category: "Crypto",
    source_adapter_id: "polymarket-gamma",
    now: "2026-08-21T00:00:00Z",
  });
  assert.equal(venueMarketSeriesRepo.list(db).length, 1, "same (venue, slug) is one series");
  assert.equal(venueMarketSeriesRepo.get(db, first.venue_series_id)?.series_title, "Dup Renamed");

  // A raw insert of the same (venue, slug) under a DIFFERENT id is refused.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO venue_market_series
             (venue_series_id, venue, series_slug, series_title, venue_category,
              source_adapter_id, created_at, updated_at)
           VALUES ('polymarket:dup-5m-alias','polymarket','dup-5m','Alias',NULL,
             'polymarket-gamma', ?, ?)`,
        )
        .run(NOW, NOW),
    /UNIQUE/,
    "the same (venue, series_slug) cannot exist under two ids",
  );
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── 4. Registration lifecycle + terms are gated on it and cascade with it ──
{
  const dir = mkdtempSync(join(tmpdir(), "vms-reg-"));
  const db = openDb({ path: join(dir, "verdict.db") });

  const agentId = randomUUID();
  db.prepare(
    `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
     VALUES (?, ?, 'agent', 'Reg', NULL, ?)`,
  ).run(agentId, `reg-${agentId.slice(0, 8)}`, NOW);

  const s1 = venueMarketSeriesRepo.upsert(db, {
    venue: "polymarket",
    series_slug: "btc-up-or-down-5m",
    series_title: "BTC Up or Down 5m",
    venue_category: null,
    source_adapter_id: "polymarket-gamma",
    now: NOW,
  });
  const s2 = venueMarketSeriesRepo.upsert(db, {
    venue: "polymarket",
    series_slug: "eth-up-or-down-5m",
    series_title: "ETH Up or Down 5m",
    venue_category: null,
    source_adapter_id: "polymarket-gamma",
    now: NOW,
  });

  const terms = (venueSeriesId: string, price: string) => ({
    agent_id: agentId,
    venue_series_id: venueSeriesId,
    price_atoms: price,
    currency: "USDC",
    pricing_version: "v1",
    max_subscribers_per_call: null,
    now: NOW,
  });

  // Terms without a registration are refused (the composite FK).
  assert.equal(
    agentMarketRegistrationsRepo.isRegistered(db, { agentId, venueSeriesId: s1.venue_series_id }),
    false,
  );
  assert.throws(
    () => agentProviderTermsRepo.upsert(db, terms(s1.venue_series_id, "10000")),
    /FOREIGN KEY/,
    "no price for a series the agent does not serve",
  );

  // Registration is idempotent.
  agentMarketRegistrationsRepo.register(db, { agentId, venueSeriesId: s1.venue_series_id, now: NOW });
  agentMarketRegistrationsRepo.register(db, { agentId, venueSeriesId: s1.venue_series_id, now: NOW });
  assert.equal(agentMarketRegistrationsRepo.listForAgent(db, agentId).length, 1, "re-register is a no-op");
  assert.equal(
    agentMarketRegistrationsRepo.isRegistered(db, { agentId, venueSeriesId: s1.venue_series_id }),
    true,
  );

  // Now the price for s1 is accepted.
  agentProviderTermsRepo.upsert(db, terms(s1.venue_series_id, "10000"));
  assert.equal(
    agentProviderTermsRepo.get(db, { agentId, venueSeriesId: s1.venue_series_id })?.price_atoms,
    "10000",
  );

  // A second series, priced independently.
  agentMarketRegistrationsRepo.register(db, { agentId, venueSeriesId: s2.venue_series_id, now: NOW });
  agentProviderTermsRepo.upsert(db, terms(s2.venue_series_id, "20000"));

  // Unregistering s1 cascades ONLY s1's terms; s2 is untouched.
  agentMarketRegistrationsRepo.unregister(db, { agentId, venueSeriesId: s1.venue_series_id });
  assert.equal(
    agentProviderTermsRepo.get(db, { agentId, venueSeriesId: s1.venue_series_id }),
    null,
    "s1 terms cascade away with the registration",
  );
  assert.equal(
    agentProviderTermsRepo.get(db, { agentId, venueSeriesId: s2.venue_series_id })?.price_atoms,
    "20000",
    "s2 terms survive",
  );
  assert.equal(
    agentMarketRegistrationsRepo.isRegistered(db, { agentId, venueSeriesId: s2.venue_series_id }),
    true,
    "s2 registration survives",
  );
  assert.equal(
    agentMarketRegistrationsRepo.isRegistered(db, { agentId, venueSeriesId: s1.venue_series_id }),
    false,
  );

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write("OK venue market series smoke\n");
