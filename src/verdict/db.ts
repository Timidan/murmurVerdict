import Database from "better-sqlite3";
import {
  AcceptedCall,
  AgentKind,
  AgentProfile,
  CallStatus,
  ClaimChallenge,
  Dispute,
  DisputeGrounds,
  DisputeStatus,
  Outcome,
  SubmittedCall,
  SCHEMA_VERSION,
  SCORING_VERSION,
  UsageEvent,
  UsageEventKind,
  VerifiedIdentity,
} from "./schema.js";

// ─── DB bootstrap ────────────────────────────────────────────────────────────
//
// SQLite is file-backed; default path resolved from VERDICT_DB_PATH or
// `./data/verdict.db`. WAL mode is enabled so the resolver and submissions
// API can run in parallel without holding locks.

export interface OpenDbOptions {
  path?: string;
  readonly?: boolean;
}

export function openDb(opts: OpenDbOptions = {}): Database.Database {
  const path = opts.path ?? process.env.VERDICT_DB_PATH ?? "./data/verdict.db";
  const db = new Database(path, { readonly: opts.readonly ?? false });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  applyMigrations(db);
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const get = db
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .pluck();
  const set = db.prepare(
    "INSERT INTO schema_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );

  const current = (get.get("schema_version") as string | undefined) ?? "0";
  let v = Number(current);

  if (v < 1) {
    db.exec(MIGRATION_001);
    v = 1;
    set.run("schema_version", String(v));
    set.run("verdict_schema_version", String(SCHEMA_VERSION));
    set.run("verdict_scoring_version", String(SCORING_VERSION));
  }

  if (v < 2) {
    db.exec(MIGRATION_002);
    v = 2;
    set.run("schema_version", String(v));
  }

  if (v < 3) {
    db.exec(MIGRATION_003);
    v = 3;
    set.run("schema_version", String(v));
  }

  if (v < 4) {
    db.exec(MIGRATION_004);
    v = 4;
    set.run("schema_version", String(v));
  }

  if (v < 5) {
    db.exec(MIGRATION_005);
    v = 5;
    set.run("schema_version", String(v));
  }

  if (v < 6) {
    db.exec(MIGRATION_006);
    v = 6;
    set.run("schema_version", String(v));
  }

  if (v < 7) {
    db.exec(MIGRATION_007);
    v = 7;
    set.run("schema_version", String(v));
  }

  if (v < 8) {
    db.exec(MIGRATION_008);
    v = 8;
    set.run("schema_version", String(v));
  }

  if (v < 9) {
    db.exec(MIGRATION_009);
    v = 9;
    set.run("schema_version", String(v));
  }

  if (v < 10) {
    applyTableRebuildMigration(
      db,
      MIGRATION_010,
      () => {
        set.run("schema_version", "10");
      },
      ["submissions", "submissions_v3"],
    );
    v = 10;
  }

  if (v < 11) {
    applyTableRebuildMigration(
      db,
      MIGRATION_011,
      () => {
        set.run("schema_version", "11");
      },
      ["oracle_policies", "oracle_policies_v2"],
    );
    v = 11;
  }
}

/**
 * P3 Phase 2c+ — atomic table-rebuild migration helper. Codex audit fix.
 *
 * Pre-fix: migrations 010 and 011 contained `PRAGMA foreign_keys=OFF` +
 * raw DDL + `PRAGMA foreign_keys=ON` in a single .exec() string. SQLite's
 * .exec() runs each semicolon-delimited statement INDEPENDENTLY (no
 * implicit transaction), so a process crash mid-migration could leave
 * the rebuild table half-populated — at worst, the original table dropped
 * but the rename never completed. Permanent data loss.
 *
 * Post-fix:
 *   1. PRAGMA off — must live OUTSIDE any transaction (SQLite no-ops it
 *      inside one).
 *   2. better-sqlite3's transaction wrapper runs the whole rebuild +
 *      schema_meta bump under one BEGIN/COMMIT. Any error rolls back.
 *      A process crash before COMMIT also rolls back on next open.
 *   3. PRAGMA on in `finally` so we never leave a connection with FK
 *      enforcement disabled, even when an error escapes.
 *   4. Migration SQL bodies start with `DROP TABLE IF EXISTS <_v>`
 *      so a retry after a half-applied rebuild doesn't fail on the
 *      orphan temp table.
 *
 * Pre-transaction recovery (Codex audit follow-up):
 * Before entering the transaction we inspect the database for the four
 * possible (original, temp) table states the migration's rebuild pattern
 * can leave behind after a crash:
 *
 *   1. original EXISTS, temp MISSING — clean state. Run normal migration.
 *   2. original EXISTS, temp EXISTS  — previous run was interrupted before
 *      the temp got renamed/dropped. The migration's leading
 *      `DROP TABLE IF EXISTS <temp>` will clean it up safely. Continue.
 *   3. original MISSING, temp EXISTS — RECOVERABLE. The previous run
 *      crashed AFTER `DROP TABLE <original>` but BEFORE
 *      `ALTER TABLE <temp> RENAME TO <original>`. The temp table holds
 *      the only copy of the data. We rename it back to <original> here
 *      (one statement, atomic in SQLite) BEFORE the migration runs, so
 *      the migration's `DROP TABLE IF EXISTS <temp>` becomes a no-op
 *      and its INSERT-from-original step finds the data again.
 *   4. original MISSING, temp MISSING — CATASTROPHIC. Both tables are
 *      gone. We refuse to run rather than silently produce an empty
 *      rebuilt table; the operator must restore from backup.
 *
 * Note: state #3's rename is intentionally OUTSIDE the foreign_keys=OFF
 * block and OUTSIDE the transaction. ALTER TABLE … RENAME is already
 * atomic on its own, and we want recovery to be observable in the
 * sqlite_master state we re-check for state #1 vs #2 once the rename
 * lands.
 */
export function applyTableRebuildMigration(
  db: Database.Database,
  sql: string,
  bumpSchemaVersion: () => void,
  tables: readonly [originalTableName: string, tempTableName: string],
): void {
  const [original, temp] = tables;
  const tableExists = (name: string): boolean =>
    !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name);

  const originalPresent = tableExists(original);
  const tempPresent = tableExists(temp);

  if (!originalPresent && !tempPresent) {
    throw new Error(
      `Table-rebuild migration cannot run: ${original} and ${temp} are both missing; database may be corrupted, manual recovery needed.`,
    );
  }

  if (!originalPresent && tempPresent) {
    // Recoverable orphan from a previous crashed rebuild — rename the
    // temp table back to the original so the migration's INSERT step
    // finds the data. Bare identifier interpolation is safe here: the
    // names come from compile-time string-literal tuples in the call
    // sites, not user input.
    db.exec(`ALTER TABLE ${temp} RENAME TO ${original};`);
  }

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(sql);
      bumpSchemaVersion();
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

// ─── Migration 001 — initial schema ──────────────────────────────────────────

const MIGRATION_001 = `
  CREATE TABLE agents (
    agent_id     TEXT PRIMARY KEY,
    display_slug TEXT UNIQUE NOT NULL COLLATE NOCASE,
    kind         TEXT NOT NULL CHECK (kind IN ('benchmark','shadow','verified','internal_test')),
    display_name TEXT NOT NULL,
    bio          TEXT,
    created_at   TEXT NOT NULL,
    api_key_hash TEXT
  );
  CREATE INDEX idx_agents_kind ON agents(kind);

  CREATE TABLE verified_identities (
    identity_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('x','telegram','wallet','openserv')),
    value        TEXT NOT NULL,
    verified_at  TEXT NOT NULL,
    UNIQUE(kind, value)
  );
  CREATE INDEX idx_verified_identities_agent ON verified_identities(agent_id);

  CREATE TABLE submissions (
    call_id           TEXT PRIMARY KEY,
    agent_id          TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    client_order_id   TEXT NOT NULL,
    asset_id          TEXT NOT NULL,
    side              TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
    horizon_hours     INTEGER NOT NULL CHECK (horizon_hours IN (1,4,24,168)),
    confidence        REAL NOT NULL CHECK (confidence >= 0.51 AND confidence <= 0.95),
    submitted_at      TEXT NOT NULL,
    accepted_at       TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('accepted','pending_t0','pending_t1','resolved','disputed','re_resolved','rejected')),
    rationale         TEXT,
    strategy_tag      TEXT,
    schema_version    INTEGER NOT NULL,
    scoring_version   INTEGER NOT NULL,
    dedup_key         TEXT NOT NULL,
    UNIQUE(agent_id, client_order_id),
    UNIQUE(dedup_key)
  );
  CREATE INDEX idx_submissions_agent ON submissions(agent_id);
  CREATE INDEX idx_submissions_status ON submissions(status);
  CREATE INDEX idx_submissions_asset_horizon ON submissions(asset_id, horizon_hours);

  CREATE TABLE preflights (
    call_id                 TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    murmur_score            REAL NOT NULL,
    murmur_playbook         TEXT NOT NULL,
    risk_flags_json         TEXT NOT NULL,
    data_freshness_seconds  INTEGER NOT NULL,
    market_regime           TEXT NOT NULL CHECK (market_regime IN ('bullish','bearish','neutral'))
  );

  CREATE TABLE oracle_policies (
    call_id                       TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    primary_feed                  TEXT NOT NULL,
    fallback_feed                 TEXT NOT NULL,
    primary_max_staleness_sec     INTEGER NOT NULL,
    fallback_max_staleness_sec    INTEGER NOT NULL,
    t0_grace_seconds              INTEGER NOT NULL,
    t0_extended_grace_seconds     INTEGER NOT NULL
  );

  CREATE TABLE t0_anchors (
    call_id  TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    t0       TEXT NOT NULL,
    p0       TEXT NOT NULL,
    feed     TEXT NOT NULL,
    source_id TEXT NOT NULL,
    anchored_at TEXT NOT NULL
  );

  CREATE TABLE t1_resolutions (
    call_id        TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    t1             TEXT NOT NULL,
    p1             TEXT NOT NULL,
    t1_feed        TEXT NOT NULL,
    signed_return  TEXT NOT NULL,
    outcome        TEXT NOT NULL CHECK (outcome IN ('win','loss','void','oracle_unavailable')),
    call_score     REAL,
    resolved_at    TEXT NOT NULL
  );

  CREATE TABLE receipts (
    receipt_hash    TEXT PRIMARY KEY,
    call_id         TEXT NOT NULL REFERENCES submissions(call_id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('acceptance','resolution','re_resolution')),
    canonical_json  TEXT NOT NULL,
    filecoin_cid    TEXT,
    previous_hash   TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX idx_receipts_call_kind ON receipts(call_id, kind);

  CREATE TABLE disputes (
    dispute_id  TEXT PRIMARY KEY,
    target_resolution_receipt_hash TEXT NOT NULL,
    grounds     TEXT NOT NULL CHECK (grounds IN ('stale_feed','wrong_feed_used','wrong_timestamp','calculation_bug','chain_reorg','oracle_revision_after_resolution')),
    notes       TEXT,
    filed_by    TEXT NOT NULL,
    filed_at    TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('open','replay_in_progress','upheld','rejected')),
    resolved_at TEXT,
    new_resolution_receipt_hash TEXT
  );
  CREATE INDEX idx_disputes_target ON disputes(target_resolution_receipt_hash);

  CREATE TABLE claim_challenges (
    challenge_id     TEXT PRIMARY KEY,
    agent_id         TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    target_kind      TEXT NOT NULL,
    target_value     TEXT NOT NULL,
    nonce            TEXT NOT NULL,
    challenge_text   TEXT NOT NULL,
    wallet_to_bind   TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('pending','verified','expired','rejected')),
    created_at       TEXT NOT NULL
  );
  CREATE INDEX idx_claim_challenges_agent ON claim_challenges(agent_id);

  CREATE TABLE usage_events (
    event_id        TEXT PRIMARY KEY,
    agent_id        TEXT REFERENCES agents(agent_id) ON DELETE SET NULL,
    kind            TEXT NOT NULL,
    ts              TEXT NOT NULL,
    attributes_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_usage_events_kind_ts ON usage_events(kind, ts);
`;

// ─── Migration 002 — outreach attribution ────────────────────────────────────
//
// Records every share-page click that arrives with a ?ref=<sender> param.
// The (ref, agent_slug) pair is what makes attribution interesting — it lets
// an agent profile surface "discovered by @sender" once a sender's clicks
// converge on the same agent. We do NOT store any IP / fingerprint; the
// counter is per (ref, slug) bucket, monotonically increasing.

const MIGRATION_002 = `
  CREATE TABLE ref_clicks (
    ref          TEXT NOT NULL,
    agent_slug   TEXT,
    total        INTEGER NOT NULL DEFAULT 0,
    first_at     TEXT NOT NULL,
    last_at      TEXT NOT NULL,
    PRIMARY KEY (ref, agent_slug)
  );
  CREATE INDEX idx_ref_clicks_slug ON ref_clicks(agent_slug);
  CREATE INDEX idx_ref_clicks_total ON ref_clicks(total DESC);
`;

// ─── Migration 003 — webhook subscriptions ───────────────────────────────────
//
// Lets clients (Discord / Telegram bots, OpenServ workflows, Zapier, custom
// servers) subscribe to call.accepted and call.resolved events for one
// agent (or all agents). Each delivery is signed HMAC-SHA256(secret, body).
// Failure count + last-delivery timestamps surfaced so subscribers can
// self-debug.

const MIGRATION_003 = `
  CREATE TABLE webhooks (
    id                TEXT PRIMARY KEY,
    agent_slug        TEXT,                                  -- null = all agents
    url               TEXT NOT NULL,
    secret            TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    last_delivery_at  TEXT,
    last_status       INTEGER,
    delivery_count    INTEGER NOT NULL DEFAULT 0,
    failure_count     INTEGER NOT NULL DEFAULT 0,
    disabled          INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_webhooks_slug ON webhooks(agent_slug);
`;

// ─── Migration 004 — conversion attribution ──────────────────────────────────
//
// Tracks the conversion side of the recruiters game: when a sender's ?ref
// click leads to a verified claim of the same agent_slug, the (ref, slug)
// bucket's converted_count goes up. Claim attribution is propagated by the
// dashboard reading a sticky ref from localStorage at finalize time.
const MIGRATION_004 = `
  ALTER TABLE ref_clicks ADD COLUMN converted_count       INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE ref_clicks ADD COLUMN last_conversion_at    TEXT;
`;

// ─── Migration 006 — privacy schema foundation (additive) ──────────────────
//
// P2 (privacy work) groundwork. Strategy: ship the new shape ALONGSIDE the
// existing plaintext columns so the daemon keeps working at every commit,
// then move query sites over phase-by-phase. Plaintext columns on the
// `submissions` table are NOT touched here — Phase A is purely additive.
//
// What this migration does:
//   1. Adds three privacy columns to `submissions`:
//        - privacy_mode TEXT — discriminator for the call envelope
//          ("legacy_plaintext" | "committed" | future modes)
//        - commit_hash TEXT — keccak256 of the canonical commit preimage,
//          NULL for legacy rows
//        - commit_scheme TEXT — version tag of the commit preimage
//          schema, e.g. "murmur-verdict-v0.2-commit@1"
//   2. Backfills existing rows to privacy_mode='legacy_plaintext'.
//   3. CREATEs `call_private_envelopes` (encrypted-to-daemon body, empty
//      until Phase B writes to it).
//   4. CREATEs `call_reveals` (plaintext after agent-or-fallback reveal,
//      empty until Phase C writes to it).
//   5. Adds an index on commit_hash so verifier-side commit checks stay
//      O(1).
//
// NO CHECK constraints on privacy_mode / commit_scheme / encrypted_body_alg
// / commit_preimage_schema / revealed_via — the v0.3 fhEVM port introduces
// new strings (e.g. encrypted_body_alg='fhevm-euint', revealed_via=
// 'fhevm_compute') without a migration. Codex's compatibility note.
const MIGRATION_006 = `
  ALTER TABLE submissions ADD COLUMN privacy_mode TEXT;
  ALTER TABLE submissions ADD COLUMN commit_hash TEXT;
  ALTER TABLE submissions ADD COLUMN commit_scheme TEXT;
  UPDATE submissions SET privacy_mode = 'legacy_plaintext' WHERE privacy_mode IS NULL;
  CREATE INDEX IF NOT EXISTS idx_submissions_commit_hash ON submissions(commit_hash) WHERE commit_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_submissions_privacy_mode ON submissions(privacy_mode);

  CREATE TABLE call_private_envelopes (
    call_id                 TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    encrypted_body          TEXT NOT NULL,
    encrypted_body_alg      TEXT NOT NULL,
    encrypted_body_hash     TEXT NOT NULL,
    daemon_key_id           TEXT NOT NULL,
    commit_preimage_schema  TEXT NOT NULL,
    fallback_after          TEXT,
    received_at             TEXT NOT NULL
  );
  CREATE INDEX idx_call_private_envelopes_fallback_after
    ON call_private_envelopes(fallback_after)
    WHERE fallback_after IS NOT NULL;

  CREATE TABLE call_reveals (
    call_id                  TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    side                     TEXT NOT NULL,
    asset_id                 TEXT NOT NULL,
    horizon_hours            INTEGER NOT NULL,
    confidence               REAL NOT NULL,
    rationale                TEXT,
    strategy_tag             TEXT,
    salt                     TEXT,
    t0                       TEXT,
    agent_wallet             TEXT,
    chain_id                 TEXT,
    commit_preimage_json     TEXT,
    commit_preimage_hash     TEXT,
    revealed_at              TEXT NOT NULL,
    revealed_via             TEXT NOT NULL,
    reveal_hash_valid        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_call_reveals_revealed_via ON call_reveals(revealed_via);
`;

// ─── Migration 007 — drand/tlock envelope alongside age (D21) ───────────────
//
// Phase B-3 adds a SECOND envelope per committed-mode submission: a
// drand/tlock ciphertext bound to a future drand round. Once that round
// is past, anyone can decrypt the envelope using the released drand
// beacon — no daemon participation required. Closes the selective-
// reveal attack vector and removes the operator from the trusted set.
//
// All columns are NULL-able because:
//   1. Existing committed envelopes (Phase B-2) don't have drand bindings.
//   2. drand integration is opt-in via MURMUR_DRAND_ENABLED — when
//      disabled, only the age envelope is written.
//   3. v0.3 fhEVM may bind to FHE-derived state instead of drand;
//      keeping drand_* nullable avoids forcing a rebuild.
const MIGRATION_007 = `
  ALTER TABLE call_private_envelopes ADD COLUMN drand_chain_hash TEXT;
  ALTER TABLE call_private_envelopes ADD COLUMN drand_round INTEGER;
  ALTER TABLE call_private_envelopes ADD COLUMN drand_ciphertext TEXT;
  ALTER TABLE call_private_envelopes ADD COLUMN drand_ciphertext_hash TEXT;
  CREATE INDEX IF NOT EXISTS idx_envelopes_drand_round
    ON call_private_envelopes(drand_round)
    WHERE drand_round IS NOT NULL;
`;

// ─── Migration 008 — multi-asset / multi-market registry + market_kind ────
//
// Reframe: today the system is a single market (ETH on Base, four horizons,
// direction-only). v0.2.5 introduces a registry-driven matrix:
//   - `assets`  (BTC, ETH, SOL, BNB; oracle metadata; status)
//   - `oracles` (per-asset Chainlink + Pyth bindings; adapter dispatch)
//   - `markets` (asset × horizon × market_kind; oracle policy per-market)
//
// Adding a new asset/market becomes data, not code. `market_kind` is reserved
// from the start so the same table holds today's direction_binary calls AND
// future price_point / price_bracket / depeg_threshold markets without a
// schema migration. Reserved submission columns (prediction_value,
// prediction_low, prediction_high, round_id) sit nullable for the same
// reason — no rebuild when proximity markets land.
//
// Submissions gain `market_id` + `market_config_version`. Existing rows stay
// valid: market_id=NULL means a legacy direction call keyed on
// (asset_id, horizon_hours). Read-time helpers synthesize market_id for
// legacy rows ("eth.1h", "eth.4h", "eth.24h", "eth.168h") so feed/leaderboard
// can present a unified view without rewriting old receipts.
//
// Status enum: draft | listed | frozen | retired.
//   - draft:    in registry but submissions blocked (e.g. operator hasn't
//               verified Chainlink feed address yet)
//   - listed:   active, accepts submissions
//   - frozen:   paused (oracle degraded), can resume; existing pending
//               calls continue to resolve
//   - retired:  terminal, never resumes; history preserved for audits
//
// Seed data:
//   - 4 assets (eth, btc, sol, bnb)
//   - 7 oracles (chainlink-base for eth/btc/sol; pyth-base for all four)
//   - 24 markets (4 assets × 6 horizons {5m, 15m, 1h, 4h, 24h, 7d}).
//     Only ETH at {1h, 4h, 24h, 7d} starts `listed` — those match today's
//     resolver capabilities. New short horizons (5m/15m on ETH, all
//     horizons on BTC/SOL/BNB) start `draft` until operator validates the
//     feed and the resolver upgrade lands.
//
// Oracle policy per Codex audit:
//   - <60m horizons: Pyth-pull primary (sub-second), no Chainlink fallback
//   - ≥60m horizons: Chainlink primary (heartbeat-bounded, on-chain finality),
//     Pyth fallback (matches v0.2 behavior)
//
// Void bands per Codex audit:
//   - ≤15m: 0.0003 (3 bps) — 5m ETH RMS is ~5-10 bps; 20 bps would void ~99%
//   - ≥1h:  0.002  (20 bps) — matches v0.2 default
//   These are starting points; markets.void_band is per-row so operators
//   can refine without a migration.
const MIGRATION_008 = `
  CREATE TABLE assets (
    asset_id                 TEXT PRIMARY KEY,
    display_short            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name             TEXT NOT NULL,
    native_chain             TEXT NOT NULL,
    pyth_feed_id             TEXT,
    chainlink_base_address   TEXT,
    decimals_hint            INTEGER NOT NULL DEFAULT 8,
    status                   TEXT NOT NULL DEFAULT 'listed'
                              CHECK (status IN ('draft','listed','frozen','retired')),
    notes                    TEXT,
    created_at               TEXT NOT NULL
  );
  CREATE INDEX idx_assets_status ON assets(status);

  CREATE TABLE oracles (
    oracle_id     TEXT PRIMARY KEY,
    asset_id      TEXT NOT NULL REFERENCES assets(asset_id),
    kind          TEXT NOT NULL CHECK (kind IN ('chainlink_evm','pyth_pull','pyth_solana')),
    adapter       TEXT NOT NULL,
    chain         TEXT NOT NULL,
    config_json   TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'listed'
                  CHECK (status IN ('draft','listed','frozen','retired')),
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_oracles_asset ON oracles(asset_id);
  CREATE INDEX idx_oracles_status ON oracles(status);

  CREATE TABLE markets (
    market_id                   TEXT PRIMARY KEY,
    asset_id                    TEXT NOT NULL REFERENCES assets(asset_id),
    market_kind                 TEXT NOT NULL DEFAULT 'direction_binary',
    horizon_seconds             INTEGER NOT NULL CHECK (horizon_seconds > 0),
    primary_oracle_id           TEXT NOT NULL REFERENCES oracles(oracle_id),
    fallback_oracle_id          TEXT REFERENCES oracles(oracle_id),
    primary_max_staleness_sec   INTEGER NOT NULL,
    fallback_max_staleness_sec  INTEGER,
    t0_grace_seconds            INTEGER NOT NULL,
    t0_extended_grace_seconds   INTEGER NOT NULL,
    void_band                   TEXT NOT NULL,
    round_cadence_seconds       INTEGER,
    scoring_kind                TEXT NOT NULL DEFAULT 'brier_direction',
    market_config_version       INTEGER NOT NULL DEFAULT 1,
    status                      TEXT NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft','listed','frozen','retired')),
    notes                       TEXT,
    created_at                  TEXT NOT NULL
  );
  CREATE INDEX idx_markets_asset ON markets(asset_id);
  CREATE INDEX idx_markets_status ON markets(status);
  CREATE INDEX idx_markets_kind ON markets(market_kind);

  -- Submissions extension: market_id + reserved proximity columns.
  -- All nullable so existing rows stay valid; new code opts in.
  ALTER TABLE submissions ADD COLUMN market_id TEXT;
  ALTER TABLE submissions ADD COLUMN market_config_version INTEGER;
  ALTER TABLE submissions ADD COLUMN prediction_value TEXT;
  ALTER TABLE submissions ADD COLUMN prediction_low TEXT;
  ALTER TABLE submissions ADD COLUMN prediction_high TEXT;
  ALTER TABLE submissions ADD COLUMN round_id TEXT;
  CREATE INDEX idx_submissions_market ON submissions(market_id) WHERE market_id IS NOT NULL;
  CREATE INDEX idx_submissions_round  ON submissions(round_id)  WHERE round_id  IS NOT NULL;

  -- ─── Seed: assets ──────────────────────────────────────────────────────
  -- Pyth feed IDs are global (same across chains). Chainlink Base addresses
  -- are operator-verifiable on data.chain.link/feeds/base. BNB has no
  -- well-known Chainlink Base feed at v0.2.5 cut — Pyth-only by design.
  INSERT OR IGNORE INTO assets (asset_id, display_short, display_name, native_chain, pyth_feed_id, chainlink_base_address, decimals_hint, status, notes, created_at) VALUES
    ('base:ETH:USD', 'eth', 'Ethereum', 'ethereum',
     '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
     '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
     8, 'listed', 'v0.1 launch asset', '2026-05-08T00:00:00Z'),
    ('base:BTC:USD', 'btc', 'Bitcoin', 'bitcoin',
     '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
     '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F',
     8, 'listed', 'verify chainlink address before flipping markets to listed', '2026-05-08T00:00:00Z'),
    ('base:SOL:USD', 'sol', 'Solana', 'solana',
     '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
     '0x975043adBb80fc32276CbF9Bbcfd4A601a12462D',
     8, 'listed', 'verify chainlink address before flipping markets to listed', '2026-05-08T00:00:00Z'),
    ('base:BNB:USD', 'bnb', 'BNB', 'binance-smart-chain',
     '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
     NULL,
     8, 'listed', 'no Chainlink Base feed at launch — Pyth-only', '2026-05-08T00:00:00Z');

  -- ─── Seed: oracles ─────────────────────────────────────────────────────
  -- Chainlink Base feeds (one per ETH/BTC/SOL — none for BNB)
  INSERT OR IGNORE INTO oracles (oracle_id, asset_id, kind, adapter, chain, config_json, status, created_at) VALUES
    ('chainlink-base-eth-usd', 'base:ETH:USD', 'chainlink_evm', 'chainlink-evm', 'base',
     '{"feed_address":"0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70"}', 'listed', '2026-05-08T00:00:00Z'),
    ('chainlink-base-btc-usd', 'base:BTC:USD', 'chainlink_evm', 'chainlink-evm', 'base',
     '{"feed_address":"0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F"}', 'draft', '2026-05-08T00:00:00Z'),
    ('chainlink-base-sol-usd', 'base:SOL:USD', 'chainlink_evm', 'chainlink-evm', 'base',
     '{"feed_address":"0x975043adBb80fc32276CbF9Bbcfd4A601a12462D"}', 'draft', '2026-05-08T00:00:00Z');

  -- Pyth pull feeds (one per asset; Hermes endpoint global)
  INSERT OR IGNORE INTO oracles (oracle_id, asset_id, kind, adapter, chain, config_json, status, created_at) VALUES
    ('pyth-base-eth-usd', 'base:ETH:USD', 'pyth_pull', 'pyth-pull', 'base',
     '{"price_id":"0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"}', 'listed', '2026-05-08T00:00:00Z'),
    ('pyth-base-btc-usd', 'base:BTC:USD', 'pyth_pull', 'pyth-pull', 'base',
     '{"price_id":"0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"}', 'listed', '2026-05-08T00:00:00Z'),
    ('pyth-base-sol-usd', 'base:SOL:USD', 'pyth_pull', 'pyth-pull', 'base',
     '{"price_id":"0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"}', 'listed', '2026-05-08T00:00:00Z'),
    ('pyth-base-bnb-usd', 'base:BNB:USD', 'pyth_pull', 'pyth-pull', 'base',
     '{"price_id":"0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f"}', 'listed', '2026-05-08T00:00:00Z');

  -- ─── Seed: markets ─────────────────────────────────────────────────────
  -- Direction-binary markets only at v0.2.5. ETH at 1h/4h/24h/7d starts
  -- 'listed' (matches today's resolver). Everything else 'draft' until
  -- operator validates and the sub-hour resolver upgrade lands.
  --
  -- Oracle policy:
  --   <60m: Pyth primary, no Chainlink fallback (Chainlink heartbeat too coarse)
  --   ≥60m: Chainlink primary, Pyth fallback (where Chainlink feed exists)
  --   BNB: Pyth-only at every horizon (no Chainlink Base)
  --
  -- Void bands: 0.0003 for ≤15m, 0.002 for ≥1h.
  -- t0 grace: 60s for sub-hour, 120s for ≥1h. Extended: 2× grace.

  -- ETH markets (4 listed + 2 draft for short horizons)
  INSERT OR IGNORE INTO markets (market_id, asset_id, market_kind, horizon_seconds, primary_oracle_id, fallback_oracle_id, primary_max_staleness_sec, fallback_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds, void_band, round_cadence_seconds, scoring_kind, market_config_version, status, notes, created_at) VALUES
    ('eth.5m',   'base:ETH:USD', 'direction_binary',     300, 'pyth-base-eth-usd', NULL,                    10, NULL, 30,  60, '0.0003', NULL, 'brier_direction', 1, 'draft',  'sub-hour resolver upgrade required', '2026-05-08T00:00:00Z'),
    ('eth.15m',  'base:ETH:USD', 'direction_binary',     900, 'pyth-base-eth-usd', NULL,                    15, NULL, 30,  60, '0.0003', NULL, 'brier_direction', 1, 'draft',  'sub-hour resolver upgrade required', '2026-05-08T00:00:00Z'),
    ('eth.1h',   'base:ETH:USD', 'direction_binary',    3600, 'chainlink-base-eth-usd', 'pyth-base-eth-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'listed', 'maps to legacy horizon_hours=1',     '2026-05-08T00:00:00Z'),
    ('eth.4h',   'base:ETH:USD', 'direction_binary',   14400, 'chainlink-base-eth-usd', 'pyth-base-eth-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'listed', 'maps to legacy horizon_hours=4',     '2026-05-08T00:00:00Z'),
    ('eth.24h',  'base:ETH:USD', 'direction_binary',   86400, 'chainlink-base-eth-usd', 'pyth-base-eth-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'listed', 'maps to legacy horizon_hours=24',    '2026-05-08T00:00:00Z'),
    ('eth.7d',   'base:ETH:USD', 'direction_binary',  604800, 'chainlink-base-eth-usd', 'pyth-base-eth-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'listed', 'maps to legacy horizon_hours=168',   '2026-05-08T00:00:00Z');

  -- BTC markets (all draft; flip to listed once operator verifies Chainlink address + resolver supports asset)
  INSERT OR IGNORE INTO markets (market_id, asset_id, market_kind, horizon_seconds, primary_oracle_id, fallback_oracle_id, primary_max_staleness_sec, fallback_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds, void_band, round_cadence_seconds, scoring_kind, market_config_version, status, notes, created_at) VALUES
    ('btc.5m',   'base:BTC:USD', 'direction_binary',     300, 'pyth-base-btc-usd', NULL,                    10, NULL, 30,  60, '0.0003', NULL, 'brier_direction', 1, 'draft', NULL, '2026-05-08T00:00:00Z'),
    ('btc.15m',  'base:BTC:USD', 'direction_binary',     900, 'pyth-base-btc-usd', NULL,                    15, NULL, 30,  60, '0.0003', NULL, 'brier_direction', 1, 'draft', NULL, '2026-05-08T00:00:00Z'),
    ('btc.1h',   'base:BTC:USD', 'direction_binary',    3600, 'chainlink-base-btc-usd', 'pyth-base-btc-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'draft', NULL, '2026-05-08T00:00:00Z'),
    ('btc.4h',   'base:BTC:USD', 'direction_binary',   14400, 'chainlink-base-btc-usd', 'pyth-base-btc-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'draft', NULL, '2026-05-08T00:00:00Z'),
    ('btc.24h',  'base:BTC:USD', 'direction_binary',   86400, 'chainlink-base-btc-usd', 'pyth-base-btc-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'draft', NULL, '2026-05-08T00:00:00Z'),
    ('btc.7d',   'base:BTC:USD', 'direction_binary',  604800, 'chainlink-base-btc-usd', 'pyth-base-btc-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'draft', NULL, '2026-05-08T00:00:00Z');

  -- SOL markets (all draft; SOL has higher RMS — operator may want wider void_band, default still 3 bps short / 20 bps long)
  INSERT OR IGNORE INTO markets (market_id, asset_id, market_kind, horizon_seconds, primary_oracle_id, fallback_oracle_id, primary_max_staleness_sec, fallback_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds, void_band, round_cadence_seconds, scoring_kind, market_config_version, status, notes, created_at) VALUES
    ('sol.5m',   'base:SOL:USD', 'direction_binary',     300, 'pyth-base-sol-usd', NULL,                    10, NULL, 30,  60, '0.0003', NULL, 'brier_direction', 1, 'draft', 'higher vol — consider 0.0005 void_band', '2026-05-08T00:00:00Z'),
    ('sol.15m',  'base:SOL:USD', 'direction_binary',     900, 'pyth-base-sol-usd', NULL,                    15, NULL, 30,  60, '0.0003', NULL, 'brier_direction', 1, 'draft', NULL, '2026-05-08T00:00:00Z'),
    ('sol.1h',   'base:SOL:USD', 'direction_binary',    3600, 'chainlink-base-sol-usd', 'pyth-base-sol-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'draft', NULL, '2026-05-08T00:00:00Z'),
    ('sol.4h',   'base:SOL:USD', 'direction_binary',   14400, 'chainlink-base-sol-usd', 'pyth-base-sol-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'draft', NULL, '2026-05-08T00:00:00Z'),
    ('sol.24h',  'base:SOL:USD', 'direction_binary',   86400, 'chainlink-base-sol-usd', 'pyth-base-sol-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'draft', NULL, '2026-05-08T00:00:00Z'),
    ('sol.7d',   'base:SOL:USD', 'direction_binary',  604800, 'chainlink-base-sol-usd', 'pyth-base-sol-usd', 60, 30,  120, 300, '0.002',  NULL, 'brier_direction', 1, 'draft', NULL, '2026-05-08T00:00:00Z');

  -- BNB markets (all draft; Pyth-only at every horizon)
  INSERT OR IGNORE INTO markets (market_id, asset_id, market_kind, horizon_seconds, primary_oracle_id, fallback_oracle_id, primary_max_staleness_sec, fallback_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds, void_band, round_cadence_seconds, scoring_kind, market_config_version, status, notes, created_at) VALUES
    ('bnb.5m',   'base:BNB:USD', 'direction_binary',     300, 'pyth-base-bnb-usd', NULL, 10, NULL, 30,  60, '0.0003', NULL, 'brier_direction', 1, 'draft', 'pyth-only', '2026-05-08T00:00:00Z'),
    ('bnb.15m',  'base:BNB:USD', 'direction_binary',     900, 'pyth-base-bnb-usd', NULL, 15, NULL, 30,  60, '0.0003', NULL, 'brier_direction', 1, 'draft', 'pyth-only', '2026-05-08T00:00:00Z'),
    ('bnb.1h',   'base:BNB:USD', 'direction_binary',    3600, 'pyth-base-bnb-usd', NULL, 30, NULL, 120, 300, '0.002', NULL, 'brier_direction', 1, 'draft', 'pyth-only', '2026-05-08T00:00:00Z'),
    ('bnb.4h',   'base:BNB:USD', 'direction_binary',   14400, 'pyth-base-bnb-usd', NULL, 30, NULL, 120, 300, '0.002', NULL, 'brier_direction', 1, 'draft', 'pyth-only', '2026-05-08T00:00:00Z'),
    ('bnb.24h',  'base:BNB:USD', 'direction_binary',   86400, 'pyth-base-bnb-usd', NULL, 30, NULL, 120, 300, '0.002', NULL, 'brier_direction', 1, 'draft', 'pyth-only', '2026-05-08T00:00:00Z'),
    ('bnb.7d',   'base:BNB:USD', 'direction_binary',  604800, 'pyth-base-bnb-usd', NULL, 30, NULL, 120, 300, '0.002', NULL, 'brier_direction', 1, 'draft', 'pyth-only', '2026-05-08T00:00:00Z');
`;

// ─── Migration 009 — backfill market_id on legacy ETH submissions ──────────
//
// Migration 008 added `submissions.market_id` as a nullable column. Phase 1
// of the markets-registry wiring (P3) backfills the unambiguous mappings so
// every read path can join on submissions.market_id directly without falling
// back to legacyIdFor() at runtime.
//
// Backfill rule (Codex P3 D7):
//   base:ETH:USD + horizon_hours=1   → market_id='eth.1h'
//   base:ETH:USD + horizon_hours=4   → market_id='eth.4h'
//   base:ETH:USD + horizon_hours=24  → market_id='eth.24h'
//   base:ETH:USD + horizon_hours=168 → market_id='eth.7d'
//
// market_config_version is stamped from the market row at the time the
// migration runs. This is intentional: the resolver / scoring path will
// honor the per-submission stamp going forward, so a config bump after the
// backfill date won't retroactively change how legacy calls are scored.
//
// Receipts / commit-preimages / envelopes are NOT touched. The legacy v1+v2
// receipts already issued for these calls keep their original schemas and
// hashes; they simply now point at a row that has a market_id alongside the
// (asset_id, horizon_hours) tuple that's still in the receipt subject.
const MIGRATION_009 = `
  UPDATE submissions
  SET
    market_id = 'eth.1h',
    market_config_version = (SELECT market_config_version FROM markets WHERE market_id = 'eth.1h')
  WHERE market_id IS NULL
    AND asset_id = 'base:ETH:USD'
    AND horizon_hours = 1;

  UPDATE submissions
  SET
    market_id = 'eth.4h',
    market_config_version = (SELECT market_config_version FROM markets WHERE market_id = 'eth.4h')
  WHERE market_id IS NULL
    AND asset_id = 'base:ETH:USD'
    AND horizon_hours = 4;

  UPDATE submissions
  SET
    market_id = 'eth.24h',
    market_config_version = (SELECT market_config_version FROM markets WHERE market_id = 'eth.24h')
  WHERE market_id IS NULL
    AND asset_id = 'base:ETH:USD'
    AND horizon_hours = 24;

  UPDATE submissions
  SET
    market_id = 'eth.7d',
    market_config_version = (SELECT market_config_version FROM markets WHERE market_id = 'eth.7d')
  WHERE market_id IS NULL
    AND asset_id = 'base:ETH:USD'
    AND horizon_hours = 168;
`;

// ─── Migration 010 — submissions table rebuild for sub-hour markets ────────
//
// Two coupled changes that both need a table rebuild (SQLite can't ALTER
// CHECK constraints in place):
//   1. Drop the legacy CHECK (horizon_hours IN (1,4,24,168)). Sub-hour
//      markets (5m, 15m) need horizon_hours=0 to be insertable; the old
//      constraint blocked it. New constraint: horizon_hours >= 0.
//   2. Add horizon_seconds INTEGER NOT NULL as the canonical horizon
//      value going forward. horizon_hours is retained for back-compat
//      with v1 receipt subjects that embed it, but consumers should
//      prefer horizon_seconds (no precision loss for sub-hour markets).
//
// Backfill rule: existing rows have horizon_hours ∈ {1,4,24,168}, so
// horizon_seconds = horizon_hours * 3600. New writes (post-migration)
// stamp horizon_seconds directly from markets.horizon_seconds at
// acceptance. After this, horizon_seconds is the CANONICAL field and
// horizon_hours is the back-compat surface.
//
// FK cascade: submissions has dependents (preflights, oracle_policies,
// t0_anchors, t1_resolutions, receipts, call_private_envelopes,
// call_reveals). PRAGMA foreign_keys = OFF for the rebuild — same
// pattern as migration 005's agents rebuild.
//
// What this DOESN'T do:
//   - Sub-hour markets are still 'draft' (no operator flip)
//   - T0PolicySchema still requires fallback_feed (BNB markets still
//     'draft', sub-hour markets need a fallback story before they go
//     live — likely a Pyth-only relaxation in a follow-on phase)
//   - Resolver tick frequency unchanged (the sub-hour scaling concern
//     is deferred until we have meaningful sub-hour traffic)
const MIGRATION_010 = `
  -- Idempotent retry guard: an interrupted earlier attempt could have left
  -- this temp table behind. Drop before recreating so a fresh transaction
  -- can run cleanly. PRAGMA foreign_keys is set OFF in JS BEFORE the
  -- transaction begins (it can't toggle inside a transaction).
  DROP TABLE IF EXISTS submissions_v3;

  CREATE TABLE submissions_v3 (
    call_id           TEXT PRIMARY KEY,
    agent_id          TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    client_order_id   TEXT NOT NULL,
    asset_id          TEXT NOT NULL,
    side              TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
    horizon_hours     INTEGER NOT NULL CHECK (horizon_hours >= 0),
    horizon_seconds   INTEGER NOT NULL CHECK (horizon_seconds > 0),
    confidence        REAL NOT NULL CHECK (confidence >= 0.51 AND confidence <= 0.95),
    submitted_at      TEXT NOT NULL,
    accepted_at       TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('accepted','pending_t0','pending_t1','resolved','disputed','re_resolved','rejected')),
    rationale         TEXT,
    strategy_tag      TEXT,
    schema_version    INTEGER NOT NULL,
    scoring_version   INTEGER NOT NULL,
    dedup_key         TEXT NOT NULL,
    privacy_mode      TEXT,
    commit_hash       TEXT,
    commit_scheme     TEXT,
    market_id         TEXT,
    market_config_version INTEGER,
    prediction_value  TEXT,
    prediction_low    TEXT,
    prediction_high   TEXT,
    round_id          TEXT,
    UNIQUE(agent_id, client_order_id),
    UNIQUE(dedup_key)
  );

  INSERT INTO submissions_v3 (
    call_id, agent_id, client_order_id, asset_id, side,
    horizon_hours, horizon_seconds,
    confidence, submitted_at, accepted_at, status,
    rationale, strategy_tag, schema_version, scoring_version, dedup_key,
    privacy_mode, commit_hash, commit_scheme,
    market_id, market_config_version,
    prediction_value, prediction_low, prediction_high, round_id
  )
  SELECT
    call_id, agent_id, client_order_id, asset_id, side,
    horizon_hours, horizon_hours * 3600,
    confidence, submitted_at, accepted_at, status,
    rationale, strategy_tag, schema_version, scoring_version, dedup_key,
    privacy_mode, commit_hash, commit_scheme,
    market_id, market_config_version,
    prediction_value, prediction_low, prediction_high, round_id
  FROM submissions;

  DROP TABLE submissions;
  ALTER TABLE submissions_v3 RENAME TO submissions;

  CREATE INDEX idx_submissions_agent ON submissions(agent_id);
  CREATE INDEX idx_submissions_status ON submissions(status);
  CREATE INDEX idx_submissions_asset_horizon ON submissions(asset_id, horizon_hours);
  CREATE INDEX idx_submissions_commit_hash ON submissions(commit_hash) WHERE commit_hash IS NOT NULL;
  CREATE INDEX idx_submissions_privacy_mode ON submissions(privacy_mode);
  CREATE INDEX idx_submissions_market ON submissions(market_id) WHERE market_id IS NOT NULL;
  CREATE INDEX idx_submissions_round ON submissions(round_id) WHERE round_id IS NOT NULL;
`;

// ─── Migration 011 — oracle_policies fallback columns nullable ─────────────
//
// Phase 2d unlock: sub-hour markets are Pyth-only (Codex audit — Chainlink
// Base heartbeat is too coarse for 5m/15m horizons). T0PolicySchema now
// permits omitted fallback fields, but the per-call oracle_policies row
// still has fallback_feed + fallback_max_staleness_sec NOT NULL from
// migration 001. Rebuild the table to allow NULLs, preserving every
// existing row's data byte-identically (all hour-aligned ETH calls have
// real fallback values; the relaxation only matters for new sub-hour
// calls).
//
// Same FK-cascade pattern as migrations 005 + 010: PRAGMA foreign_keys
// off, copy, drop, rename, indexes, on. oracle_policies has no
// dependent tables that reference IT (only submissions has dependents),
// so this is a clean rebuild.
const MIGRATION_011 = `
  -- Same atomicity discipline as 010: idempotent retry guard, JS-side
  -- PRAGMA + transaction wrapper.
  DROP TABLE IF EXISTS oracle_policies_v2;

  CREATE TABLE oracle_policies_v2 (
    call_id                       TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    primary_feed                  TEXT NOT NULL,
    fallback_feed                 TEXT,
    primary_max_staleness_sec     INTEGER NOT NULL,
    fallback_max_staleness_sec    INTEGER,
    t0_grace_seconds              INTEGER NOT NULL,
    t0_extended_grace_seconds     INTEGER NOT NULL
  );

  INSERT INTO oracle_policies_v2 (
    call_id, primary_feed, fallback_feed,
    primary_max_staleness_sec, fallback_max_staleness_sec,
    t0_grace_seconds, t0_extended_grace_seconds
  )
  SELECT
    call_id, primary_feed, fallback_feed,
    primary_max_staleness_sec, fallback_max_staleness_sec,
    t0_grace_seconds, t0_extended_grace_seconds
  FROM oracle_policies;

  DROP TABLE oracle_policies;
  ALTER TABLE oracle_policies_v2 RENAME TO oracle_policies;
`;

// ─── Migration 005 — wallet binding + wallet_only tier + claim indexes ──────
//
// Three things at once:
//   1. agents gains `wallet_address` + `chain_id` as top-level columns so
//      receipt subjects can canonicalize wallet-bound, off-Murmur-verifiable
//      reputation (pillar 4) without a verified_identities join on every
//      receipt build.
//   2. agents.kind enum extended to include `wallet_only` — agents that
//      self-registered via /claim/wallet-only and proved control of a wallet
//      but have no public X/Telegram identity. SQLite CHECK constraints
//      can't be ALTERed in place, so we rebuild the agents table.
//   3. claim_challenges gains supporting indexes for (status, expires_at)
//      GC and (target_kind, target_value, status) lookups; abuse forensics
//      now has the right shape.
//
// Foreign keys from submissions/verified_identities/usage_events all point
// AT agents — we toggle FK enforcement off for the rebuild and back on
// after rename. None of those tables hold FK references INTO the agents
// rebuild that need recreation.
const MIGRATION_005 = `
  PRAGMA foreign_keys = OFF;

  CREATE TABLE agents_v2 (
    agent_id        TEXT PRIMARY KEY,
    display_slug    TEXT UNIQUE NOT NULL COLLATE NOCASE,
    kind            TEXT NOT NULL CHECK (kind IN ('benchmark','shadow','verified','internal_test','wallet_only')),
    display_name    TEXT NOT NULL,
    bio             TEXT,
    created_at      TEXT NOT NULL,
    api_key_hash    TEXT,
    wallet_address  TEXT,
    chain_id        TEXT
  );
  INSERT INTO agents_v2 (agent_id, display_slug, kind, display_name, bio, created_at, api_key_hash)
    SELECT agent_id, display_slug, kind, display_name, bio, created_at, api_key_hash FROM agents;
  DROP TABLE agents;
  ALTER TABLE agents_v2 RENAME TO agents;
  CREATE INDEX idx_agents_kind ON agents(kind);
  CREATE INDEX idx_agents_wallet ON agents(wallet_address) WHERE wallet_address IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_claim_challenges_status_expires
    ON claim_challenges(status, expires_at);
  CREATE INDEX IF NOT EXISTS idx_claim_challenges_target
    ON claim_challenges(target_kind, target_value, status);

  PRAGMA foreign_keys = ON;
`;

// ─── Repositories (typed, narrow) ────────────────────────────────────────────
//
// Each repository exposes the smallest API the rest of the system needs.
// Statements are prepared lazily via the WeakMap per Database instance.

type Stmt = Database.Statement<unknown[]>;
type StmtCache = Map<string, Stmt>;
const stmtCaches = new WeakMap<Database.Database, StmtCache>();

function prep(db: Database.Database, sql: string): Stmt {
  let cache = stmtCaches.get(db);
  if (!cache) {
    cache = new Map();
    stmtCaches.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export interface AgentRow extends AgentProfile {
  api_key_hash: string | null;
}

export const agentsRepo = {
  insert(
    db: Database.Database,
    profile: AgentProfile,
    api_key_hash: string | null = null,
  ): void {
    prep(
      db,
      `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at, api_key_hash, wallet_address, chain_id)
       VALUES (@agent_id, @display_slug, @kind, @display_name, @bio, @created_at, @api_key_hash, @wallet_address, @chain_id)`,
    ).run({
      agent_id: profile.agent_id,
      display_slug: profile.display_slug,
      kind: profile.kind,
      display_name: profile.display_name,
      bio: profile.bio ?? null,
      created_at: profile.created_at,
      api_key_hash,
      wallet_address: profile.wallet_address ?? null,
      chain_id: profile.chain_id ?? null,
    });
    for (const id of profile.verified_identities) {
      verifiedIdentitiesRepo.insert(db, profile.agent_id, id);
    }
  },

  byId(db: Database.Database, agent_id: string): AgentRow | null {
    const row = prep(
      db,
      "SELECT * FROM agents WHERE agent_id = ?",
    ).get(agent_id) as RawAgentRow | undefined;
    return row ? hydrateAgent(db, row) : null;
  },

  bySlug(db: Database.Database, slug: string): AgentRow | null {
    const row = prep(
      db,
      "SELECT * FROM agents WHERE display_slug = ? COLLATE NOCASE",
    ).get(slug) as RawAgentRow | undefined;
    return row ? hydrateAgent(db, row) : null;
  },

  setKind(db: Database.Database, agent_id: string, kind: AgentKind): void {
    prep(
      db,
      "UPDATE agents SET kind = ? WHERE agent_id = ?",
    ).run(kind, agent_id);
  },

  setApiKeyHash(
    db: Database.Database,
    agent_id: string,
    api_key_hash: string,
  ): void {
    prep(
      db,
      "UPDATE agents SET api_key_hash = ? WHERE agent_id = ?",
    ).run(api_key_hash, agent_id);
  },

  /**
   * Bind a wallet to an agent. Idempotent — re-running with the same values
   * is a no-op. The wallet is expected to be lowercase-normalized (viem's
   * getAddress(addr).toLowerCase()) by the caller; the schema check enforces
   * the lowercase form.
   */
  setWallet(
    db: Database.Database,
    agent_id: string,
    wallet_address: string,
    chain_id: string,
  ): void {
    prep(
      db,
      "UPDATE agents SET wallet_address = ?, chain_id = ? WHERE agent_id = ?",
    ).run(wallet_address, chain_id, agent_id);
  },

  /**
   * Lookup by wallet (lowercase + chain_id) — useful for the upgrade path
   * where a wallet-only agent later wants to verify a public X identity
   * and we need to find the existing agent_id.
   */
  byWallet(
    db: Database.Database,
    wallet_address: string,
    chain_id: string,
  ): AgentRow | null {
    const row = prep(
      db,
      "SELECT * FROM agents WHERE wallet_address = ? AND chain_id = ?",
    ).get(wallet_address, chain_id) as RawAgentRow | undefined;
    return row ? hydrateAgent(db, row) : null;
  },

  countActiveCallsForAgent(db: Database.Database, agent_id: string): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM submissions
       WHERE agent_id = ? AND status IN ('accepted','pending_t0','pending_t1')`,
    ).get(agent_id) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  listByKind(
    db: Database.Database,
    kind: AgentKind,
    limit = 100,
  ): Array<Pick<AgentRow, "agent_id" | "display_slug" | "display_name" | "kind" | "bio" | "created_at" | "verified_identities">> {
    const rows = prep(
      db,
      `SELECT agent_id, display_slug, display_name, kind, bio, created_at
       FROM agents
       WHERE kind = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(kind, limit) as Array<RawAgentRow>;
    return rows.map((r) => {
      const hyd = hydrateAgent(db, r);
      return {
        agent_id: hyd.agent_id,
        display_slug: hyd.display_slug,
        display_name: hyd.display_name,
        kind: hyd.kind,
        bio: hyd.bio,
        created_at: hyd.created_at,
        verified_identities: hyd.verified_identities,
      };
    });
  },
};

interface RawAgentRow {
  agent_id: string;
  display_slug: string;
  kind: AgentKind;
  display_name: string;
  bio: string | null;
  created_at: string;
  api_key_hash: string | null;
  wallet_address: string | null;
  chain_id: string | null;
}

function hydrateAgent(db: Database.Database, row: RawAgentRow): AgentRow {
  const ids = verifiedIdentitiesRepo.listForAgent(db, row.agent_id);
  return {
    agent_id: row.agent_id,
    display_slug: row.display_slug,
    kind: row.kind,
    display_name: row.display_name,
    bio: row.bio ?? undefined,
    created_at: row.created_at,
    verified_identities: ids,
    api_key_hash: row.api_key_hash,
    ...(row.wallet_address ? { wallet_address: row.wallet_address } : {}),
    ...(row.chain_id ? { chain_id: row.chain_id } : {}),
  };
}

// ─── Verified identities ─────────────────────────────────────────────────────

export const verifiedIdentitiesRepo = {
  insert(
    db: Database.Database,
    agent_id: string,
    identity: VerifiedIdentity,
  ): void {
    prep(
      db,
      `INSERT INTO verified_identities (agent_id, kind, value, verified_at)
       VALUES (?, ?, ?, ?)`,
    ).run(agent_id, identity.kind, identity.value, identity.verified_at);
  },

  listForAgent(db: Database.Database, agent_id: string): VerifiedIdentity[] {
    const rows = prep(
      db,
      "SELECT kind, value, verified_at FROM verified_identities WHERE agent_id = ? ORDER BY verified_at",
    ).all(agent_id) as VerifiedIdentity[];
    return rows;
  },

  findByExternal(
    db: Database.Database,
    kind: VerifiedIdentity["kind"],
    value: string,
  ): { agent_id: string } | null {
    const row = prep(
      db,
      "SELECT agent_id FROM verified_identities WHERE kind = ? AND value = ?",
    ).get(kind, value) as { agent_id: string } | undefined;
    return row ?? null;
  },
};

// ─── Submissions / Acceptances ───────────────────────────────────────────────

export interface AcceptanceWriteInput {
  submission: SubmittedCall;
  accepted: AcceptedCall;
  receipt: {
    hash: `0x${string}`;
    canonical_json: string;
    filecoin_cid?: string;
  };
  dedup_key: string;
  /**
   * P2 committed-mode metadata. When `privacy_mode='committed'`, the
   * caller MUST also pass `commit_hash` (the daemon-computed keccak of
   * the canonical preimage) and `envelope` (the age-encrypted body).
   * The transaction writes them atomically alongside the submission row.
   */
  privacy_mode?: string;
  commit_hash?: string;
  commit_scheme?: string;
  /** P3 — market registry stamps. Both nullable for legacy plaintext flows
   *  that haven't been backfilled (migration 009 covers ETH; future assets
   *  populate at submit time). */
  market_id?: string;
  market_config_version?: number;
  /** P3 Phase 2c — canonical horizon. Caller stamps from
   *  market.horizon_seconds. Optional in this interface so legacy callers
   *  that haven't migrated still work; the repo derives from
   *  horizon_hours * 3600 when absent. */
  horizon_seconds?: number;
  envelope?: {
    encrypted_body: string;
    encrypted_body_alg: string;
    encrypted_body_hash: string;
    daemon_key_id: string;
    commit_preimage_schema: string;
    fallback_after: string | null;
    received_at: string;
    // Optional drand/tlock parallel envelope (Phase B-3). When present,
    // the v2 acceptance receipt also carries a `drand` block so a
    // verifier can attest the daemon committed to a specific drand
    // round at acceptance time.
    drand_chain_hash?: string;
    drand_round?: number;
    drand_ciphertext?: string;
    drand_ciphertext_hash?: string;
  };
}

export const submissionsRepo = {
  /** Inserts submission + preflight + oracle policy + acceptance receipt atomically. */
  acceptCall(db: Database.Database, input: AcceptanceWriteInput): void {
    const tx = db.transaction((i: AcceptanceWriteInput) => {
      prep(
        db,
        `INSERT INTO submissions
         (call_id, agent_id, client_order_id, asset_id, side,
          horizon_hours, horizon_seconds,
          confidence, submitted_at, accepted_at, status, rationale, strategy_tag,
          schema_version, scoring_version, dedup_key,
          privacy_mode, commit_hash, commit_scheme,
          market_id, market_config_version)
         VALUES (@call_id, @agent_id, @client_order_id, @asset_id, @side,
          @horizon_hours, @horizon_seconds,
          @confidence, @submitted_at, @accepted_at, @status, @rationale, @strategy_tag,
          @schema_version, @scoring_version, @dedup_key,
          @privacy_mode, @commit_hash, @commit_scheme,
          @market_id, @market_config_version)`,
      ).run({
        call_id: i.accepted.call_id,
        agent_id: i.accepted.agent_id,
        client_order_id: i.accepted.client_order_id,
        asset_id: i.accepted.asset_id,
        side: i.accepted.side,
        horizon_hours: i.accepted.horizon_hours,
        // P3 Phase 2c: horizon_seconds is the canonical horizon. Caller
        // (submitCall) passes it from market.horizon_seconds at acceptance;
        // for legacy code paths that pre-date Phase 2c, fall back to
        // horizon_hours * 3600 (always integer for the four legacy ETH
        // horizons, so byte-stable).
        horizon_seconds:
          i.horizon_seconds ?? i.accepted.horizon_hours * 3600,
        confidence: i.accepted.confidence,
        submitted_at: i.accepted.submitted_at,
        accepted_at: i.accepted.accepted_at,
        status: "accepted" satisfies CallStatus,
        rationale: i.accepted.rationale ?? null,
        strategy_tag: i.accepted.strategy_tag ?? null,
        schema_version: i.accepted.schema_version,
        scoring_version: i.accepted.scoring_version,
        dedup_key: i.dedup_key,
        privacy_mode: i.privacy_mode ?? "legacy_plaintext",
        commit_hash: i.commit_hash ?? null,
        commit_scheme: i.commit_scheme ?? null,
        market_id: i.market_id ?? null,
        market_config_version: i.market_config_version ?? null,
      });
      prep(
        db,
        `INSERT INTO preflights
         (call_id, murmur_score, murmur_playbook, risk_flags_json, data_freshness_seconds, market_regime)
         VALUES (@call_id, @murmur_score, @murmur_playbook, @risk_flags_json, @data_freshness_seconds, @market_regime)`,
      ).run({
        call_id: i.accepted.call_id,
        murmur_score: i.accepted.preflight.murmur_score,
        murmur_playbook: i.accepted.preflight.murmur_playbook,
        risk_flags_json: JSON.stringify(i.accepted.preflight.risk_flags),
        data_freshness_seconds: i.accepted.preflight.data_freshness_seconds,
        market_regime: i.accepted.preflight.market_regime,
      });
      prep(
        db,
        `INSERT INTO oracle_policies
         (call_id, primary_feed, fallback_feed, primary_max_staleness_sec,
          fallback_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds)
         VALUES (@call_id, @primary_feed, @fallback_feed, @primary_max_staleness_sec,
          @fallback_max_staleness_sec, @t0_grace_seconds, @t0_extended_grace_seconds)`,
      ).run({
        call_id: i.accepted.call_id,
        primary_feed: i.accepted.oracle_policy.primary_feed,
        // Phase 2d: nullable fallback for sub-hour Pyth-only markets.
        fallback_feed: i.accepted.oracle_policy.fallback_feed ?? null,
        primary_max_staleness_sec:
          i.accepted.oracle_policy.primary_max_staleness_sec,
        fallback_max_staleness_sec:
          i.accepted.oracle_policy.fallback_max_staleness_sec ?? null,
        t0_grace_seconds: i.accepted.oracle_policy.t0_grace_seconds,
        t0_extended_grace_seconds:
          i.accepted.oracle_policy.t0_extended_grace_seconds,
      });
      prep(
        db,
        `INSERT INTO receipts
         (receipt_hash, call_id, kind, canonical_json, filecoin_cid, previous_hash, created_at)
         VALUES (?, ?, 'acceptance', ?, ?, NULL, ?)`,
      ).run(
        i.receipt.hash,
        i.accepted.call_id,
        i.receipt.canonical_json,
        i.receipt.filecoin_cid ?? null,
        i.accepted.accepted_at,
      );
      // P2 committed-mode: persist the age-encrypted body alongside
      // the submission row in the same transaction. The plaintext is
      // STILL written to submissions today (Phase E will scrub public
      // surfaces, Phase E-cleanup will null the plaintext columns) —
      // for now the envelope is what receipts and reveals attest to.
      if (i.envelope) {
        prep(
          db,
          `INSERT INTO call_private_envelopes
           (call_id, encrypted_body, encrypted_body_alg, encrypted_body_hash,
            daemon_key_id, commit_preimage_schema, fallback_after, received_at,
            drand_chain_hash, drand_round, drand_ciphertext, drand_ciphertext_hash)
           VALUES (@call_id, @encrypted_body, @encrypted_body_alg, @encrypted_body_hash,
                   @daemon_key_id, @commit_preimage_schema, @fallback_after, @received_at,
                   @drand_chain_hash, @drand_round, @drand_ciphertext, @drand_ciphertext_hash)`,
        ).run({
          call_id: i.accepted.call_id,
          encrypted_body: i.envelope.encrypted_body,
          encrypted_body_alg: i.envelope.encrypted_body_alg,
          encrypted_body_hash: i.envelope.encrypted_body_hash,
          daemon_key_id: i.envelope.daemon_key_id,
          commit_preimage_schema: i.envelope.commit_preimage_schema,
          fallback_after: i.envelope.fallback_after,
          received_at: i.envelope.received_at,
          drand_chain_hash: i.envelope.drand_chain_hash ?? null,
          drand_round: i.envelope.drand_round ?? null,
          drand_ciphertext: i.envelope.drand_ciphertext ?? null,
          drand_ciphertext_hash: i.envelope.drand_ciphertext_hash ?? null,
        });
      }
    });
    tx(input);
  },

  findByClientOrderId(
    db: Database.Database,
    agent_id: string,
    client_order_id: string,
  ): { call_id: string } | null {
    const row = prep(
      db,
      "SELECT call_id FROM submissions WHERE agent_id = ? AND client_order_id = ?",
    ).get(agent_id, client_order_id) as { call_id: string } | undefined;
    return row ?? null;
  },

  findByDedupKey(
    db: Database.Database,
    dedup_key: string,
  ): { call_id: string } | null {
    const row = prep(
      db,
      "SELECT call_id FROM submissions WHERE dedup_key = ?",
    ).get(dedup_key) as { call_id: string } | undefined;
    return row ?? null;
  },

  /**
   * Per-asset rolling 24h count. P3 Phase 1.5 (Codex audit): bound to
   * `accepted_at`, NOT `submitted_at`. Agent-supplied submitted_at is
   * untrusted — an agent could otherwise stamp a future timestamp to slip
   * the cap. The new per-market counter (countCallsForAgentMarketWindow)
   * already used accepted_at; this brings the per-asset counter in line.
   */
  countCallsForAgentAssetWindow(
    db: Database.Database,
    agent_id: string,
    asset_id: string,
    sinceIso: string,
  ): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM submissions
       WHERE agent_id = ? AND asset_id = ? AND accepted_at >= ?`,
    ).get(agent_id, asset_id, sinceIso) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  /**
   * P3 D3: per-market rolling 24h count. Bound to accepted_at (server
   * stamp), not submitted_at, so an agent can't backdate to slip past
   * the cap. Includes legacy rows backfilled by migration 009.
   */
  countCallsForAgentMarketWindow(
    db: Database.Database,
    agent_id: string,
    market_id: string,
    sinceIso: string,
  ): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM submissions
       WHERE agent_id = ? AND market_id = ? AND accepted_at >= ?`,
    ).get(agent_id, market_id, sinceIso) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  setStatus(
    db: Database.Database,
    call_id: string,
    status: CallStatus,
  ): void {
    prep(
      db,
      "UPDATE submissions SET status = ? WHERE call_id = ?",
    ).run(status, call_id);
  },

  listPending(
    db: Database.Database,
    status: Extract<CallStatus, "accepted" | "pending_t0" | "pending_t1">,
  ): Array<{
    call_id: string;
    agent_id: string;
    asset_id: string;
    side: "BUY" | "SELL";
    horizon_hours: number;
    confidence: number;
    accepted_at: string;
  }> {
    return prep(
      db,
      `SELECT call_id, agent_id, asset_id, side, horizon_hours, confidence, accepted_at
       FROM submissions
       WHERE status = ?
       ORDER BY accepted_at`,
    ).all(status) as Array<{
      call_id: string;
      agent_id: string;
      asset_id: string;
      side: "BUY" | "SELL";
      horizon_hours: number;
      confidence: number;
      accepted_at: string;
    }>;
  },

  /** Hydrated row used by the resolver when working a call. */
  loadResolverContext(
    db: Database.Database,
    call_id: string,
  ): {
    call_id: string;
    agent_id: string;
    asset_id: string;
    side: "BUY" | "SELL";
    horizon_hours: number;
    horizon_seconds: number;
    confidence: number;
    accepted_at: string;
    status: CallStatus;
    privacy_mode: string | null;
    commit_hash: string | null;
    acceptance_receipt_hash: string;
    primary_feed: string;
    fallback_feed: string | null;
    primary_max_staleness_sec: number;
    fallback_max_staleness_sec: number | null;
    t0_grace_seconds: number;
    t0_extended_grace_seconds: number;
  } | null {
    return (
      (prep(
        db,
        `SELECT s.call_id, s.agent_id, s.asset_id, s.side,
                s.horizon_hours, s.horizon_seconds,
                s.confidence, s.accepted_at, s.status, s.privacy_mode, s.commit_hash,
                r.receipt_hash AS acceptance_receipt_hash,
                op.primary_feed, op.fallback_feed,
                op.primary_max_staleness_sec, op.fallback_max_staleness_sec,
                op.t0_grace_seconds, op.t0_extended_grace_seconds
         FROM submissions s
         JOIN oracle_policies op ON op.call_id = s.call_id
         JOIN receipts r ON r.call_id = s.call_id AND r.kind = 'acceptance'
         WHERE s.call_id = ?`,
      ).get(call_id) as
        | {
            call_id: string;
            agent_id: string;
            asset_id: string;
            side: "BUY" | "SELL";
            horizon_hours: number;
            horizon_seconds: number;
            confidence: number;
            accepted_at: string;
            status: CallStatus;
            privacy_mode: string | null;
            commit_hash: string | null;
            acceptance_receipt_hash: string;
            primary_feed: string;
            // Phase 2d: nullable for sub-hour markets (Pyth-only).
            fallback_feed: string | null;
            primary_max_staleness_sec: number;
            fallback_max_staleness_sec: number | null;
            t0_grace_seconds: number;
            t0_extended_grace_seconds: number;
          }
        | undefined) ?? null
    );
  },
};

// ─── Anchors / resolutions ───────────────────────────────────────────────────

export const anchorsRepo = {
  setT0(
    db: Database.Database,
    input: {
      call_id: string;
      t0: string;
      p0: string;
      feed: string;
      source_id: string;
      anchored_at: string;
    },
  ): void {
    prep(
      db,
      `INSERT INTO t0_anchors (call_id, t0, p0, feed, source_id, anchored_at)
       VALUES (@call_id, @t0, @p0, @feed, @source_id, @anchored_at)
       ON CONFLICT(call_id) DO UPDATE SET
         t0 = excluded.t0, p0 = excluded.p0, feed = excluded.feed,
         source_id = excluded.source_id, anchored_at = excluded.anchored_at`,
    ).run(input);
  },

  getT0(
    db: Database.Database,
    call_id: string,
  ): {
    t0: string;
    p0: string;
    feed: string;
    source_id: string;
    anchored_at: string;
  } | null {
    return (
      (prep(
        db,
        "SELECT t0, p0, feed, source_id, anchored_at FROM t0_anchors WHERE call_id = ?",
      ).get(call_id) as
        | {
            t0: string;
            p0: string;
            feed: string;
            source_id: string;
            anchored_at: string;
          }
        | undefined) ?? null
    );
  },
};

export const resolutionsRepo = {
  setResolution(
    db: Database.Database,
    input: {
      call_id: string;
      t1: string;
      p1: string;
      t1_feed: string;
      signed_return: string;
      outcome: Outcome;
      call_score: number | null;
      resolved_at: string;
    },
  ): void {
    prep(
      db,
      `INSERT INTO t1_resolutions
       (call_id, t1, p1, t1_feed, signed_return, outcome, call_score, resolved_at)
       VALUES (@call_id, @t1, @p1, @t1_feed, @signed_return, @outcome, @call_score, @resolved_at)
       ON CONFLICT(call_id) DO UPDATE SET
         t1 = excluded.t1, p1 = excluded.p1, t1_feed = excluded.t1_feed,
         signed_return = excluded.signed_return, outcome = excluded.outcome,
         call_score = excluded.call_score, resolved_at = excluded.resolved_at`,
    ).run(input);
  },

  loadFullCall(
    db: Database.Database,
    call_id: string,
  ): {
    submission: {
      call_id: string;
      agent_id: string;
      client_order_id: string;
      asset_id: string;
      side: "BUY" | "SELL";
      horizon_hours: number;
      confidence: number;
      submitted_at: string;
      accepted_at: string;
      status: CallStatus;
      rationale: string | null;
      strategy_tag: string | null;
    };
    preflight: {
      murmur_score: number;
      murmur_playbook: string;
      risk_flags: string[];
      data_freshness_seconds: number;
      market_regime: string;
    };
    acceptance_receipt: {
      hash: string;
      filecoin_cid: string | null;
    };
    t0: { t0: string; p0: string; feed: string } | null;
    resolution:
      | {
          t1: string;
          p1: string;
          t1_feed: string;
          signed_return: string;
          outcome: string;
          call_score: number | null;
          resolved_at: string;
          receipt_hash: string;
          filecoin_cid: string | null;
        }
      | null;
  } | null {
    const subRow = prep(
      db,
      `SELECT s.*, p.murmur_score, p.murmur_playbook, p.risk_flags_json,
              p.data_freshness_seconds, p.market_regime,
              ar.receipt_hash AS acceptance_hash, ar.filecoin_cid AS acceptance_cid
       FROM submissions s
       JOIN preflights p ON p.call_id = s.call_id
       LEFT JOIN receipts ar ON ar.call_id = s.call_id AND ar.kind = 'acceptance'
       WHERE s.call_id = ?`,
    ).get(call_id) as Record<string, unknown> | undefined;
    if (!subRow) return null;
    const t0Row = prep(
      db,
      "SELECT t0, p0, feed FROM t0_anchors WHERE call_id = ?",
    ).get(call_id) as { t0: string; p0: string; feed: string } | undefined;
    const resRow = prep(
      db,
      `SELECT r.*, rec.receipt_hash AS resolution_hash, rec.filecoin_cid AS resolution_cid
       FROM t1_resolutions r
       LEFT JOIN receipts rec ON rec.call_id = r.call_id AND rec.kind IN ('resolution','re_resolution')
       WHERE r.call_id = ?
       ORDER BY rec.created_at DESC
       LIMIT 1`,
    ).get(call_id) as Record<string, unknown> | undefined;
    return {
      submission: {
        call_id: subRow.call_id as string,
        agent_id: subRow.agent_id as string,
        client_order_id: subRow.client_order_id as string,
        asset_id: subRow.asset_id as string,
        side: subRow.side as "BUY" | "SELL",
        horizon_hours: subRow.horizon_hours as number,
        confidence: subRow.confidence as number,
        submitted_at: subRow.submitted_at as string,
        accepted_at: subRow.accepted_at as string,
        status: subRow.status as CallStatus,
        rationale: (subRow.rationale as string) ?? null,
        strategy_tag: (subRow.strategy_tag as string) ?? null,
      },
      preflight: {
        murmur_score: subRow.murmur_score as number,
        murmur_playbook: subRow.murmur_playbook as string,
        risk_flags: JSON.parse(subRow.risk_flags_json as string),
        data_freshness_seconds: subRow.data_freshness_seconds as number,
        market_regime: subRow.market_regime as string,
      },
      acceptance_receipt: {
        hash: subRow.acceptance_hash as string,
        filecoin_cid: (subRow.acceptance_cid as string) ?? null,
      },
      t0: t0Row ?? null,
      resolution: resRow
        ? {
            t1: resRow.t1 as string,
            p1: resRow.p1 as string,
            t1_feed: resRow.t1_feed as string,
            signed_return: resRow.signed_return as string,
            outcome: resRow.outcome as string,
            call_score: (resRow.call_score as number | null) ?? null,
            resolved_at: resRow.resolved_at as string,
            receipt_hash: resRow.resolution_hash as string,
            filecoin_cid: (resRow.resolution_cid as string) ?? null,
          }
        : null,
    };
  },

  recordResolutionReceipt(
    db: Database.Database,
    input: {
      receipt_hash: `0x${string}`;
      call_id: string;
      canonical_json: string;
      filecoin_cid?: string;
      previous_hash: `0x${string}`;
      created_at: string;
      kind: "resolution" | "re_resolution";
    },
  ): void {
    prep(
      db,
      `INSERT INTO receipts
       (receipt_hash, call_id, kind, canonical_json, filecoin_cid, previous_hash, created_at)
       VALUES (@receipt_hash, @call_id, @kind, @canonical_json, @filecoin_cid, @previous_hash, @created_at)`,
    ).run({
      ...input,
      filecoin_cid: input.filecoin_cid ?? null,
    });
  },
};

// ─── Privacy: encrypted call envelopes ──────────────────────────────────────
//
// One row per `committed`-mode submission. Carries the daemon-encrypted
// body that the resolver decrypts at t1+grace IF the agent fails to reveal
// voluntarily. Empty until Phase B writes to it.

export interface CallPrivateEnvelopeRow {
  call_id: string;
  encrypted_body: string;
  encrypted_body_alg: string;
  encrypted_body_hash: string;
  daemon_key_id: string;
  commit_preimage_schema: string;
  fallback_after: string | null;
  received_at: string;
  // Phase B-3: optional parallel drand/tlock envelope (D21).
  drand_chain_hash?: string | null;
  drand_round?: number | null;
  drand_ciphertext?: string | null;
  drand_ciphertext_hash?: string | null;
}

export const callPrivateEnvelopesRepo = {
  insert(db: Database.Database, row: CallPrivateEnvelopeRow): void {
    prep(
      db,
      `INSERT INTO call_private_envelopes
       (call_id, encrypted_body, encrypted_body_alg, encrypted_body_hash,
        daemon_key_id, commit_preimage_schema, fallback_after, received_at,
        drand_chain_hash, drand_round, drand_ciphertext, drand_ciphertext_hash)
       VALUES (@call_id, @encrypted_body, @encrypted_body_alg, @encrypted_body_hash,
               @daemon_key_id, @commit_preimage_schema, @fallback_after, @received_at,
               @drand_chain_hash, @drand_round, @drand_ciphertext, @drand_ciphertext_hash)`,
    ).run({
      ...row,
      drand_chain_hash: row.drand_chain_hash ?? null,
      drand_round: row.drand_round ?? null,
      drand_ciphertext: row.drand_ciphertext ?? null,
      drand_ciphertext_hash: row.drand_ciphertext_hash ?? null,
    });
  },

  byCallId(db: Database.Database, call_id: string): CallPrivateEnvelopeRow | null {
    const row = prep(
      db,
      "SELECT * FROM call_private_envelopes WHERE call_id = ?",
    ).get(call_id) as CallPrivateEnvelopeRow | undefined;
    return row ?? null;
  },

  /**
   * Pending envelopes whose fallback window has closed and whose call
   * has NOT been revealed by the agent yet. Resolver iterates this list
   * to know which envelopes to daemon-decrypt.
   */
  listOverdueForFallback(
    db: Database.Database,
    nowIso: string,
  ): CallPrivateEnvelopeRow[] {
    return prep(
      db,
      `SELECT e.* FROM call_private_envelopes e
       LEFT JOIN call_reveals cr ON cr.call_id = e.call_id
       WHERE e.fallback_after IS NOT NULL
         AND e.fallback_after <= ?
         AND cr.call_id IS NULL`,
    ).all(nowIso) as CallPrivateEnvelopeRow[];
  },
};

// ─── Privacy: revealed call subjects ────────────────────────────────────────
//
// One row per call once the plaintext is known — either the agent revealed
// voluntarily (`revealed_via='agent'`), the daemon decrypted the fallback
// envelope past grace (`'daemon_fallback'`), the call was a v0.1
// pre-privacy submission whose plaintext is in `submissions` and was
// migrated here (`'legacy_plaintext'`), or v0.3 fhEVM compute produced
// a non-plaintext attestation (`'fhevm_compute'`).
//
// `revealed_via` and `reveal_hash_valid` are surfaced on the resolution
// receipt's `reveal` block so off-Murmur verifiers can attest the
// commit→reveal binding without trusting the daemon.

export interface CallRevealRow {
  call_id: string;
  side: "BUY" | "SELL";
  asset_id: string;
  horizon_hours: number;
  confidence: number;
  rationale: string | null;
  strategy_tag: string | null;
  salt: string | null;
  t0: string | null;
  agent_wallet: string | null;
  chain_id: string | null;
  commit_preimage_json: string | null;
  commit_preimage_hash: string | null;
  revealed_at: string;
  revealed_via:
    | "agent"
    | "daemon_fallback"
    | "drand_fallback"
    | "legacy_plaintext"
    | "fhevm_compute";
  reveal_hash_valid: 0 | 1;
}

export const callRevealsRepo = {
  insert(db: Database.Database, row: CallRevealRow): void {
    prep(
      db,
      `INSERT INTO call_reveals
       (call_id, side, asset_id, horizon_hours, confidence,
        rationale, strategy_tag, salt, t0, agent_wallet, chain_id,
        commit_preimage_json, commit_preimage_hash,
        revealed_at, revealed_via, reveal_hash_valid)
       VALUES (@call_id, @side, @asset_id, @horizon_hours, @confidence,
               @rationale, @strategy_tag, @salt, @t0, @agent_wallet, @chain_id,
               @commit_preimage_json, @commit_preimage_hash,
               @revealed_at, @revealed_via, @reveal_hash_valid)`,
    ).run(row);
  },

  byCallId(db: Database.Database, call_id: string): CallRevealRow | null {
    const row = prep(
      db,
      "SELECT * FROM call_reveals WHERE call_id = ?",
    ).get(call_id) as CallRevealRow | undefined;
    return row ?? null;
  },

  /**
   * Reveal-reliability counts per agent: (agent_reveals, fallback_reveals).
   * Excludes legacy_plaintext (v0.1 traffic) and fhevm_compute (v0.3) so
   * the metric reflects the agent's behavior under the v0.2 contract.
   */
  reliabilityByAgent(
    db: Database.Database,
  ): Array<{ agent_id: string; agent_reveals: number; daemon_reveals: number }> {
    return prep(
      db,
      `SELECT s.agent_id,
              SUM(CASE WHEN cr.revealed_via = 'agent' THEN 1 ELSE 0 END) AS agent_reveals,
              SUM(CASE WHEN cr.revealed_via IN ('daemon_fallback','drand_fallback') THEN 1 ELSE 0 END) AS daemon_reveals
       FROM submissions s
       JOIN call_reveals cr ON cr.call_id = s.call_id
       WHERE s.privacy_mode = 'committed'
         AND cr.revealed_via IN ('agent', 'daemon_fallback', 'drand_fallback')
       GROUP BY s.agent_id`,
    ).all() as Array<{ agent_id: string; agent_reveals: number; daemon_reveals: number }>;
  },
};

// ─── Disputes ────────────────────────────────────────────────────────────────

export const disputesRepo = {
  insert(db: Database.Database, dispute: Dispute): void {
    prep(
      db,
      `INSERT INTO disputes
       (dispute_id, target_resolution_receipt_hash, grounds, notes, filed_by, filed_at, status, resolved_at, new_resolution_receipt_hash)
       VALUES (@dispute_id, @target_resolution_receipt_hash, @grounds, @notes, @filed_by, @filed_at, @status, @resolved_at, @new_resolution_receipt_hash)`,
    ).run({
      ...dispute,
      notes: dispute.notes ?? null,
    });
  },

  setStatus(
    db: Database.Database,
    dispute_id: string,
    status: DisputeStatus,
    resolved_at: string | null = null,
    new_resolution_receipt_hash: string | null = null,
  ): void {
    prep(
      db,
      `UPDATE disputes
       SET status = ?, resolved_at = ?, new_resolution_receipt_hash = ?
       WHERE dispute_id = ?`,
    ).run(status, resolved_at, new_resolution_receipt_hash, dispute_id);
  },

  listOpen(db: Database.Database): Dispute[] {
    return prep(
      db,
      "SELECT * FROM disputes WHERE status IN ('open','replay_in_progress') ORDER BY filed_at",
    ).all() as Dispute[];
  },
};

// ─── Claim challenges ────────────────────────────────────────────────────────

export const claimsRepo = {
  insert(db: Database.Database, c: ClaimChallenge): void {
    prep(
      db,
      `INSERT INTO claim_challenges
       (challenge_id, agent_id, target_kind, target_value, nonce, challenge_text, wallet_to_bind, expires_at, status, created_at)
       VALUES (@challenge_id, @agent_id, @target_kind, @target_value, @nonce, @challenge_text, @wallet_to_bind, @expires_at, @status, @created_at)`,
    ).run({
      challenge_id: c.challenge_id,
      agent_id: c.agent_id,
      target_kind: c.target_identity.kind,
      target_value: c.target_identity.value,
      nonce: c.nonce,
      challenge_text: c.challenge_text,
      wallet_to_bind: c.wallet_to_bind,
      expires_at: c.expires_at,
      status: c.status,
      created_at: c.created_at,
    });
  },

  setStatus(
    db: Database.Database,
    challenge_id: string,
    status: ClaimChallenge["status"],
  ): void {
    prep(
      db,
      "UPDATE claim_challenges SET status = ? WHERE challenge_id = ?",
    ).run(status, challenge_id);
  },

  /**
   * Atomically transition a challenge from "pending" to `next` only when its
   * current status IS still pending. Returns true if the transition happened
   * (the caller now owns the challenge), false if some other concurrent
   * finalize already closed it. Use this BEFORE side-effects (issuing API
   * keys, flipping kind) so two parallel finalizes can't both succeed.
   */
  claimIfPending(
    db: Database.Database,
    challenge_id: string,
    next: Exclude<ClaimChallenge["status"], "pending">,
  ): boolean {
    const info = prep(
      db,
      "UPDATE claim_challenges SET status = ? WHERE challenge_id = ? AND status = 'pending'",
    ).run(next, challenge_id);
    return info.changes > 0;
  },

  /**
   * Count pending claim_challenges for a (wallet, slug) pair. Used by the
   * wallet-only init rate-limiter — one pending challenge per pair caps
   * the abuse vector where an attacker spams init for a slug they don't
   * actually own.
   */
  countPendingForWalletAndAgent(
    db: Database.Database,
    wallet: string,
    agent_id: string,
    nowIso: string,
  ): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM claim_challenges
       WHERE wallet_to_bind = ? AND agent_id = ?
         AND status = 'pending' AND expires_at > ?`,
    ).get(wallet, agent_id, nowIso) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  /**
   * GC sweep: mark expired-but-still-pending rows as expired, and delete
   * everything older than `keepSinceIso` regardless of status. Keeps
   * claim_challenges from becoming an infinite log.
   */
  gc(
    db: Database.Database,
    nowIso: string,
    keepSinceIso: string,
  ): { expired: number; deleted: number } {
    const expired = prep(
      db,
      `UPDATE claim_challenges SET status = 'expired'
       WHERE status = 'pending' AND expires_at <= ?`,
    ).run(nowIso).changes;
    const deleted = prep(
      db,
      `DELETE FROM claim_challenges
       WHERE status != 'pending' AND created_at < ?`,
    ).run(keepSinceIso).changes;
    return { expired, deleted };
  },
};

// ─── Usage events (rail; no fees in v0.1) ────────────────────────────────────

export const usageRepo = {
  emit(db: Database.Database, event: UsageEvent): void {
    prep(
      db,
      `INSERT INTO usage_events (event_id, agent_id, kind, ts, attributes_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      event.event_id,
      event.agent_id ?? null,
      event.kind,
      event.ts,
      JSON.stringify(event.attributes ?? {}),
    );
  },

  count24h(db: Database.Database, kind: UsageEventKind): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM usage_events
       WHERE kind = ? AND ts >= datetime('now', '-1 day')`,
    ).get(kind) as { n: number } | undefined;
    return row?.n ?? 0;
  },
};

// ─── Outreach attribution ────────────────────────────────────────────────────

export interface RefClickRow {
  ref: string;
  agent_slug: string | null;
  total: number;
  first_at: string;
  last_at: string;
  converted_count: number;
  last_conversion_at: string | null;
}

export const refsRepo = {
  /** Bump the (ref, agent_slug) counter. Creates the row on first hit. */
  bumpClick(
    db: Database.Database,
    ref: string,
    agent_slug: string | null,
    nowIso: string,
  ): void {
    prep(
      db,
      `INSERT INTO ref_clicks (ref, agent_slug, total, first_at, last_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(ref, agent_slug) DO UPDATE SET
         total = total + 1,
         last_at = excluded.last_at`,
    ).run(ref, agent_slug, nowIso, nowIso);
  },

  /** Top referrers for one agent (ordered by total desc). */
  discoverersForAgent(
    db: Database.Database,
    agent_slug: string,
    limit = 5,
  ): RefClickRow[] {
    return prep(
      db,
      `SELECT ref, agent_slug, total, first_at, last_at
       FROM ref_clicks
       WHERE agent_slug = ?
       ORDER BY total DESC, last_at DESC
       LIMIT ?`,
    ).all(agent_slug, limit) as RefClickRow[];
  },

  /** Full ref leaderboard (top senders across all agents). */
  topSenders(
    db: Database.Database,
    limit = 50,
  ): Array<{
    ref: string;
    total: number;
    agents_touched: number;
    converted: number;
    last_at: string;
  }> {
    return prep(
      db,
      `SELECT ref,
              SUM(total) AS total,
              SUM(converted_count) AS converted,
              COUNT(DISTINCT agent_slug) AS agents_touched,
              MAX(last_at) AS last_at
       FROM ref_clicks
       GROUP BY ref
       ORDER BY converted DESC, total DESC, last_at DESC
       LIMIT ?`,
    ).all(limit) as Array<{
      ref: string;
      total: number;
      agents_touched: number;
      converted: number;
      last_at: string;
    }>;
  },

  /**
   * Record a successful claim conversion against a (ref, agent_slug) bucket.
   * Required invariants:
   *   - the (ref, agent_slug) pair must already have at least one click
   *     recorded (otherwise we'd let any caller seed an arbitrary credit);
   *   - per-bucket counter is capped at 1 — claim/finalize is single-use
   *     per challenge_id, but we additionally clamp here to prevent
   *     double-credit if anyone ever wires this into a non-idempotent path.
   * Returns `true` only when the row transitioned from `converted_count=0`
   * to `converted_count=1`. Existing credits are left untouched.
   */
  bumpConversion(
    db: Database.Database,
    ref: string,
    agent_slug: string,
    nowIso: string,
  ): boolean {
    const info = prep(
      db,
      `UPDATE ref_clicks
       SET converted_count = 1,
           last_conversion_at = ?
       WHERE ref = ? AND agent_slug = ? AND converted_count = 0`,
    ).run(nowIso, ref, agent_slug);
    return info.changes > 0;
  },
};

// ─── Webhook subscriptions ───────────────────────────────────────────────────

export interface WebhookRow {
  id: string;
  agent_slug: string | null;
  url: string;
  secret: string;
  created_at: string;
  last_delivery_at: string | null;
  last_status: number | null;
  delivery_count: number;
  failure_count: number;
  disabled: number;
}

export const webhooksRepo = {
  insert(
    db: Database.Database,
    row: {
      id: string;
      agent_slug: string | null;
      url: string;
      secret: string;
      created_at: string;
    },
  ): void {
    prep(
      db,
      `INSERT INTO webhooks (id, agent_slug, url, secret, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.id, row.agent_slug, row.url, row.secret, row.created_at);
  },

  byId(db: Database.Database, id: string): WebhookRow | null {
    const row = prep(
      db,
      "SELECT * FROM webhooks WHERE id = ? LIMIT 1",
    ).get(id) as WebhookRow | undefined;
    return row ?? null;
  },

  /** Return active webhooks subscribed to a specific agent (or to all agents). */
  matchAgent(db: Database.Database, agent_slug: string): WebhookRow[] {
    return prep(
      db,
      `SELECT * FROM webhooks
       WHERE disabled = 0
         AND (agent_slug = ? OR agent_slug IS NULL)`,
    ).all(agent_slug) as WebhookRow[];
  },

  delete(db: Database.Database, id: string): boolean {
    const info = prep(
      db,
      "DELETE FROM webhooks WHERE id = ?",
    ).run(id);
    return info.changes > 0;
  },

  bumpDelivery(
    db: Database.Database,
    id: string,
    iso: string,
    status: number,
    failed: boolean,
  ): void {
    prep(
      db,
      `UPDATE webhooks
       SET last_delivery_at = ?,
           last_status = ?,
           delivery_count = delivery_count + 1,
           failure_count = failure_count + CASE WHEN ? THEN 1 ELSE 0 END
       WHERE id = ?`,
    ).run(iso, status, failed ? 1 : 0, id);
  },
};

// ─── Convenience: dedup_key builder ──────────────────────────────────────────

/**
 * Per the spec: dedup_key = (agent_id, asset_id, side, horizon_hours, t_bucket)
 * where t_bucket = floor(submitted_at, horizon_hours/4 hours).
 */
export function buildDedupKey(args: {
  agent_id: string;
  asset_id: string;
  side: "BUY" | "SELL";
  horizon_hours: number;
  submitted_at_iso: string;
}): string {
  const bucketHours = Math.max(1, args.horizon_hours / 4);
  const ms = Date.parse(args.submitted_at_iso);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid submitted_at_iso: ${args.submitted_at_iso}`);
  }
  const bucketMs = bucketHours * 3600 * 1000;
  const bucket = Math.floor(ms / bucketMs) * bucketMs;
  return `${args.agent_id}|${args.asset_id}|${args.side}|${args.horizon_hours}|${bucket}`;
}

// ─── Asset / Oracle / Market repos (registry-driven matrix) ─────────────────
//
// Read-mostly tables. Migration 008 seeds canonical rows; runtime usage is
// list/get + occasional admin upsert (CLI/HTTP later). Statements share the
// prep() cache. Status lifecycle: draft → listed → frozen → retired.

export type RegistryStatus = "draft" | "listed" | "frozen" | "retired";

export interface AssetRow {
  asset_id: string;
  display_short: string;
  display_name: string;
  native_chain: string;
  pyth_feed_id: string | null;
  chainlink_base_address: string | null;
  decimals_hint: number;
  status: RegistryStatus;
  notes: string | null;
  created_at: string;
}

export interface OracleRow {
  oracle_id: string;
  asset_id: string;
  kind: "chainlink_evm" | "pyth_pull" | "pyth_solana";
  adapter: string;
  chain: string;
  config_json: string;
  status: RegistryStatus;
  created_at: string;
}

export type MarketKind =
  | "direction_binary"
  | "price_point"
  | "price_bracket"
  | "depeg_threshold";

export type ScoringKind =
  | "brier_direction"
  | "rank_proximity_l1"
  | "bracket_hit"
  | "threshold_hit";

export interface MarketRow {
  market_id: string;
  asset_id: string;
  market_kind: MarketKind;
  horizon_seconds: number;
  primary_oracle_id: string;
  fallback_oracle_id: string | null;
  primary_max_staleness_sec: number;
  fallback_max_staleness_sec: number | null;
  t0_grace_seconds: number;
  t0_extended_grace_seconds: number;
  void_band: string;
  round_cadence_seconds: number | null;
  scoring_kind: ScoringKind;
  market_config_version: number;
  status: RegistryStatus;
  notes: string | null;
  created_at: string;
}

export const assetsRepo = {
  list(db: Database.Database, status?: RegistryStatus): AssetRow[] {
    const sql = status
      ? `SELECT * FROM assets WHERE status = ? ORDER BY display_short`
      : `SELECT * FROM assets ORDER BY display_short`;
    const stmt = prep(db, sql);
    return (status ? stmt.all(status) : stmt.all()) as AssetRow[];
  },

  get(db: Database.Database, asset_id: string): AssetRow | null {
    return (
      (prep(db, `SELECT * FROM assets WHERE asset_id = ?`).get(
        asset_id,
      ) as AssetRow | undefined) ?? null
    );
  },

  bySlug(db: Database.Database, display_short: string): AssetRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM assets WHERE display_short = ? COLLATE NOCASE`,
      ).get(display_short) as AssetRow | undefined) ?? null
    );
  },

  setStatus(
    db: Database.Database,
    asset_id: string,
    status: RegistryStatus,
  ): void {
    prep(db, `UPDATE assets SET status = ? WHERE asset_id = ?`).run(
      status,
      asset_id,
    );
  },
};

export const oraclesRepo = {
  list(db: Database.Database, status?: RegistryStatus): OracleRow[] {
    const sql = status
      ? `SELECT * FROM oracles WHERE status = ? ORDER BY oracle_id`
      : `SELECT * FROM oracles ORDER BY oracle_id`;
    const stmt = prep(db, sql);
    return (status ? stmt.all(status) : stmt.all()) as OracleRow[];
  },

  get(db: Database.Database, oracle_id: string): OracleRow | null {
    return (
      (prep(db, `SELECT * FROM oracles WHERE oracle_id = ?`).get(
        oracle_id,
      ) as OracleRow | undefined) ?? null
    );
  },

  listForAsset(db: Database.Database, asset_id: string): OracleRow[] {
    return prep(
      db,
      `SELECT * FROM oracles WHERE asset_id = ? ORDER BY oracle_id`,
    ).all(asset_id) as OracleRow[];
  },

  setStatus(
    db: Database.Database,
    oracle_id: string,
    status: RegistryStatus,
  ): void {
    prep(db, `UPDATE oracles SET status = ? WHERE oracle_id = ?`).run(
      status,
      oracle_id,
    );
  },
};

export const marketsRepo = {
  list(db: Database.Database, status?: RegistryStatus): MarketRow[] {
    const sql = status
      ? `SELECT * FROM markets WHERE status = ? ORDER BY asset_id, horizon_seconds`
      : `SELECT * FROM markets ORDER BY asset_id, horizon_seconds`;
    const stmt = prep(db, sql);
    return (status ? stmt.all(status) : stmt.all()) as MarketRow[];
  },

  listed(db: Database.Database): MarketRow[] {
    return this.list(db, "listed");
  },

  get(db: Database.Database, market_id: string): MarketRow | null {
    return (
      (prep(db, `SELECT * FROM markets WHERE market_id = ?`).get(
        market_id,
      ) as MarketRow | undefined) ?? null
    );
  },

  /**
   * Read-time helper for legacy submissions (market_id IS NULL): synthesize
   * a market_id from (asset_id, horizon_hours) so feed/leaderboard can join
   * unified rows. Mapping is:
   *   base:ETH:USD + 1h   → eth.1h
   *   base:ETH:USD + 4h   → eth.4h
   *   base:ETH:USD + 24h  → eth.24h
   *   base:ETH:USD + 168h → eth.7d
   * Returns null for unknown asset/horizon pairs (legacy never had these).
   */
  legacyIdFor(asset_id: string, horizon_hours: number): string | null {
    const horizonLabel = LEGACY_HORIZON_LABELS[horizon_hours];
    if (!horizonLabel) return null;
    const slug = LEGACY_ASSET_SHORT[asset_id];
    if (!slug) return null;
    return `${slug}.${horizonLabel}`;
  },

  setStatus(
    db: Database.Database,
    market_id: string,
    status: RegistryStatus,
  ): void {
    prep(db, `UPDATE markets SET status = ? WHERE market_id = ?`).run(
      status,
      market_id,
    );
  },

  /**
   * Update market_config_version + selected mutable policy fields atomically.
   * Bumps `market_config_version` so existing pending submissions stamped at
   * the prior version know they were resolved under different rules. Use
   * sparingly — the canonical answer for "this submission's policy" is the
   * version stamped on the submission, not the live row.
   */
  bumpConfig(
    db: Database.Database,
    market_id: string,
    patch: Partial<
      Pick<
        MarketRow,
        | "primary_oracle_id"
        | "fallback_oracle_id"
        | "primary_max_staleness_sec"
        | "fallback_max_staleness_sec"
        | "t0_grace_seconds"
        | "t0_extended_grace_seconds"
        | "void_band"
        | "scoring_kind"
        | "round_cadence_seconds"
      >
    >,
  ): void {
    const fields = Object.keys(patch).filter(
      (k) => (patch as Record<string, unknown>)[k] !== undefined,
    );
    if (fields.length === 0) return;
    const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
    prep(
      db,
      `UPDATE markets
       SET ${setClause}, market_config_version = market_config_version + 1
       WHERE market_id = @market_id`,
    ).run({ ...patch, market_id });
  },
};

const LEGACY_HORIZON_LABELS: Record<number, string> = {
  1: "1h",
  4: "4h",
  24: "24h",
  168: "7d",
};

const LEGACY_ASSET_SHORT: Record<string, string> = {
  "base:ETH:USD": "eth",
  "base:BTC:USD": "btc",
  "base:SOL:USD": "sol",
  "base:BNB:USD": "bnb",
};

// ─── Re-export ground type for migration knowledge ───────────────────────────

export const VERDICT_DB_SCHEMA_VERSION = 1 as const;

// ─── Friendly unique-violation parser ────────────────────────────────────────

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

// Suppress unused-import warning for DisputeGrounds (kept for downstream type
// re-exports and IDE hovers). — irrelevant since noUnusedLocals=false.
export type { DisputeGrounds };
