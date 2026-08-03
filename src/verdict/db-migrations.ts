import type Database from "better-sqlite3";

import { SCHEMA_VERSION, SCORING_VERSION } from "./schema.js";

export const LATEST_DB_MIGRATION_VERSION = 60 as const;

export function applyMigrations(db: Database.Database): void {
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

  if (v < 12) {
    // P4 Phase A — append-only market_config_history. No FK cascade,
    // no rebuild. Codex audit fix: wrap DDL + schema_meta bump in a
    // single transaction so a crash between them can't leave the table
    // created with schema_version still at 11 (next openDb would
    // re-run and fail on duplicate CREATE).
    db.transaction(() => {
      db.exec(MIGRATION_012);
      set.run("schema_version", "12");
    })();
    v = 12;
  }

  if (v < 13) {
    // V2 §7.5 — extend agents.kind enum to include the new tiered identity
    // values 'casual' and 'attested'. Same table-rebuild discipline as 005
    // (the previous agents.kind extension) and 010 (submissions rebuild):
    // SQLite cannot ALTER a CHECK constraint in place. PRAGMA foreign_keys
    // toggling lives in applyTableRebuildMigration (outside the txn — SQLite
    // no-ops the toggle inside a transaction).
    applyTableRebuildMigration(
      db,
      MIGRATION_013,
      () => {
        set.run("schema_version", "13");
      },
      ["agents", "agents_v3"],
    );
    v = 13;
  }

  if (v < 14) {
    // V2 §7.4 — additive: agents.destination_address (+ updated-at timestamp
    // for the 24h cooldown logic enforced in JS, not SQL). No rebuild needed.
    db.transaction(() => {
      db.exec(MIGRATION_014);
      set.run("schema_version", "14");
    })();
    v = 14;
  }

  if (v < 15) {
    // BLOCKER #5 fix — V2 §7.5 / Phase E cleanup, decoupled.
    //
    // STRUCTURAL part (this migration): rebuild submissions to relax
    // NOT NULL on {side, asset_id, horizon_hours, confidence,
    // rationale, strategy_tag}. ALWAYS runs — this is a pure schema
    // change, not destructive, and downstream code paths now expect
    // those columns to be nullable on committed-mode rows.
    //
    // DESTRUCTIVE part (moved out): the actual plaintext scrub now
    // lives in src/verdict/phase-e-cleanup.ts and runs at boot when
    // MURMUR_PHASE_E_CLEANUP=1. Idempotent — operators can flip the
    // env at any time and the next boot picks up the work, vs the
    // prior single-shot trap where the env had to be set on the
    // SAME boot that crossed schema 15.
    //
    // The rebuild step uses applyTableRebuildMigration for the same FK +
    // PRAGMA + transaction discipline as 010 / 013. Tables tuple is
    // ['submissions', 'submissions_v4'] — distinct from 010's
    // 'submissions_v3' name so a half-applied 010 retry can't collide.
    applyTableRebuildMigration(
      db,
      MIGRATION_015,
      () => {
        set.run("schema_version", "15");
      },
      ["submissions", "submissions_v4"],
    );
    v = 15;
  }

  if (v < 16) {
    // V2 §2.1 / §2.2 / §3.2 — additive v2 commitment + outcome storage
    // columns on submissions, t1_resolutions, and markets. Pure ADD COLUMN
    // (no CHECK constraint changes), so no table rebuild needed. Same
    // wrap-in-transaction discipline as MIGRATION_014: DDL + index DDL +
    // backfill UPDATE + schema_meta bump all atomic against a crash mid-run.
    //
    // Columns are JSON-bag fields validated at write-time inside the
    // MarketMakerAdapter (Phase 4); no Zod / DB CHECK constraints here.
    // Per V2 §7.7 risk 4, adapter_id and market_family are operator-curated
    // but kept open (no closed enum) so future families don't require a
    // schema migration.
    db.transaction(() => {
      db.exec(MIGRATION_016);
      set.run("schema_version", "16");
    })();
    v = 16;
  }

  if (v < 17) {
    // V2 §7.1 (casual tier scaffold) — accounts, account_agents, api_keys.
    //
    // Scope:
    //   - accounts: one row per Privy user (PRIMARY KEY = uuid; UNIQUE on
    //     privy_user_id which is the Privy DID like 'did:privy:xxxx').
    //   - account_agents: many-to-many bridge so a single account can later
    //     own multiple agents. v2.0 enforces one account per agent in the
    //     code path (see auth/accounts.ts getAccountForAgent), but the
    //     schema permits the future shape where co-owned agents become
    //     possible. Using a bridge table now avoids a third migration when
    //     we relax the policy.
    //   - api_keys: scoped per (account_id, agent_id) pair. Replaces the
    //     legacy single-key-per-agent model in agents.api_key_hash. The
    //     legacy column is left intact (we don't rebuild agents here) so
    //     existing benchmark agents keep authenticating until Phase 4 cuts
    //     the dispatcher over.
    //
    // Hash discipline: api_keys.api_key_hash stores sha256(secret) — same
    // primitive as agents.api_key_hash. Plaintext is returned exactly once
    // by mintApiKey() and never persisted. Rotation is soft: rotated_at
    // populated → key invalid (verifyApiKey() filters WHERE rotated_at
    // IS NULL). This keeps audit history without cascading deletes.
    //
    // Idempotency: pure additive. CREATE TABLE IF NOT EXISTS guards on
    // every statement so a partial-apply retry is safe.
    db.transaction(() => {
      db.exec(MIGRATION_017);
      set.run("schema_version", "17");
    })();
    v = 17;
  }

  if (v < 18) {
    // V2 Phase 5 — receipts.kind allows 'resolution_v2' for the universal
    // payout-vector receipt sibling.
    //
    // The Phase 5 resolver dual-writes a v2 resolution receipt alongside
    // the legacy 'resolution' receipt so verifiers can recompute against
    // either canonical chain. The legacy CHECK constraint at MIGRATION_001
    // permits only ('acceptance','resolution','re_resolution') — adding
    // 'resolution_v2' requires a table rebuild because SQLite cannot
    // ALTER a CHECK in place.
    //
    // Idempotency: pure rebuild. The DROP TABLE IF EXISTS receipts_v18
    // guard at the top survives partial-apply retries; the data copy is
    // INSERT-from-original so existing receipts (acceptance / resolution /
    // re_resolution) round-trip byte-for-byte.
    //
    // Recovery: routed through applyTableRebuildMigration so a crash
    // mid-rebuild reaches the standard recover path. See the helper's
    // doc comment for the four (original, temp) state recoveries.
    applyTableRebuildMigration(
      db,
      MIGRATION_018,
      () => {
        set.run("schema_version", "18");
      },
      ["receipts", "receipts_v18"],
    );
    v = 18;
  }

  if (v < 19) {
    // V2 BLOCKER #4 — one-account-per-agent enforced at the DB level.
    //
    // Migration 017 modeled account_agents as a many-to-many bridge with
    // PRIMARY KEY (account_id, agent_id) but NO uniqueness on agent_id
    // alone. Phase 7 intent (V2 §7.1) is one-owner-per-agent; the v2.0
    // policy was being enforced only at the code layer. Rebuild the
    // table with UNIQUE(agent_id) so the constraint is authoritative
    // and concurrent linkAgentToAccount() calls cannot race.
    //
    // Defensive dedup: Phase 7 hasn't shipped, so production should
    // have zero duplicate agent_id rows. The INSERT-from-original step
    // selects the row with MIN(created_at) per agent_id, so if a future
    // hotfix lands BEFORE this deploys and we somehow accumulated
    // duplicates, the FIRST owner wins and the table rebuild succeeds
    // rather than aborting on the new UNIQUE constraint.
    //
    // Recovery: routed through applyTableRebuildMigration for the same
    // FK + transaction discipline as 010/013/015/018. Tables tuple is
    // ['account_agents','account_agents_v19'] — distinct from 017's
    // table name so a half-applied retry can't collide.
    applyTableRebuildMigration(
      db,
      MIGRATION_019,
      () => {
        set.run("schema_version", "19");
      },
      ["account_agents", "account_agents_v19"],
    );
    v = 19;
  }

  if (v < 20) {
    // Wave 4b — drop the receipts subsystem.
    //
    // Receipts were a hackathon-era artifact for the Filecoin sponsor track.
    // The call + reveal + resolution rows are the canonical source of truth;
    // the receipts table only doubled DB write volume.
    //
    // Two changes in one migration:
    //   1. DROP receipts table entirely.
    //   2. Rebuild disputes to key on target_call_id (FK to submissions.call_id)
    //      instead of target_resolution_receipt_hash + new_resolution_receipt_hash.
    //
    // The disputes rebuild uses the SQLite "create new, copy, drop, rename"
    // pattern. For each existing dispute row we resolve the receipt_hash → call_id
    // by joining the legacy receipts table (still present until the DROP at the
    // end of this migration body). Rows whose receipt_hash no longer resolves
    // (orphaned legacy data) are dropped with a warning.
    //
    // Recovery: routed through applyTableRebuildMigration so a crash mid-rebuild
    // recovers via the standard four-state pre-transaction inspection.
    applyTableRebuildMigration(
      db,
      MIGRATION_020,
      () => {
        set.run("schema_version", "20");
      },
      ["disputes", "disputes_v20"],
    );
    v = 20;
  }

  if (v < 21) {
    // Wave 4d — drop the preflights table.
    //
    // preflights was Santiment-derived risk metadata stamped at acceptance
    // (murmur_score, murmur_playbook, risk_flags_json, data_freshness_seconds,
    // market_regime). Wave 4b-2 retired the Santiment integration; the
    // INSERT call site was removed at that time and the table has been
    // vestigial ever since — zero writers, zero readers, but the DDL still
    // shipped in MIGRATION_001 so every install carries an empty table.
    //
    // Single DROP — no data migration required (no rows to preserve), no FK
    // dependents (preflights references submissions ON DELETE CASCADE, not
    // the other direction). Idempotent via IF EXISTS.
    db.exec("DROP TABLE IF EXISTS preflights;");
    v = 21;
    set.run("schema_version", String(v));
  }

  if (v < 22) {
    // Migration 022 — RESERVED NO-OP.
    //
    // Codex Z0 review P2-C fix: the original plan reserved 022 for an
    // optional Phase 10 family-leaderboard cache that never shipped, and
    // jumping from 021 → 023 left a gap. Any future migration trying to
    // claim 022 would never run on DBs that booted under Z0 (the
    // `if (v < 22)` check would be false at v=23+).
    //
    // The fix: claim 022 as a deliberate no-op so the ladder is dense.
    // Phase 10's family-leaderboard cache (if it ever lands) MUST take
    // a slot AFTER the FHE block (current top is Z5's 027 — so >=028).
    v = 22;
    set.run("schema_version", String(v));
  }

  if (v < 23) {
    // Reserved. The local FHE provider/keyset schema that used this slot
    // was retired before the Fhenix-sealed path became canonical.
    v = 23;
    set.run("schema_version", String(v));
  }

  if (v < 24) {
    // Reserved with 023. Existing DBs that already created the old
    // ciphertext table are cleaned up by migrations 034 and 036.
    v = 24;
    set.run("schema_version", String(v));
  }

  if (v < 25) {
    // Reserved with 023. The old local scoring job queue is gone; Fhenix
    // reveals public verdicts post-horizon and ordinary scoring writes the
    // public reputation score.
    v = 25;
    set.run("schema_version", String(v));
  }

  if (v < 26) {
    // Reserved with 023. No daemon-local decrypt committee exists in the
    // canonical design.
    v = 26;
    set.run("schema_version", String(v));
  }

  if (v < 27) {
    // Reserved with 023. Old FHE retention/audit tables are dropped in
    // the cleanup migrations below if an existing DB already has them.
    v = 27;
    set.run("schema_version", String(v));
  }

  if (v < 28) {
    // Phase 11 — Polymarket Gamma adapter (Tier 1).
    //
    // Adds `external_market_sync_state`, the per-conditionId poll-state
    // table the Polymarket sync ticker writes to. Holds:
    //   - poll cadence bookkeeping (last_polled_at / next_poll_at)
    //   - observed status (`pending` | `disputed` | `resolved` | `404` |
    //     `error`) — sourced from a fresh Gamma fetch
    //   - consecutive failure counter for the MARKET_DISAPPEARED alert
    //     (24× 404 in a row)
    //   - one-shot alert timestamps so each operator alert fires exactly
    //     once per market lifetime
    //
    // Pure additive — no ALTER TABLE, no rebuild. Resolution state itself
    // continues to live on `t1_resolutions` like every other adapter; this
    // table is purely the ticker's scratch pad.
    //
    // FK on `market_id` cascades on delete so retiring a market cleans
    // the sync row too. Indexes:
    //   - adapter_id: per-adapter sweep (the ticker filters on
    //     `adapter_id = 'polymarket-gamma'`)
    //   - next_poll_at (partial; NOT NULL): the ticker's primary
    //     scheduling read.
    db.exec(MIGRATION_028);
    v = 28;
    set.run("schema_version", String(v));
  }

  if (v < 29) {
    // Phase 11.5 prep — registry groundwork for external (non-native-price)
    // market adapters.
    //
    // Two-part: (a) recreate `oracles` with a broader `kind` CHECK so
    // 'external_adapter' is a legal value; (b) seed one synthetic asset
    // + one synthetic oracle for Polymarket. Future external adapters
    // (Kalshi, Drift, etc.) reuse the same 'external_adapter' value
    // with their own oracle_id — no further migration needed when adding
    // a new adapter family at the registry layer.
    //
    // Why a table rebuild on oracles: SQLite ALTER TABLE doesn't support
    // dropping or replacing a CHECK constraint. The applyTableRebuildMigration
    // helper (BEGIN..COMMIT around the rename pattern, with foreign_keys=OFF)
    // safely recreates oracles, preserving existing rows (chainlink-base-*,
    // pyth-pull-*).
    //
    // ── Scope boundary ──
    //
    // Wave 4a — the four unblock points called out by this migration's
    // original scope boundary have landed:
    //   1. MarketIdSchema accepts '0x[hex64]' Polymarket conditionIds
    //      alongside the legacy '<asset>.<horizon>' shape.
    //   2. AssetIdSchema is now an open '<chain>:<asset>:<quote>' or
    //      '<protocol>:<kind>' regex (admits 'polymarket:event').
    //   3. AcceptedCallSchema's plaintext market-signal fields became
    //      optional in Wave 3b; the resolver consumes Commitment/Outcome
    //      JSON instead.
    //   4. The per-asset rate limiter (countCallsForAgentAssetWindow)
    //      was removed in Wave 3b; rate-limiting is per-market only.
    // The synthetic Polymarket asset + oracle seeded below remain the
    // anchor rows that external-market `markets` inserts reference, so
    // the NOT NULL FKs on `markets.asset_id` and
    // `markets.primary_oracle_id` are satisfied without rewriting the
    // markets table.
    // Concatenating the seed into the rebuild SQL keeps both inside the
    // same BEGIN..COMMIT as the schema_version bump — codex bundle review
    // MAJOR #1 fix. The original split (rebuild → schema_version=29 → seed
    // outside the transaction) had a crash window: a process crash between
    // commit and `db.exec(SEED)` would leave schema_version=29 with the
    // seed never run, and the next boot's `if (v < 29)` guard would skip
    // the entire block forever. INSERT OR IGNORE in the seed plus the
    // transaction guarantee means a re-run after rollback is idempotent.
    applyTableRebuildMigration(
      db,
      MIGRATION_029_ORACLES_REBUILD + MIGRATION_029_SEED,
      () => set.run("schema_version", "29"),
      ["oracles", "oracles_v029"],
    );
    v = 29;
  }

  if (v < 30) {
    // Reserved old-FHE repair slot. The canonical cleanup now happens
    // in 034/036 instead.
    v = 30;
    set.run("schema_version", String(v));
  }

  if (v < 31) {
    // Wave 3 reshape — operator-blind invariant + collapsed agent.kind enum.
    //
    // Four moves bundled (codex-greenlit consolidated reshape):
    //   1. Drop six dead tables emptied by Wave 1/3a:
    //        verified_identities, claim_challenges, oracle_policies,
    //        call_reveals, call_private_envelopes, disputes.
    //      The old public-identity onboarding tables, shadow scraping,
    //      and disputes runtime are gone. No app code touches them anymore.
    //   2. Drop four plaintext market-signal columns from submissions:
    //        side, asset_id, horizon_hours, confidence.
    //      These were the only DB-level leakage paths the operator could
    //      see today. FHE-only submit means everything load-bearing for
    //      scoring lives inside the Commitment ciphertext + the resolved
    //      Outcome row; the four columns survived only as placeholders
    //      to satisfy code paths now excised. Native-price's
    //      observeResolution stopped taking `side` in Wave 3b (BUY-
    //      perspective fallback), so the column is finally orphaned.
    //   3. Rebuild agents.kind CHECK to the collapsed enum
    //        ('benchmark','agent','internal_test','attested').
    //      Maps any legacy 'casual'/'shadow'/'verified'/'wallet_only'
    //      rows to 'agent' so dashboards + leaderboard renderers can
    //      drop the deprecated branches (Wave 3a already collapsed the
    //      dashboard enum).
    //   4. Add agents.program_version + submissions.program_version
    //      (default 1). Reserves the wire-shape upgrade slot for future
    //      scorer/program versions per V2 §6.3; additive now so a later
    //      bump doesn't require another migration.
    //
    // Crash safety — four sub-steps, each independently idempotent so a
    // crashed run converges on retry:
    //   (a) Dead-table drops: DROP IF EXISTS; safe to re-run.
    //   (b) ALTER ADD COLUMN: routed through applyAlterTableAddColumn so
    //       a partial state is reconciled by re-checking
    //       PRAGMA table_info() at boot (codex Z2 review FAIL #4 fix).
    //   (c) Agents rebuild: applyTableRebuildMigration with its
    //       (original, temp) crash-recovery protocol. The CASE-WHEN
    //       remap is itself idempotent — running it twice on already-
    //       remapped data is a no-op because none of the WHEN branches
    //       match the modern enum values.
    //   (d) Submissions rebuild: applyTableRebuildMigration too. The
    //       schema_version=31 bump rides inside this second rebuild's
    //       transaction so the boundary is well-defined: either the
    //       whole Wave-3 step landed (v=31) or it didn't (v=30, retry
    //       on next boot).
    //
    // Why no single applyTableRebuildMigration covers both: the helper
    // accepts a single (original, temp) tuple and the two rebuilds need
    // distinct temp names. The agents rebuild therefore uses a no-op
    // bumpSchemaVersion; the schema_version bump rides with submissions.
    // Each rebuild remains crash-recoverable on its own thanks to the
    // (a)–(c) idempotency above.
    db.exec(MIGRATION_031_DROP_DEAD_TABLES);
    applyAlterTableAddColumn(
      db,
      "agents",
      "program_version",
      "ALTER TABLE agents ADD COLUMN program_version INTEGER NOT NULL DEFAULT 1",
    );
    applyAlterTableAddColumn(
      db,
      "submissions",
      "program_version",
      "ALTER TABLE submissions ADD COLUMN program_version INTEGER NOT NULL DEFAULT 1",
    );
    applyTableRebuildMigration(
      db,
      MIGRATION_031_AGENTS_REBUILD,
      () => {
        /* schema_version bump rides with the submissions rebuild below. */
      },
      ["agents", "agents_v031"],
    );
    applyTableRebuildMigration(
      db,
      MIGRATION_031_SUBMISSIONS_REBUILD,
      () => set.run("schema_version", "31"),
      ["submissions", "submissions_v031"],
    );
    v = 31;
  }

  if (v < 32) {
    // Wave 5 — agent_security_events: append-only audit log for
    // operator/admin actions that mutate an agent's ownership or a
    // sensitive registry slot. Emitters live next to the call sites
    // (admin routes + admin-claim CLI) so a forensic timeline can be
    // reconstructed without grep'ing application logs.
    //
    // Rows are intentionally NOT FK'd to agents.agent_id — the audit
    // log must survive an admin-driven CASCADE delete of the agent
    // row itself. The agent_id column carries the same string for
    // forensics; lookup paths LEFT JOIN agents when they need the
    // current row.
    //
    // Pure additive (CREATE TABLE IF NOT EXISTS), so it is safe to
    // re-run on a half-applied state.
    db.exec(MIGRATION_032);
    v = 32;
    set.run("schema_version", String(v));
  }

  if (v < 33) {
    // Local-smoke discovery — Wave 4b's `marketsRepo.upsertExternalMarket`
    // inserts into `markets.config_json` and the resolver reads
    // `marketRow.config_json` to spread Polymarket's conditionId into
    // the adapter observation context. The MarketRow TS type declared
    // the column but no migration ever added it (codex P11's review
    // expected MIGRATION_016 to land it; it didn't). Without this
    // column, the Polymarket admin upsert + every resolver tick that
    // hits a Polymarket row fail at runtime with `no such column:
    // config_json`.
    //
    // Idempotent via applyAlterTableAddColumn — re-runs on a crashed
    // boot are no-ops. NOT NULL DEFAULT '{}' so existing native-price
    // markets land with the same empty-object shape the resolver's
    // parseMarketConfigJson helper already handles.
    applyAlterTableAddColumn(
      db,
      "markets",
      "config_json",
      "ALTER TABLE markets ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'",
    );
    v = 33;
    set.run("schema_version", String(v));
  }

  if (v < 34) {
    // Remove the retired daemon-local FHE stack. The only live privacy
    // integration after this point is the Fhenix-sealed contract path.
    db.transaction(() => {
      db.exec(MIGRATION_034_RETREAT);
      set.run("schema_version", "34");
    })();
    v = 34;
  }

  if (v < 35) {
    db.exec(MIGRATION_035_FHENIX_SEALED);
    v = 35;
    set.run("schema_version", String(v));
  }

  if (v < 36) {
    applyTableRebuildMigration(
      db,
      MIGRATION_036_T1_RESOLUTIONS_REBUILD,
      () => {
        /* schema_version bump rides after both rebuilds and table drops. */
      },
      ["t1_resolutions", "t1_resolutions_v036"],
    );
    applyTableRebuildMigration(
      db,
      MIGRATION_036_SUBMISSIONS_REBUILD,
      () => {
        /* schema_version bump rides after both rebuilds and table drops. */
      },
      ["submissions", "submissions_v036"],
    );
    db.exec(MIGRATION_036_DROP_RETIRED_FHE_ARTIFACTS);
    v = 36;
    set.run("schema_version", String(v));
  }

  if (v < 37) {
    db.exec(MIGRATION_037_FEED_CONTRACTS);
    v = 37;
    set.run("schema_version", String(v));
  }

  if (v < 38) {
    applyTableRebuildMigration(
      db,
      MIGRATION_038_FHENIX_BINARY_REVEALS,
      () => {
        /* schema_version bump rides after the rebuild. */
      },
      ["fhenix_sealed_calls", "fhenix_sealed_calls_v038"],
    );
    v = 38;
    set.run("schema_version", String(v));
  }

  if (v < 39) {
    applyTableRebuildMigration(
      db,
      MIGRATION_039_FHENIX_BINARY_INDEX_NAMING,
      () => {
        /* schema_version bump rides after the rebuild. */
      },
      ["fhenix_sealed_calls", "fhenix_sealed_calls_v039"],
    );
    v = 39;
    set.run("schema_version", String(v));
  }

  if (v < 40) {
    applyTableRebuildMigration(
      db,
      MIGRATION_040_FEED_BINARY_INDEX_NAMING,
      () => {
        /* schema_version bump rides after the rebuild. */
      },
      ["feed_packets", "feed_packets_v040"],
    );
    v = 40;
    set.run("schema_version", String(v));
  }

  if (v < 41) {
    applyTableRebuildMigration(
      db,
      MIGRATION_041_SUBMISSIONS_REVEAL_TERMINALS,
      () => {
        /* schema_version bump happens after additive Fhenix columns below. */
      },
      ["submissions", "submissions_v041"],
    );
    applyTableRebuildMigration(
      db,
      MIGRATION_041_FHENIX_SEALED_REVEAL_TERMINALS,
      () => {
        /* schema_version bump follows event-index tables below. */
      },
      ["fhenix_sealed_calls", "fhenix_sealed_calls_v041"],
    );
    db.exec(MIGRATION_041_FHENIX_EVENT_INDEXER);
    v = 41;
    set.run("schema_version", String(v));
  }

  if (v < 42) {
    db.exec(MIGRATION_042_CONTROLLER_WALLETS);
    v = 42;
    set.run("schema_version", String(v));
  }

  if (v < 43) {
    applyAlterTableAddColumn(
      db,
      "submissions",
      "runtime_key_id",
      "ALTER TABLE submissions ADD COLUMN runtime_key_id TEXT REFERENCES agent_runtime_keys(runtime_key_id) ON DELETE SET NULL",
    );
    db.exec(MIGRATION_043_SUBMISSION_RUNTIME_KEYS);
    v = 43;
    set.run("schema_version", String(v));
  }

  if (v < 44) {
    db.exec(MIGRATION_044_FHENIX_GATEWAY_TX_ATTEMPTS);
    v = 44;
    set.run("schema_version", String(v));
  }

  if (v < 45) {
    db.exec(MIGRATION_045_FHENIX_GATEWAY_FEED_PACKET_TX_ATTEMPTS);
    v = 45;
    set.run("schema_version", String(v));
  }

  if (v < 46) {
    applyAlterTableAddColumn(
      db,
      "agent_controller_wallets",
      "last_attested_at",
      "ALTER TABLE agent_controller_wallets ADD COLUMN last_attested_at TEXT",
    );
    applyAlterTableAddColumn(
      db,
      "agent_controller_wallets",
      "reattestation_due_at",
      "ALTER TABLE agent_controller_wallets ADD COLUMN reattestation_due_at TEXT",
    );
    applyAlterTableAddColumn(
      db,
      "agent_controller_wallets",
      "last_reattestation_nonce",
      "ALTER TABLE agent_controller_wallets ADD COLUMN last_reattestation_nonce TEXT",
    );
    applyAlterTableAddColumn(
      db,
      "agent_controller_wallets",
      "last_reattestation_message",
      "ALTER TABLE agent_controller_wallets ADD COLUMN last_reattestation_message TEXT",
    );
    applyAlterTableAddColumn(
      db,
      "agent_controller_wallets",
      "last_reattestation_signature",
      "ALTER TABLE agent_controller_wallets ADD COLUMN last_reattestation_signature TEXT",
    );
    db.exec(MIGRATION_046_CONTROLLER_REATTESTATIONS);
    v = 46;
    set.run("schema_version", String(v));
  }

  if (v < 47) {
    db.exec(MIGRATION_047_FEED_SLA_INCIDENTS);
    v = 47;
    set.run("schema_version", String(v));
  }

  if (v < 48) {
    for (const table of [
      "fhenix_gateway_tx_attempts",
      "fhenix_gateway_feed_packet_tx_attempts",
    ]) {
      applyAlterTableAddColumn(
        db,
        table,
        "broadcast_started_at",
        `ALTER TABLE ${table} ADD COLUMN broadcast_started_at TEXT`,
      );
      applyAlterTableAddColumn(
        db,
        table,
        "broadcast_latency_ms",
        `ALTER TABLE ${table} ADD COLUMN broadcast_latency_ms INTEGER CHECK (broadcast_latency_ms IS NULL OR broadcast_latency_ms >= 0)`,
      );
      applyAlterTableAddColumn(
        db,
        table,
        "receipt_observed_at",
        `ALTER TABLE ${table} ADD COLUMN receipt_observed_at TEXT`,
      );
      applyAlterTableAddColumn(
        db,
        table,
        "receipt_latency_ms",
        `ALTER TABLE ${table} ADD COLUMN receipt_latency_ms INTEGER CHECK (receipt_latency_ms IS NULL OR receipt_latency_ms >= 0)`,
      );
      applyAlterTableAddColumn(
        db,
        table,
        "latest_block_latency_ms",
        `ALTER TABLE ${table} ADD COLUMN latest_block_latency_ms INTEGER CHECK (latest_block_latency_ms IS NULL OR latest_block_latency_ms >= 0)`,
      );
      applyAlterTableAddColumn(
        db,
        table,
        "receipt_status",
        `ALTER TABLE ${table} ADD COLUMN receipt_status TEXT CHECK (receipt_status IS NULL OR receipt_status IN ('success','reverted'))`,
      );
      applyAlterTableAddColumn(
        db,
        table,
        "receipt_block_number",
        `ALTER TABLE ${table} ADD COLUMN receipt_block_number INTEGER`,
      );
      applyAlterTableAddColumn(
        db,
        table,
        "latest_block_number",
        `ALTER TABLE ${table} ADD COLUMN latest_block_number INTEGER`,
      );
      applyAlterTableAddColumn(
        db,
        table,
        "confirmations_observed",
        `ALTER TABLE ${table} ADD COLUMN confirmations_observed INTEGER CHECK (confirmations_observed IS NULL OR confirmations_observed >= 0)`,
      );
      applyAlterTableAddColumn(
        db,
        table,
        "gas_used",
        `ALTER TABLE ${table} ADD COLUMN gas_used TEXT`,
      );
      applyAlterTableAddColumn(
        db,
        table,
        "effective_gas_price_wei",
        `ALTER TABLE ${table} ADD COLUMN effective_gas_price_wei TEXT`,
      );
      applyAlterTableAddColumn(
        db,
        table,
        "last_rpc_error",
        `ALTER TABLE ${table} ADD COLUMN last_rpc_error TEXT`,
      );
    }
    v = 48;
    set.run("schema_version", String(v));
  }

  if (v < 49) {
    db.exec(MIGRATION_049_OPERATOR_ALERTS);
    v = 49;
    set.run("schema_version", String(v));
  }

  if (v < 50) {
    // Idempotent ADD COLUMN for both gateway tx tables. The claim token
    // serializes "I'm about to broadcast this attempt" across writers so
    // the relayer-tick + the synchronous submit path can't double-broadcast
    // the same row. Stuck claims are recovered by a sweep before each
    // tick — see fhenixGatewayTxRepo.sweepStuckClaims.
    applyAlterTableAddColumn(
      db,
      "fhenix_gateway_tx_attempts",
      "broadcast_claim_token",
      "ALTER TABLE fhenix_gateway_tx_attempts ADD COLUMN broadcast_claim_token TEXT",
    );
    applyAlterTableAddColumn(
      db,
      "fhenix_gateway_feed_packet_tx_attempts",
      "broadcast_claim_token",
      "ALTER TABLE fhenix_gateway_feed_packet_tx_attempts ADD COLUMN broadcast_claim_token TEXT",
    );
    v = 50;
    set.run("schema_version", String(v));
  }

  if (v < 51) {
    // Wave L.A — Nanopayments via Circle Gateway middleware. New table
    // `nanopay_receipts` persists the composite idempotency key + status
    // state machine + full Fhenix anchor binding for every paid inference
    // call served via the `/v2/nanopay/infer` rail.
    //
    // Design note: docs/superpowers/specs/2026-05-23-wave-l-a-nanopayments-design.md
    //
    // Status state machine: settling → settled | failed | settlement_unknown.
    // `settling_intent` row written BEFORE Circle /v1/x402/settle so a
    // daemon crash mid-settle leaves a row to reconcile (full reconciliation
    // cron is Phase 3; Phase 1 ships testnet MVP that surfaces stuck rows
    // for operator inspection — never free-serves).
    //
    // Composite idempotency:
    //   (payer, eip3009_nonce, source_domain, payment_payload_hash, payment_requirements_hash)
    // UNIQUE indexed. EIP-3009 nonces are unique per-payer, not globally,
    // so the composite includes payer + the verifying-contract source
    // domain + content hashes to detect "same payer+nonce, different
    // payload" → 409 Conflict (the pre-settle DB lookup catches this
    // before calling Circle).
    //
    // Phase 1b update (v52): the `eip3009_nonce` column is renamed to
    // `payment_handle` because the SDK-pivot flow stores Circle's
    // transaction UUID there, not the raw EIP-3009 nonce. See v52 block
    // below.
    //
    // Binding fields persisted as binding_json (Fhenix anchor tuple) and
    // reveal_artifact_json (the revealed signal once horizon opens). Single-
    // stream invariant: served signal == sealed-Fhenix-anchored signal.
    db.exec(MIGRATION_051_NANOPAY_RECEIPTS);
    v = 51;
    set.run("schema_version", String(v));
  }

  if (v < 52) {
    // Wave L.A Phase 1b — rename `nanopay_receipts.eip3009_nonce` →
    // `payment_handle`. The Phase 1 column name was a semantic lie:
    // the SDK middleware consumes + verifies the EIP-3009 nonce before
    // the daemon handler runs, so what we actually store there is
    // Circle's transaction UUID (the "payment handle"). See
    // `src/verdict/routes/nanopay.ts` Phase 1 comment for the deferral
    // note.
    //
    // SQLite ALTER TABLE RENAME COLUMN (3.25.0+) auto-rewrites the
    // index definition's referenced column, but does not rename the
    // index itself. We drop + recreate so the index name stops
    // perpetuating the old semantics.
    //
    // Wrapped in db.transaction() because a crash AFTER the rename but
    // BEFORE the schema_version bump would leave the next boot
    // attempting to rename a column that no longer exists — startup
    // failure with no recovery path. The wrap makes the rename + index
    // swap + version bump atomic.
    //
    // Design note: docs/superpowers/specs/2026-05-24-wave-l-a-phase-1b-design.md
    const migrateTo52 = db.transaction(() => {
      db.exec(`
        ALTER TABLE nanopay_receipts RENAME COLUMN eip3009_nonce TO payment_handle;

        DROP INDEX IF EXISTS idx_nanopay_receipts_payer_nonce_domain;
        CREATE UNIQUE INDEX idx_nanopay_receipts_payer_handle_domain
          ON nanopay_receipts(payer, payment_handle, source_domain);
      `);
      set.run("schema_version", "52");
    });
    migrateTo52();
    v = 52;
  }

  if (v < 53) {
    // Fix 3 (testnet hardening 2026-06-01) — extend the agent_security_events
    // kind CHECK constraint with two new event kinds for operator audit:
    //   - admin_fhenix_gateway_retry: emitted when an operator forces a
    //     Fhenix gateway broadcast attempt to retry now.
    //   - admin_fhenix_feed_packet_backfill: emitted when an operator
    //     backfills a Fhenix feed packet via the admin ingest route.
    //
    // SQLite CHECK constraints are CLOSED — adding new values requires a
    // table rebuild. We use applyTableRebuildMigration (the same helper
    // migrations 010/011 use) so the rebuild is crash-safe.
    applyTableRebuildMigration(
      db,
      MIGRATION_053,
      () => {
        set.run("schema_version", "53");
      },
      ["agent_security_events", "agent_security_events_v053"],
    );
    v = 53;
  }

  if (v < 54) {
    // Multi-agent ownership fix (2026-06-03) — the controller-wallet table
    // shipped with `UNIQUE(wallet_address, chain_id)`, which enforced a
    // 1-wallet-per-1-agent rule. The user-facing model is actually
    // 1-wallet-per-Privy-account → N agents under that account, so we
    // drop the global uniqueness and let the application layer
    // (controller-wallets.ts:188) gate cross-account collisions via a
    // SELECT ... WHERE account_id != ? AND agent_id != ? precheck.
    //
    // SQLite has no DROP CONSTRAINT statement, so the only path is a
    // table rebuild. applyTableRebuildMigration uses the same atomic
    // helper migrations 010/011/053 use; the rename + index recreation
    // happen as one transactional unit, with a rebuilt-table fallback if
    // the daemon crashes mid-migration. `agent_id` remains the PRIMARY
    // KEY so each agent still has at most one binding.
    applyTableRebuildMigration(
      db,
      MIGRATION_054,
      () => {
        // Intermediate step: 055 follows in this same applyMigrations pass.
        // Persist 54 here (not LATEST) so a crash between 054 and 055 leaves
        // an honest schema_version that re-runs 055 on the next boot.
        set.run("schema_version", "54");
      },
      ["agent_controller_wallets", "agent_controller_wallets_v054"],
    );
    v = 54;
  }
  if (v < 55) {
    // Migration 055 — widen t1_resolutions price-anchor evidence to nullable
    // so non-native / oracle-unavailable resolutions stop fabricating p1 /
    // t1_feed / signed_return. See MIGRATION_055_... for the rationale.
    applyTableRebuildMigration(
      db,
      MIGRATION_055_T1_RESOLUTIONS_NULLABLE_EVIDENCE,
      () => {
        // Intermediate step: 056 follows in this same applyMigrations pass.
        // Persist 55 here (not LATEST) so a crash between 055 and 056 leaves
        // an honest schema_version that re-runs 056 on the next boot.
        set.run("schema_version", "55");
      },
      ["t1_resolutions", "t1_resolutions_v055"],
    );
    v = 55;
  }

  if (v < 56) {
    // Migration 056 — Polymarket discovery ledger + health row.
    //
    // `polymarket_discovery_state` is the durable per-conditionId record of
    // the auto-discovery ticker's registration attempts: state-machine status
    // (draft → broadcasting → confirmed → listed, with frozen/failed exits),
    // end-time, tx hash, error/attempt bookkeeping, and gas telemetry. It
    // survives daemon crashes so a broadcast whose receipt was lost can be
    // reconciled against on-chain state instead of re-spending gas, and the
    // per-hour / per-day registration caps are counted from it.
    //
    // `polymarket_discovery_health` is a single-row tick heartbeat the
    // operator-alert scanner reads (stale ticks, relayer balance posture).
    //
    // Pure additive — CREATE TABLE IF NOT EXISTS, safe to re-run.
    db.transaction(() => {
      db.exec(MIGRATION_056_POLYMARKET_DISCOVERY);
      // Intermediate step: 057 follows in this same applyMigrations pass.
      // Persist 56 here (not LATEST) so a crash between 056 and 057 leaves an
      // honest schema_version that re-runs 057 on the next boot.
      set.run("schema_version", "56");
    })();
    v = 56;
  }

  if (v < 57) {
    // Migration 057 — durable fallback reveal jobs + reveal attribution.
    //
    // `fhenix_reveal_jobs` is the crash-durable per-call state machine for the
    // murmur-owned fallback reveal worker (src/integrations/fhenix-reveal-
    // worker.ts). One row per sealed call the worker has become responsible
    // for after the agent grace window; it persists open/publish tx hashes,
    // partial threshold-decrypt results, backoff timing, and the phase so a
    // restart never re-opens or re-publishes a call whose receipt was lost.
    //
    // The two new `fhenix_sealed_calls` columns are normalized reveal
    // attribution evidence, written atomically when a reveal is ingested:
    //   - reveal_sender: the successful publishReveal tx `from` (lowercased).
    //   - reveal_source: agent | daemon_fallback | unattributed_external,
    //     classified from that sender. Powers honest daemon_fallback_reveals
    //     and reveal_reliability on the leaderboard instead of the old
    //     hardcoded zero. NULL on rows revealed before this migration
    //     (historical backfill would require an RPC sweep of receipt.from).
    //
    // Pure additive — ADD COLUMN + CREATE TABLE IF NOT EXISTS, safe to re-run.
    db.transaction(() => {
      db.exec(MIGRATION_057_FHENIX_REVEAL_JOBS);
      // Intermediate step: 058 follows in this same applyMigrations pass.
      // Persist 57 here (not LATEST) so a crash between 057 and 058 leaves an
      // honest schema_version that re-runs 058 on the next boot.
      set.run("schema_version", "57");
    })();
    v = 57;
  }

  if (v < 58) {
    // Migration 058 — reveal-worker self-heal watermark + legacy `missed` reset.
    //
    // `tx_broadcast_at` is the crash-durable broadcast watermark for the reveal
    // worker's currently-pending open/publish tx. Without it a dropped /
    // nonce-gapped tx (which never produces a receipt) is indistinguishable
    // from a still-mining one, so the worker would wait on a null receipt
    // forever and never re-broadcast. The worker re-broadcasts once
    // `now - tx_broadcast_at` exceeds its staleness threshold, self-healing a
    // stuck reveal EOA nonce instead of stranding the call (which is revealable
    // forever). See src/integrations/fhenix-reveal-worker.ts.
    //
    // The `missed` reset recovers legacy rows the OLD time-only terminalization
    // path auto-marked before it was replaced by worker-health alerts. Every
    // such row has revealed_at IS NULL and is still on-chain revealable (a call
    // has no reveal expiry), so it is returned to `pending` for the fallback
    // worker to seed and for reveal ingestion to attach. `missed` is now
    // reserved for a manually-established irrecoverable condition, so only
    // still-revealable auto-missed rows are reset here.
    //
    // Pure additive — ADD COLUMN + idempotent UPDATE, safe to re-run.
    db.transaction(() => {
      db.exec(MIGRATION_058_REVEAL_WORKER_SELFHEAL);
      // Persist 58 (not LATEST) so a crash before 059 re-runs 059 next boot.
      set.run("schema_version", "58");
    })();
    v = 58;
  }

  if (v < 59) {
    // Migration 059 — Flow 2 paid private decrypt-grant entitlements.
    //
    // `entitlements` is the crash-durable state machine for a subscriber who
    // pays (off-chain nanopay/x402) to receive EARLY private decrypt access to
    // an agent's sealed call, before the public reveal. Exactly one row per
    // (chain_id, contract_address, onchain_call_id, subscriber_address): the
    // UNIQUE reservation is inserted BEFORE settlement so two concurrent
    // payment nonces cannot double-buy the same (call, subscriber) and charge
    // twice. `status` mirrors the ordered payment→reserve→settle→grant→confirm
    // path from the access route (src/verdict/entitlement-access-surface.ts)
    // and the grant reconciler (src/integrations/fhenix-grant-reconciler.ts).
    // A settled payment is NEVER relabeled a plain failure — a grant that
    // cannot be broadcast/confirmed becomes grant_failed_refund_due so the
    // operator/reconciler owes a refund. See
    // contracts/src/MurmurSealedVerdicts.sol grantDecryptAccess for the
    // on-chain window enforcement this pairs with.
    //
    // Pure additive — CREATE TABLE IF NOT EXISTS, safe to re-run.
    db.transaction(() => {
      db.exec(MIGRATION_059_ENTITLEMENTS);
      // Persist 59 (not LATEST) so a crash before 060 re-runs 060 next boot.
      set.run("schema_version", "59");
    })();
    v = 59;
  }

  if (v < 60) {
    // Migration 060 — agent-auth hardening (PayBox competitive review,
    // codex-reviewed 2026-08-02). Four independent pieces, one version:
    //
    //   1. agent_runtime_key_nonces — consumed (runtime_key_id, nonce) pairs
    //      for murmur-rk (v2) proof-of-possession replay prevention. No FK to
    //      agent_runtime_keys: keys are soft-revoked (never deleted), and an
    //      FK would tax every authenticated request for a cascade that can't
    //      fire. Rows are pruned lazily on each verify (retention 600s).
    //   2. request_fingerprint + auth_proof on both gateway attempt tables.
    //      fingerprint = sha256 of the canonicalized semantic request body,
    //      compared on every client_order_id duplicate exit so an idempotent
    //      200 can never be returned for DIFFERENT content ("any changed
    //      parameter = new request"). auth_proof records how the reserving
    //      request authenticated ('pop-v1' or NULL bearer-only), so
    //      acceptance-time audit attribution reflects what actually happened.
    //   3. accounts.agent_credentials_disabled_at — the account kill switch.
    //      Checked at dispatch (runtime + api key), both key mints, and
    //      gateway attempt claiming; a bulk revoke alone is not durable
    //      because API-key mint is Privy-gated only.
    //   4. agent_security_events rebuild (SQLite CHECK can't be ALTERed) to
    //      admit the two kill-switch event kinds. Mirrors the closed enum in
    //      schema.ts AgentSecurityEventKindSchema — both surfaces must move
    //      together, by design.
    //
    // ALTERs are idempotent via applyAlterTableAddColumn; CREATEs use IF NOT
    // EXISTS; the rebuild drops its scratch table first — safe to re-run.
    applyAlterTableAddColumn(
      db,
      "fhenix_gateway_tx_attempts",
      "request_fingerprint",
      `ALTER TABLE fhenix_gateway_tx_attempts ADD COLUMN request_fingerprint TEXT`,
    );
    applyAlterTableAddColumn(
      db,
      "fhenix_gateway_tx_attempts",
      "auth_proof",
      `ALTER TABLE fhenix_gateway_tx_attempts ADD COLUMN auth_proof TEXT`,
    );
    applyAlterTableAddColumn(
      db,
      "fhenix_gateway_feed_packet_tx_attempts",
      "request_fingerprint",
      `ALTER TABLE fhenix_gateway_feed_packet_tx_attempts ADD COLUMN request_fingerprint TEXT`,
    );
    applyAlterTableAddColumn(
      db,
      "fhenix_gateway_feed_packet_tx_attempts",
      "auth_proof",
      `ALTER TABLE fhenix_gateway_feed_packet_tx_attempts ADD COLUMN auth_proof TEXT`,
    );
    applyAlterTableAddColumn(
      db,
      "accounts",
      "agent_credentials_disabled_at",
      `ALTER TABLE accounts ADD COLUMN agent_credentials_disabled_at TEXT`,
    );
    db.transaction(() => {
      db.exec(MIGRATION_060_RUNTIME_KEY_POP_NONCES);
      db.exec(MIGRATION_060_SECURITY_EVENT_KINDS);
      set.run("schema_version", String(LATEST_DB_MIGRATION_VERSION));
    })();
    v = 60;
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

  -- The receipts table existed in v0.1 (Filecoin sponsor-track artifact)
  -- but was retired in Wave 4b — migration 020 drops it. The base schema
  -- still creates it here so migrations 002-019 can reference it without
  -- conditional guards; migration 020 drops it cleanly post-replay.
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

  -- Wave 4b note: disputes originally keyed off receipt hashes; migration
  -- 020 rebuilds this table to key off target_call_id instead. The legacy
  -- shape stays here so the migration ladder (001 → 020) replays cleanly
  -- on a fresh DB.
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
//          (historical cleartext/commit modes and future modes)
//        - commit_hash TEXT — keccak256 of the canonical commit preimage,
//          NULL for legacy rows
//        - commit_scheme TEXT — version tag of the commit preimage
//          schema, e.g. "murmur-verdict-v0.2-commit@1"
//   2. Backfills existing rows to the historical cleartext privacy mode.
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

// ─── Migration 012 — market_config_history (append-only, P4) ───────────────
//
// Phase 4 Codex audit: bumpConfig overwrites the live markets row, but the
// per-call oracle_policies snapshot only captures the OPV2 fields we picked.
// For audit-time replay (a verifier reconstructing "what did market X look
// like at config_version=3?"), we need a versioned history.
//
// Shape: one row per (market_id, market_config_version). snapshot_json
// carries the replay-relevant config: asset_id, market_kind,
// horizon_seconds, oracle ids, staleness limits, T0 grace fields,
// void_band, round_cadence_seconds, scoring_kind, market_config_version.
// Append-only — no UPDATE / DELETE. Triggers enforce that.
//
// Seeded from current markets so version=N for every existing row already
// has a history entry. Future bumpConfig calls append the NEW version
// inside the same transaction as the markets UPDATE.
const MIGRATION_012 = `
  -- Idempotent on retry: an interrupted previous attempt left the JS-side
  -- schema_version at 11 but the SQL DDL might have partially run. With
  -- IF NOT EXISTS on every DDL, a retry inside the new atomic transaction
  -- wrapper completes cleanly. INSERT OR IGNORE on the seed prevents
  -- duplicate primary key on a partial seed.
  CREATE TABLE IF NOT EXISTS market_config_history (
    market_id              TEXT NOT NULL,
    market_config_version  INTEGER NOT NULL,
    snapshot_json          TEXT NOT NULL,
    recorded_at            TEXT NOT NULL,
    PRIMARY KEY (market_id, market_config_version)
  );
  CREATE INDEX IF NOT EXISTS idx_market_config_history_market
    ON market_config_history(market_id);

  -- Truly append-only: refuse UPDATE / DELETE post-insert.
  CREATE TRIGGER IF NOT EXISTS market_config_history_no_update
    BEFORE UPDATE ON market_config_history
    BEGIN
      SELECT RAISE(FAIL, 'market_config_history is append-only');
    END;
  CREATE TRIGGER IF NOT EXISTS market_config_history_no_delete
    BEFORE DELETE ON market_config_history
    BEGIN
      SELECT RAISE(FAIL, 'market_config_history is append-only');
    END;

  -- Seed: capture every current market row at its current version.
  -- snapshot_json is built from the live markets columns via JSON1.
  -- INSERT OR IGNORE for retry safety: a partial seed from a crashed
  -- previous attempt won't trip the (market_id, version) PK uniqueness.
  INSERT OR IGNORE INTO market_config_history
    (market_id, market_config_version, snapshot_json, recorded_at)
  SELECT
    market_id,
    market_config_version,
    json_object(
      'asset_id', asset_id,
      'market_kind', market_kind,
      'horizon_seconds', horizon_seconds,
      'primary_oracle_id', primary_oracle_id,
      'fallback_oracle_id', fallback_oracle_id,
      'primary_max_staleness_sec', primary_max_staleness_sec,
      'fallback_max_staleness_sec', fallback_max_staleness_sec,
      't0_grace_seconds', t0_grace_seconds,
      't0_extended_grace_seconds', t0_extended_grace_seconds,
      'void_band', void_band,
      'round_cadence_seconds', round_cadence_seconds,
      'scoring_kind', scoring_kind,
      'market_config_version', market_config_version
    ),
    -- recorded_at = current time (migration moment); future bumpConfig
    -- entries get the actual mutation timestamp.
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM markets;
`;

// ─── Migration 013 — agents.kind extension for tiered identity (V2 §7.5) ───
//
// Adds 'casual' and 'attested' to the agents.kind CHECK constraint so the
// new identity tiers from V2_DECISION_RECORD §7.1 can register. SQLite
// cannot ALTER a CHECK constraint in place; same table-rebuild pattern as
// migrations 005 (the previous agents.kind extension that added
// 'wallet_only') and 010 (the submissions rebuild for sub-hour markets).
//
// Foreign keys INTO agents from migration 001 / 005:
//   verified_identities.agent_id  ON DELETE CASCADE
//   submissions.agent_id          ON DELETE CASCADE
//   claim_challenges.agent_id     ON DELETE CASCADE
//   usage_events.agent_id         ON DELETE SET NULL
// SQLite resolves FK targets by table NAME at validation time, not at FK
// creation time, so renaming agents_v3 -> agents leaves the dependent FKs
// pointing at the rebuilt table automatically. PRAGMA foreign_keys = OFF
// during the rebuild (managed by applyTableRebuildMigration) prevents
// transient enforcement errors during the DROP+RENAME window.
//
// Indexes recreated post-rename: idx_agents_kind (from 001) and
// idx_agents_wallet (from 005). The leading DROP TABLE IF EXISTS
// agents_v3 is the same idempotent retry guard used by 010/011.
const MIGRATION_013 = `
  DROP TABLE IF EXISTS agents_v3;

  CREATE TABLE agents_v3 (
    agent_id        TEXT PRIMARY KEY,
    display_slug    TEXT UNIQUE NOT NULL COLLATE NOCASE,
    kind            TEXT NOT NULL CHECK (kind IN ('benchmark','shadow','verified','internal_test','wallet_only','casual','attested')),
    display_name    TEXT NOT NULL,
    bio             TEXT,
    created_at      TEXT NOT NULL,
    api_key_hash    TEXT,
    wallet_address  TEXT,
    chain_id        TEXT
  );

  INSERT INTO agents_v3 (agent_id, display_slug, kind, display_name, bio, created_at, api_key_hash, wallet_address, chain_id)
    SELECT agent_id, display_slug, kind, display_name, bio, created_at, api_key_hash, wallet_address, chain_id FROM agents;

  DROP TABLE agents;
  ALTER TABLE agents_v3 RENAME TO agents;

  CREATE INDEX idx_agents_kind ON agents(kind);
  CREATE INDEX idx_agents_wallet ON agents(wallet_address) WHERE wallet_address IS NOT NULL;
`;

// ─── Migration 014 — agents.destination_address (V2 §7.4) ──────────────────
//
// Pure additive change: operators declare a `destination_address` (any EVM
// address) as a payout-routing target. They do NOT sign with it. The 24h
// cooldown described in V2_DECISION_RECORD §7.4 is enforced in JS at the
// repo update fn, not in SQL — keeping cooldown logic in code lets us
// extend it (e.g. require email confirmation per change) without another
// migration. The destination_address_updated_at timestamp column is the
// state that cooldown logic reads.
//
// Format constraint (lowercase 0x + 40 hex) is intentionally NOT in the
// SQL CHECK. Reason: viem's getAddress() normalization runs at the API
// edge (matches the pattern used for agents.wallet_address — see
// schema.ts WalletAddressSchema). Adding a SQL CHECK would either
// duplicate that validation or make backfills awkward when a mixed-case
// address slips past the API edge during dev.
//
// Index: partial on destination_address WHERE NOT NULL — most agents
// won't take payments and won't set this. Same partial-index pattern as
// idx_agents_wallet from migration 005.
const MIGRATION_014 = `
  ALTER TABLE agents ADD COLUMN destination_address TEXT;
  ALTER TABLE agents ADD COLUMN destination_address_updated_at TEXT;
  CREATE INDEX idx_agents_destination ON agents(destination_address) WHERE destination_address IS NOT NULL;
`;

// ─── Migration 015 — Phase E cleanup (env-gated, V2 §7.5) ──────────────────
//
// Closes the DB-operator-sees-everything gap from STATE_OF_MURMUR.md §3.5
// and Phase 1 of V2_DECISION_RECORD §4. Committed-mode submissions ship
// their plaintext fields ({side, asset_id, horizon_hours, confidence,
// rationale, strategy_tag}) only inside `call_reveals` post-reveal; the
// raw `submissions` row should not retain those values once the call is
// past the acceptance window. This migration NULLs them out for any
// committed-mode row that has moved past 'accepted'/'pending_t0' status.
//
// Why env-gated: forward-only nullification is destructive (legacy
// committed-mode rows lose their plaintext). Operators must opt-in by
// setting MURMUR_PHASE_E_CLEANUP=1 on the deploy that crosses schema
// version 15. Once schema_version reaches 15 the migration won't re-run,
// so the gate is single-use.
//
// CHECK constraint relaxation: the existing submissions table (rebuilt by
// migration 010) requires {side, asset_id, horizon_hours, confidence}
// NOT NULL. The UPDATE below would fail the NOT NULL on side and the
// CHECK on confidence (>= 0.51). The rebuild here:
//   - relaxes side, asset_id, horizon_hours, confidence to NULL-able
//   - drops the side CHECK ('BUY','SELL') so NULL is permitted
//   - drops the confidence CHECK (>= 0.51 AND <= 0.95) — same reason
//   - keeps horizon_seconds NOT NULL (we don't NULL it; it's the
//     canonical horizon field per migration 010 and is used by the
//     resolver post-acceptance to compute T1)
// Existing historical cleartext rows still satisfy the relaxed constraints
// because they had real values before, so the INSERT-from-original
// step copies them through unchanged.
//
// Status filter: rows in 'accepted' or 'pending_t0' are the t0-anchoring
// window — the daemon may still need {side, asset_id, horizon_hours,
// confidence} during T0 anchor recovery. We leave those alone. Anything
// past pending_t0 (pending_t1, resolved, disputed, re_resolved, rejected)
// has its plaintext mirrored into call_reveals (or never needed it for
// rejected) and is safe to wipe.
//
// FK dependents: same set as migration 010 (preflights, oracle_policies,
// t0_anchors, t1_resolutions, receipts, call_private_envelopes,
// call_reveals). Same FK-OFF discipline via applyTableRebuildMigration.
//
// Indexes recreated post-rename: same set migration 010 created.
//
// Idempotency: re-running on a fresh DB with the env gate set produces a
// no-op UPDATE (no committed-mode rows past pending_t0 exist) but still
// performs the rebuild. The applyMigrations `if (v < 15)` guard prevents
// re-execution on subsequent opens — this is the actual idempotency
// boundary.
const MIGRATION_015 = `
  DROP TABLE IF EXISTS submissions_v4;

  CREATE TABLE submissions_v4 (
    call_id           TEXT PRIMARY KEY,
    agent_id          TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    client_order_id   TEXT NOT NULL,
    asset_id          TEXT,
    side              TEXT,
    horizon_hours     INTEGER,
    horizon_seconds   INTEGER NOT NULL CHECK (horizon_seconds > 0),
    confidence        REAL,
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

  INSERT INTO submissions_v4 (
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
    horizon_hours, horizon_seconds,
    confidence, submitted_at, accepted_at, status,
    rationale, strategy_tag, schema_version, scoring_version, dedup_key,
    privacy_mode, commit_hash, commit_scheme,
    market_id, market_config_version,
    prediction_value, prediction_low, prediction_high, round_id
  FROM submissions;

  DROP TABLE submissions;
  ALTER TABLE submissions_v4 RENAME TO submissions;

  CREATE INDEX idx_submissions_agent ON submissions(agent_id);
  CREATE INDEX idx_submissions_status ON submissions(status);
  CREATE INDEX idx_submissions_asset_horizon ON submissions(asset_id, horizon_hours);
  CREATE INDEX idx_submissions_commit_hash ON submissions(commit_hash) WHERE commit_hash IS NOT NULL;
  CREATE INDEX idx_submissions_privacy_mode ON submissions(privacy_mode);
  CREATE INDEX idx_submissions_market ON submissions(market_id) WHERE market_id IS NOT NULL;
  CREATE INDEX idx_submissions_round ON submissions(round_id) WHERE round_id IS NOT NULL;

  -- BLOCKER #5 fix: the destructive Phase-E plaintext scrub UPDATE has
  -- been moved OUT of this migration into src/verdict/phase-e-cleanup.ts.
  -- Migration 015 now only does the structural rebuild (NOT NULL relaxed
  -- on side/asset_id/horizon_hours/confidence/rationale/strategy_tag).
  -- The scrub runs at boot when MURMUR_PHASE_E_CLEANUP=1 and is
  -- idempotent — operators can flip the env at any time and the next
  -- boot will catch up, vs the prior single-shot schema-version trap.
`;

// ─── Migration 016 — v2 commitment + outcome storage columns (V2 §2.1/§2.2/§3.2)
//
// Adds the universal-Outcome / universal-Commitment storage shape on top of
// the existing v1 columns. Phase 4 reads/writes these from the v2 submission
// surface; legacy v1 calls keep their {side, asset_id, horizon_hours,
// confidence} surface and the new columns stay NULL.
//
// Submissions (5 cols, all nullable):
//   - commitment_json        — full canonical Commitment JSON (V2 §2.2).
//                              NULL for legacy v1 calls.
//   - predicted_outcome_json — the predictedOutcome block from the
//                              Commitment (kind + payoutNumerators as
//                              bigint strings + payoutDenominator).
//                              NULL for legacy.
//   - outcome_labels_json    — adapter-supplied label strings ('UP','DOWN',
//                              'YES','NO',...) corresponding 1:1 to each
//                              payoutNumerators position. Render-only —
//                              NEVER load-bearing for scoring (V2 §2.3).
//                              NULL for legacy.
//   - adapter_id             — MarketMakerAdapter.name owning the market_id
//                              (V2 §2.4). Backfill below: market_id
//                              IS NOT NULL → 'native-price'. Pre-MIGRATION_009
//                              rows where market_id IS NULL stay NULL.
//   - market_family          — adapter.marketFamily denormalized for fast
//                              leaderboard family filtering (V2 §3.2 risk 4).
//                              Backfill below: adapter_id='native-price' →
//                              'financial-direction'. Else NULL.
//
// Submissions indexes:
//   - idx_submissions_market_family — partial; speeds family filters on
//                                     leaderboard reads.
//   - idx_submissions_adapter       — partial; lets the resolver dispatch by
//                                     adapter without scanning the full table.
//
// t1_resolutions (2 cols, both nullable):
//   - resolved_outcome_json — full Outcome JSON the adapter returned (kind,
//                             payoutNumerators stringified, denominator,
//                             scalarValue if any, evidence). NULL for legacy
//                             resolutions written before v2.
//   - payout_vector_json    — convenience: just the payoutNumerators array
//                             as a JSON string (e.g. '["1","0"]'). Lets the
//                             leaderboard skip a JSON parse on the hot path.
//                             NULL for legacy.
//   No new indexes — t1_resolutions is already PK'd on call_id, which is
//   the only access path the resolver / scoring / leaderboard use.
//
// Markets (2 cols, both nullable; backfilled to 'native-price' /
// 'financial-direction' for every existing row):
//   - adapter_id    — actual source of truth at the MARKET level;
//                     submissions.adapter_id denormalizes from here.
//   - market_family — same idea. Independent of the existing market_kind
//                     column from MIGRATION_008 (kept untouched).
//
// Backfill (in-migration, after the ALTER TABLE block):
//   submissions:
//     market_id IS NOT NULL AND adapter_id IS NULL
//       → adapter_id='native-price', market_family='financial-direction'
//   markets (every existing row):
//     adapter_id IS NULL
//       → adapter_id='native-price', market_family='financial-direction'
//
// Idempotency: the applyMigrations(`if (v < 16)`) guard is the
// idempotency boundary — schema_version 16 is set inside the same
// transaction as the DDL, so the migration can never run twice.
//
// No CHECK constraint on adapter_id / market_family per V2 §7.7 risk 4
// (taxonomy is operator-curated but kept open so new families don't
// require a schema migration).
const MIGRATION_016 = `
  ALTER TABLE submissions ADD COLUMN commitment_json TEXT;
  ALTER TABLE submissions ADD COLUMN predicted_outcome_json TEXT;
  ALTER TABLE submissions ADD COLUMN outcome_labels_json TEXT;
  ALTER TABLE submissions ADD COLUMN adapter_id TEXT;
  ALTER TABLE submissions ADD COLUMN market_family TEXT;

  CREATE INDEX idx_submissions_market_family
    ON submissions(market_family) WHERE market_family IS NOT NULL;
  CREATE INDEX idx_submissions_adapter
    ON submissions(adapter_id) WHERE adapter_id IS NOT NULL;

  ALTER TABLE t1_resolutions ADD COLUMN resolved_outcome_json TEXT;
  ALTER TABLE t1_resolutions ADD COLUMN payout_vector_json TEXT;

  ALTER TABLE markets ADD COLUMN adapter_id TEXT;
  ALTER TABLE markets ADD COLUMN market_family TEXT;

  -- Backfill: every existing markets row is a native-price /
  -- financial-direction market — that's the only adapter shipped at v0.2.
  UPDATE markets
     SET adapter_id = 'native-price',
         market_family = 'financial-direction'
   WHERE adapter_id IS NULL;

  -- Backfill: submissions with a market_id (i.e. anything past
  -- MIGRATION_009's ETH backfill) inherit the same adapter / family.
  -- Pre-MIGRATION_009 legacy rows where market_id IS NULL stay NULL —
  -- the v2 reader treats NULL adapter_id as "legacy v1 native-price"
  -- via a code-level fallback, not a DB-level backfill.
  UPDATE submissions
     SET adapter_id = 'native-price',
         market_family = 'financial-direction'
   WHERE market_id IS NOT NULL
     AND adapter_id IS NULL;
`;

// ─── Migration 017 — Phase 7 casual-tier auth scaffold ──────────────────────
//
// Three new tables for the Privy-backed casual identity tier:
//   - accounts: one row per Privy user; UNIQUE on privy_user_id (the DID).
//   - account_agents: many-to-many bridge for future co-ownership; v2.0
//     enforces one-account-per-agent at the code layer.
//   - api_keys: per (account, agent) pair, replaces the legacy single
//     agents.api_key_hash column for account-owned agents. The legacy column
//     stays in place so benchmark agents keep working until Phase 4 cuts the
//     dispatcher over.
//
// Hash discipline: api_key_hash stores sha256(secret); plaintext returned
// once by mintApiKey() and never persisted. Soft rotation via rotated_at.
//
// Idempotency: pure additive (CREATE TABLE IF NOT EXISTS); safe on retry.
const MIGRATION_017 = `
  CREATE TABLE IF NOT EXISTS accounts (
    account_id            TEXT PRIMARY KEY,
    privy_user_id         TEXT UNIQUE NOT NULL,
    email                 TEXT,
    primary_login_method  TEXT,
    created_at            TEXT NOT NULL,
    last_seen_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS account_agents (
    account_id  TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    agent_id    TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (account_id, agent_id)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    api_key_id    TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    agent_id      TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    api_key_hash  TEXT NOT NULL,
    label         TEXT,
    created_at    TEXT NOT NULL,
    rotated_at    TEXT,
    UNIQUE(api_key_hash)
  );

  CREATE INDEX IF NOT EXISTS idx_account_agents_agent ON account_agents(agent_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON api_keys(agent_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id) WHERE rotated_at IS NULL;
`;

// ─── Migration 018 — receipts.kind allows 'resolution_v2' (Phase 5) ─────────
//
// The Phase 5 resolver dual-writes a universal payout-vector receipt
// alongside the legacy 'resolution' receipt. The CHECK constraint at
// MIGRATION_001 only permits ('acceptance','resolution','re_resolution');
// SQLite cannot ALTER a CHECK in place, so this is a rebuild migration
// routed through applyTableRebuildMigration.
//
// Receipts is referenced FROM (no FKs target it as parent), so the
// rebuild copies every row byte-identically and recreates the original
// index. No data loss, no schema drift.
//
// Phase 6 will reconcile the two receipt kinds into a single canonical
// chain — for v0.2 we keep both so the legacy verify path stays untouched.
const MIGRATION_018 = `
  DROP TABLE IF EXISTS receipts_v18;

  CREATE TABLE receipts_v18 (
    receipt_hash    TEXT PRIMARY KEY,
    call_id         TEXT NOT NULL REFERENCES submissions(call_id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('acceptance','resolution','re_resolution','resolution_v2')),
    canonical_json  TEXT NOT NULL,
    filecoin_cid    TEXT,
    previous_hash   TEXT,
    created_at      TEXT NOT NULL
  );

  INSERT INTO receipts_v18
    (receipt_hash, call_id, kind, canonical_json, filecoin_cid, previous_hash, created_at)
  SELECT receipt_hash, call_id, kind, canonical_json, filecoin_cid, previous_hash, created_at
    FROM receipts;

  DROP TABLE receipts;
  ALTER TABLE receipts_v18 RENAME TO receipts;

  CREATE INDEX idx_receipts_call_kind ON receipts(call_id, kind);
`;

// ─── Migration 019 — UNIQUE(agent_id) on account_agents (BLOCKER #4) ────────
//
// Phase 7 / V2 §7.1 invariant: one account per agent. Migration 017 left
// the constraint at the code layer only (PRIMARY KEY on the pair, no
// uniqueness on agent_id alone), so a concurrent or buggy
// linkAgentToAccount() could create a second link before the code-layer
// pre-check fires. This rebuild makes the DB authoritative.
//
// Dedup tactic: Phase 7 hasn't shipped, so production should have zero
// duplicate agent_id rows. We still select MIN(created_at) per agent_id
// in the copy step so an unexpected duplicate (e.g. mid-migration hotfix
// retry) doesn't abort the whole migration on the new UNIQUE constraint.
//
// PRIMARY KEY (account_id, agent_id) is preserved alongside UNIQUE(agent_id)
// so existing read paths (the dispatcher's pair-lookup, etc.) keep working
// byte-identically. The FK targets (accounts, agents) stay the same.
const MIGRATION_019 = `
  DROP TABLE IF EXISTS account_agents_v19;

  CREATE TABLE account_agents_v19 (
    account_id  TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    agent_id    TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (account_id, agent_id),
    UNIQUE (agent_id)
  );

  INSERT INTO account_agents_v19 (account_id, agent_id, created_at)
  SELECT account_id, agent_id, created_at
    FROM account_agents
   WHERE rowid IN (
     SELECT MIN(rowid) FROM account_agents GROUP BY agent_id
   );

  DROP TABLE account_agents;
  ALTER TABLE account_agents_v19 RENAME TO account_agents;

  CREATE INDEX idx_account_agents_agent ON account_agents(agent_id);
`;

// ─── Migration 020 — Wave 4b: drop receipts + rekey disputes on call_id ────
//
// The receipts table doubled DB write volume for every accept and resolve
// (Filecoin sponsor-track artifact). Calls + reveals + resolutions are the
// canonical evidence trail; receipts add nothing the call_id chain doesn't
// already cover.
//
// Two changes:
//   1. DROP TABLE receipts (and its index).
//   2. Rebuild disputes:
//        - target_resolution_receipt_hash → target_call_id (FK to submissions)
//        - drop new_resolution_receipt_hash entirely; the dispute resolve
//          path now updates t1_resolutions in-place instead of chaining a
//          second receipt row.
//
// Disputes data migration: the legacy receipt_hash columns are resolved
// to call_id by joining the still-present receipts table BEFORE we drop
// it. Orphan dispute rows (receipt_hash that no longer matches anything)
// are dropped — the only acceptable failure mode for a hackathon-era
// table that's never had a non-test row land in production.
//
// Order matters: disputes data copy must happen BEFORE the receipts DROP,
// since the copy joins receipts to resolve receipt_hash → call_id.
const MIGRATION_020 = `
  DROP TABLE IF EXISTS disputes_v20;

  CREATE TABLE disputes_v20 (
    dispute_id      TEXT PRIMARY KEY,
    target_call_id  TEXT NOT NULL REFERENCES submissions(call_id) ON DELETE CASCADE,
    grounds         TEXT NOT NULL CHECK (grounds IN ('stale_feed','wrong_feed_used','wrong_timestamp','calculation_bug','chain_reorg','oracle_revision_after_resolution')),
    notes           TEXT,
    filed_by        TEXT NOT NULL,
    filed_at        TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('open','replay_in_progress','upheld','rejected')),
    resolved_at     TEXT
  );

  INSERT INTO disputes_v20 (dispute_id, target_call_id, grounds, notes, filed_by, filed_at, status, resolved_at)
  SELECT d.dispute_id, r.call_id, d.grounds, d.notes, d.filed_by, d.filed_at, d.status, d.resolved_at
    FROM disputes d
    JOIN receipts r ON r.receipt_hash = d.target_resolution_receipt_hash;

  DROP TABLE disputes;
  ALTER TABLE disputes_v20 RENAME TO disputes;

  CREATE INDEX idx_disputes_target_call ON disputes(target_call_id);

  DROP INDEX IF EXISTS idx_receipts_call_kind;
  DROP TABLE IF EXISTS receipts;
`;

// Migration slots 023-027 are reserved. They previously created the
// daemon-local FHE provider, ciphertext, and decrypt-committee tables.
// Fhenix-sealed verdicts are now canonical, so fresh DBs skip those tables
// and existing DBs shed them in migrations 034 and 036.

// ─── Migration 028 — Polymarket sync state (Phase 11) ──────────────────────
//
// Per-conditionId scratch pad for the Polymarket Gamma sync ticker. Every
// row is owned by exactly one markets entry (FK ON DELETE CASCADE) and
// keyed back to the adapter via `adapter_id` for fast per-adapter sweeps.
// CREATE-only — idempotent under `IF NOT EXISTS`.
const MIGRATION_028 = `
  CREATE TABLE IF NOT EXISTS external_market_sync_state (
    market_id                 TEXT PRIMARY KEY REFERENCES markets(market_id) ON DELETE CASCADE,
    adapter_id                TEXT NOT NULL,
    last_polled_at            TEXT,
    last_observed_status      TEXT,
    consecutive_failures      INTEGER NOT NULL DEFAULT 0,
    next_poll_at              TEXT,
    last_error                TEXT,
    alerted_disappeared_at    TEXT,
    alerted_never_resolved_at TEXT,
    created_at                TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sync_state_adapter
    ON external_market_sync_state(adapter_id);
  CREATE INDEX IF NOT EXISTS idx_sync_state_next_poll
    ON external_market_sync_state(next_poll_at)
    WHERE next_poll_at IS NOT NULL;
`;

// ─── Migration 029 — Polymarket-registerable oracles + synthetic seed ──────
//
// Rebuilds `oracles` to widen the `kind` CHECK with 'external_adapter'.
// SQLite cannot drop a CHECK in place, so we use the same
// applyTableRebuildMigration pattern that migrations 010/011 used for
// the submissions rebuild. The temp table is `oracles_v029`.
//
// Then seeds one synthetic asset ('polymarket:event') and one synthetic
// oracle ('polymarket-gamma-oracle'). All Polymarket conditionIds
// registered via the admin route will reference these two rows so the
// existing NOT NULL constraints on `markets.asset_id` and
// `markets.primary_oracle_id` are satisfied without rewriting `markets`.
//
// The oracle row stays at kind='external_adapter' so any future external
// adapter (Kalshi, Drift, etc.) reuses the same legal CHECK value with
// its own oracle_id.
const MIGRATION_029_ORACLES_REBUILD = `
  DROP TABLE IF EXISTS oracles_v029;
  CREATE TABLE oracles_v029 (
    oracle_id     TEXT PRIMARY KEY,
    asset_id      TEXT NOT NULL REFERENCES assets(asset_id),
    kind          TEXT NOT NULL CHECK (kind IN ('chainlink_evm','pyth_pull','pyth_solana','external_adapter')),
    adapter       TEXT NOT NULL,
    chain         TEXT NOT NULL,
    config_json   TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'listed'
                  CHECK (status IN ('draft','listed','frozen','retired')),
    created_at    TEXT NOT NULL
  );
  INSERT INTO oracles_v029 (oracle_id, asset_id, kind, adapter, chain, config_json, status, created_at)
  SELECT oracle_id, asset_id, kind, adapter, chain, config_json, status, created_at
    FROM oracles;
  DROP TABLE oracles;
  ALTER TABLE oracles_v029 RENAME TO oracles;
  CREATE INDEX idx_oracles_asset ON oracles(asset_id);
  CREATE INDEX idx_oracles_status ON oracles(status);
`;

// Seed is CONCATENATED into the rebuild SQL above so both run inside
// the same BEGIN..COMMIT as the schema_version=29 bump (codex bundle
// review MAJOR #1 fix at db.ts:584). A crash mid-block rolls back the
// entire migration; the `if (v < 29)` guard re-runs everything on
// the next boot. INSERT OR IGNORE makes that retry idempotent.
//
// Future authors: changes to the synthetic Polymarket asset/oracle
// rows must use an explicit UPDATE / UPSERT migration — re-running
// this seed appends nothing because INSERT OR IGNORE silently skips
// existing rows.
const MIGRATION_029_SEED = `
  INSERT OR IGNORE INTO assets (asset_id, display_short, display_name, native_chain, pyth_feed_id, chainlink_base_address, decimals_hint, status, notes, created_at) VALUES
    ('polymarket:event', 'pmevent', 'Polymarket Event', 'polygon',
     NULL, NULL, 0, 'listed',
     'synthetic anchor for all Polymarket conditionId markets; not a priced asset',
     '2026-05-12T00:00:00Z');

  INSERT OR IGNORE INTO oracles (oracle_id, asset_id, kind, adapter, chain, config_json, status, created_at) VALUES
    ('polymarket-gamma-oracle', 'polymarket:event', 'external_adapter', 'polymarket-gamma', 'polygon',
     '{"protocol":"polymarket-gamma","note":"resolution observed via gamma adapter, no price feed"}',
     'listed', '2026-05-12T00:00:00Z');
`;

// ─── Migration 031 — Wave 3 reshape ─────────────────────────────────────────
//
// See the prose in applyMigrations() above. Three SQL constants:
//   - MIGRATION_031_DROP_DEAD_TABLES: six DROP IF EXISTS for the tables
//     emptied by Wave 1/3a.
//   - MIGRATION_031_AGENTS_REBUILD: agents.kind CHECK collapse to four
//     values, with CASE-WHEN remap of legacy enum members to 'agent'.
//     Preserves all other columns (wallet_address/chain_id from
//     MIGRATION_005, destination_address/destination_address_updated_at
//     from MIGRATION_014, program_version added by the v<31 ALTERs).
//   - MIGRATION_031_SUBMISSIONS_REBUILD: drops side/asset_id/horizon_hours/
//     confidence. Recreates every index that survived the column drop
//     (idx_submissions_asset_horizon is gone — the two columns it
//     covered are no longer in the table; the resolver pages on
//     horizon_seconds + market_id now).
const MIGRATION_031_DROP_DEAD_TABLES = `
  DROP TABLE IF EXISTS verified_identities;
  DROP TABLE IF EXISTS claim_challenges;
  DROP TABLE IF EXISTS oracle_policies;
  DROP TABLE IF EXISTS call_reveals;
  DROP TABLE IF EXISTS call_private_envelopes;
  DROP TABLE IF EXISTS disputes;
`;

const MIGRATION_031_AGENTS_REBUILD = `
  DROP TABLE IF EXISTS agents_v031;

  CREATE TABLE agents_v031 (
    agent_id                       TEXT PRIMARY KEY,
    display_slug                   TEXT UNIQUE NOT NULL COLLATE NOCASE,
    kind                           TEXT NOT NULL CHECK (kind IN ('benchmark','agent','internal_test','attested')),
    display_name                   TEXT NOT NULL,
    bio                            TEXT,
    created_at                     TEXT NOT NULL,
    api_key_hash                   TEXT,
    wallet_address                 TEXT,
    chain_id                       TEXT,
    destination_address            TEXT,
    destination_address_updated_at TEXT,
    program_version                INTEGER NOT NULL DEFAULT 1
  );

  INSERT INTO agents_v031 (
    agent_id, display_slug, kind, display_name, bio, created_at,
    api_key_hash, wallet_address, chain_id,
    destination_address, destination_address_updated_at, program_version
  )
  SELECT
    agent_id, display_slug,
    CASE kind
      WHEN 'casual'      THEN 'agent'
      WHEN 'shadow'      THEN 'agent'
      WHEN 'verified'    THEN 'agent'
      WHEN 'wallet_only' THEN 'agent'
      ELSE kind
    END AS kind,
    display_name, bio, created_at,
    api_key_hash, wallet_address, chain_id,
    destination_address, destination_address_updated_at, program_version
  FROM agents;

  DROP TABLE agents;
  ALTER TABLE agents_v031 RENAME TO agents;

  CREATE INDEX idx_agents_kind ON agents(kind);
  CREATE INDEX idx_agents_wallet ON agents(wallet_address) WHERE wallet_address IS NOT NULL;
  CREATE INDEX idx_agents_destination ON agents(destination_address) WHERE destination_address IS NOT NULL;
`;

const MIGRATION_031_SUBMISSIONS_REBUILD = `
  DROP TABLE IF EXISTS submissions_v031;

  CREATE TABLE submissions_v031 (
    call_id                TEXT PRIMARY KEY,
    agent_id               TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    client_order_id        TEXT NOT NULL,
    horizon_seconds        INTEGER NOT NULL CHECK (horizon_seconds > 0),
    submitted_at           TEXT NOT NULL,
    accepted_at            TEXT NOT NULL,
    status                 TEXT NOT NULL CHECK (status IN ('accepted','pending_t0','pending_t1','resolved','disputed','re_resolved','rejected')),
    rationale              TEXT,
    strategy_tag           TEXT,
    schema_version         INTEGER NOT NULL,
    scoring_version        INTEGER NOT NULL,
    dedup_key              TEXT NOT NULL,
    privacy_mode           TEXT,
    commit_hash            TEXT,
    commit_scheme          TEXT,
    market_id              TEXT,
    market_config_version  INTEGER,
    prediction_value       TEXT,
    prediction_low         TEXT,
    prediction_high        TEXT,
    round_id               TEXT,
    commitment_json        TEXT,
    predicted_outcome_json TEXT,
    outcome_labels_json    TEXT,
    adapter_id             TEXT,
    market_family          TEXT,
    program_version        INTEGER NOT NULL DEFAULT 1,
    UNIQUE(agent_id, client_order_id),
    UNIQUE(dedup_key)
  );

  INSERT INTO submissions_v031 (
    call_id, agent_id, client_order_id, horizon_seconds,
    submitted_at, accepted_at, status,
    rationale, strategy_tag, schema_version, scoring_version, dedup_key,
    privacy_mode, commit_hash, commit_scheme,
    market_id, market_config_version,
    prediction_value, prediction_low, prediction_high, round_id,
    commitment_json, predicted_outcome_json, outcome_labels_json,
    adapter_id, market_family, program_version
  )
  SELECT
    call_id, agent_id, client_order_id, horizon_seconds,
    submitted_at, accepted_at, status,
    rationale, strategy_tag, schema_version, scoring_version, dedup_key,
    privacy_mode, commit_hash, commit_scheme,
    market_id, market_config_version,
    prediction_value, prediction_low, prediction_high, round_id,
    commitment_json, predicted_outcome_json, outcome_labels_json,
    adapter_id, market_family, program_version
  FROM submissions;

  DROP TABLE submissions;
  ALTER TABLE submissions_v031 RENAME TO submissions;

  CREATE INDEX idx_submissions_agent ON submissions(agent_id);
  CREATE INDEX idx_submissions_status ON submissions(status);
  CREATE INDEX idx_submissions_commit_hash ON submissions(commit_hash) WHERE commit_hash IS NOT NULL;
  CREATE INDEX idx_submissions_privacy_mode ON submissions(privacy_mode);
  CREATE INDEX idx_submissions_market ON submissions(market_id) WHERE market_id IS NOT NULL;
  CREATE INDEX idx_submissions_round ON submissions(round_id) WHERE round_id IS NOT NULL;
  CREATE INDEX idx_submissions_market_family
    ON submissions(market_family) WHERE market_family IS NOT NULL;
  CREATE INDEX idx_submissions_adapter
    ON submissions(adapter_id) WHERE adapter_id IS NOT NULL;
`;

// ─── Migration 032 — agent_security_events ─────────────────────────────────
//
// Append-only audit log for admin/operator actions that mutate an agent's
// ownership or a sensitive registry slot. Rows are intentionally NOT
// FK'd to `agents` — an admin-driven CASCADE delete of the agent must
// not erase the forensic trail. The string `agent_id` column carries the
// same value for join purposes; lookup paths LEFT JOIN when they need
// the current agent row.
//
// CHECK on `kind` keeps a closed taxonomy at the SQL layer so any
// emitter that adds a new event class also adds a row here (and to
// AgentSecurityEventKindSchema in schema.ts). Pure additive — safe to
// re-run via CREATE TABLE IF NOT EXISTS.
const MIGRATION_032 = `
  CREATE TABLE IF NOT EXISTS agent_security_events (
    event_id     TEXT PRIMARY KEY,
    agent_id     TEXT,
    account_id   TEXT,
    kind         TEXT NOT NULL CHECK (kind IN (
      'admin_claim',
      'admin_polymarket_upsert',
      'admin_market_status_change',
      'admin_ref_delete',
      'admin_account_unlink',
      'admin_fhenix_gateway_retry',
      'admin_fhenix_feed_packet_backfill'
    )),
    actor        TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_security_events_agent
    ON agent_security_events(agent_id)
    WHERE agent_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_agent_security_events_account
    ON agent_security_events(account_id)
    WHERE account_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_agent_security_events_kind
    ON agent_security_events(kind);
  CREATE INDEX IF NOT EXISTS idx_agent_security_events_created
    ON agent_security_events(created_at DESC);
  -- Wave 5 codex review MINOR — partial expression index for
  -- post-incident Polymarket lookups. The most common forensic query is
  -- "who upserted conditionId X?", which previously required a full
  -- table scan with payload_json LIKE. SQLite's json_extract on the
  -- payload returns the conditionId for admin_polymarket_upsert rows
  -- (and NULL elsewhere); the partial index ON the typed expression
  -- keeps storage cheap (only matching rows are indexed).
  CREATE INDEX IF NOT EXISTS idx_agent_security_events_polymarket_condition
    ON agent_security_events(json_extract(payload_json, '$.conditionId'))
    WHERE kind = 'admin_polymarket_upsert';
  -- Wave 5 codex review MAJOR — enforce append-only at the SQL layer.
  -- Without these triggers an accidental UPDATE / DELETE through any
  -- DB handle (test harness, smoke driver, future buggy repo) could
  -- rewrite or erase the forensic trail. RAISE(ABORT) returns a
  -- SQLITE_CONSTRAINT error to the caller; legitimate row inserts go
  -- through unchanged.
  CREATE TRIGGER IF NOT EXISTS trg_agent_security_events_no_update
  BEFORE UPDATE ON agent_security_events
  BEGIN
    SELECT RAISE(ABORT, 'agent_security_events rows are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS trg_agent_security_events_no_delete
  BEFORE DELETE ON agent_security_events
  BEGIN
    SELECT RAISE(ABORT, 'agent_security_events rows are append-only');
  END;
`;

// ─── Migration 053 — extend agent_security_events.kind CHECK ────────────────
//
// Adds two new event kinds used by the Fix 3 operator-audit emitters:
//   - admin_fhenix_gateway_retry
//   - admin_fhenix_feed_packet_backfill
//
// SQLite CHECK constraints are closed; we have to rebuild the table to
// extend them. Triggers must be dropped first because the rebuild itself
// performs an INSERT … SELECT into a fresh table, and the existing
// trg_agent_security_events_no_update / no_delete would not block an
// INSERT, but recreating them after the rename matters so the append-only
// invariant survives the migration. Indexes are recreated too.
const MIGRATION_053 = `
  DROP TRIGGER IF EXISTS trg_agent_security_events_no_update;
  DROP TRIGGER IF EXISTS trg_agent_security_events_no_delete;

  DROP TABLE IF EXISTS agent_security_events_v053;
  CREATE TABLE agent_security_events_v053 (
    event_id     TEXT PRIMARY KEY,
    agent_id     TEXT,
    account_id   TEXT,
    kind         TEXT NOT NULL CHECK (kind IN (
      'admin_claim',
      'admin_polymarket_upsert',
      'admin_market_status_change',
      'admin_ref_delete',
      'admin_account_unlink',
      'admin_fhenix_gateway_retry',
      'admin_fhenix_feed_packet_backfill'
    )),
    actor        TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL
  );

  INSERT INTO agent_security_events_v053 (
    event_id, agent_id, account_id, kind, actor, payload_json, created_at
  )
  SELECT
    event_id, agent_id, account_id, kind, actor, payload_json, created_at
  FROM agent_security_events;

  DROP TABLE agent_security_events;
  ALTER TABLE agent_security_events_v053 RENAME TO agent_security_events;

  CREATE INDEX idx_agent_security_events_agent
    ON agent_security_events(agent_id)
    WHERE agent_id IS NOT NULL;
  CREATE INDEX idx_agent_security_events_account
    ON agent_security_events(account_id)
    WHERE account_id IS NOT NULL;
  CREATE INDEX idx_agent_security_events_kind
    ON agent_security_events(kind);
  CREATE INDEX idx_agent_security_events_created
    ON agent_security_events(created_at DESC);
  CREATE INDEX idx_agent_security_events_polymarket_condition
    ON agent_security_events(json_extract(payload_json, '$.conditionId'))
    WHERE kind = 'admin_polymarket_upsert';

  CREATE TRIGGER trg_agent_security_events_no_update
  BEFORE UPDATE ON agent_security_events
  BEGIN
    SELECT RAISE(ABORT, 'agent_security_events rows are append-only');
  END;
  CREATE TRIGGER trg_agent_security_events_no_delete
  BEFORE DELETE ON agent_security_events
  BEGIN
    SELECT RAISE(ABORT, 'agent_security_events rows are append-only');
  END;
`;

// ─── Migration 054 — drop UNIQUE(wallet_address, chain_id) ─────────────────
//
// The shipped agent_controller_wallets table at migration 042 carried
// `UNIQUE(wallet_address, chain_id)`, enforcing 1-wallet-per-1-agent. The
// product model is actually 1-wallet-per-Privy-account → N agents under that
// account, so we rebuild the table without that constraint. Cross-account
// uniqueness is now enforced by the application precheck in
// controller-wallets.ts (SELECT … WHERE account_id != ? AND agent_id != ?).
//
// SQLite has no DROP CONSTRAINT, so we rebuild. agent_id stays as the
// PRIMARY KEY so each agent still has at most one binding. Indexes are
// recreated to match the original schema. No triggers existed on this
// table, so no trigger drop/recreate dance is needed.
const MIGRATION_054 = `
  DROP TABLE IF EXISTS agent_controller_wallets_v054;
  CREATE TABLE agent_controller_wallets_v054 (
    agent_id           TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    account_id         TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    wallet_address     TEXT NOT NULL,
    chain_id           TEXT NOT NULL,
    wallet_kind        TEXT NOT NULL CHECK (wallet_kind IN ('embedded','external')),
    provider           TEXT CHECK (provider IS NULL OR length(provider) <= 64),
    binding_message    TEXT NOT NULL,
    binding_signature  TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    last_attested_at   TEXT,
    reattestation_due_at TEXT,
    last_reattestation_nonce TEXT,
    last_reattestation_message TEXT,
    last_reattestation_signature TEXT
  );

  INSERT INTO agent_controller_wallets_v054 (
    agent_id, account_id, wallet_address, chain_id, wallet_kind, provider,
    binding_message, binding_signature, created_at, last_attested_at,
    reattestation_due_at, last_reattestation_nonce, last_reattestation_message,
    last_reattestation_signature
  )
  SELECT
    agent_id, account_id, wallet_address, chain_id, wallet_kind, provider,
    binding_message, binding_signature, created_at, last_attested_at,
    reattestation_due_at, last_reattestation_nonce, last_reattestation_message,
    last_reattestation_signature
  FROM agent_controller_wallets;

  DROP TABLE agent_controller_wallets;
  ALTER TABLE agent_controller_wallets_v054 RENAME TO agent_controller_wallets;

  CREATE INDEX IF NOT EXISTS idx_agent_controller_wallets_account
    ON agent_controller_wallets(account_id);
  CREATE INDEX IF NOT EXISTS idx_agent_controller_wallets_wallet
    ON agent_controller_wallets(wallet_address, chain_id);
  CREATE INDEX IF NOT EXISTS idx_agent_controller_wallets_reattestation_due
    ON agent_controller_wallets(reattestation_due_at);
`;

// ─── Migration 055 — honest resolution evidence ─────────────────────────────
// p1 / t1_feed / signed_return are native-price price-anchoring evidence and
// were NOT NULL. That forced the non-native paths to fabricate values: the
// adapter path stuffed call_score into p1 and the adapter name into t1_feed,
// and the oracle-unavailable path stamped a placeholder "chainlink:base:ETH-USD"
// feed. Widen the three columns to nullable so non-native + oracle-unavailable
// resolutions store NULL evidence honestly. Existing rows are copied verbatim —
// settlement history is never rewritten; only new writes use NULL. No indexes
// exist on t1_resolutions, so none need recreating.
const MIGRATION_055_T1_RESOLUTIONS_NULLABLE_EVIDENCE = `
  DROP TABLE IF EXISTS t1_resolutions_v055;
  CREATE TABLE t1_resolutions_v055 (
    call_id               TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    t1                    TEXT NOT NULL,
    p1                    TEXT,
    t1_feed               TEXT,
    signed_return         TEXT,
    outcome               TEXT NOT NULL CHECK (outcome IN ('win','loss','void','oracle_unavailable')),
    call_score            REAL,
    resolved_at           TEXT NOT NULL,
    resolved_outcome_json TEXT,
    payout_vector_json    TEXT
  );

  INSERT INTO t1_resolutions_v055 (
    call_id, t1, p1, t1_feed, signed_return, outcome, call_score, resolved_at,
    resolved_outcome_json, payout_vector_json
  )
  SELECT
    call_id, t1, p1, t1_feed, signed_return, outcome, call_score, resolved_at,
    resolved_outcome_json, payout_vector_json
  FROM t1_resolutions;

  DROP TABLE t1_resolutions;
  ALTER TABLE t1_resolutions_v055 RENAME TO t1_resolutions;
`;

// ─── Migration 056 — Polymarket discovery ledger ────────────────────────────
// Status vocabulary mirrors the discovery state machine reviewed for the
// auto-registration ticker: rows are created as 'draft' alongside the draft
// markets row, move to 'broadcasting' once a registerFixedRevealMarket tx is
// signed (tx_hash persisted BEFORE the receipt wait so a crash can reconcile),
// 'confirmed' on a success receipt, 'listed' when the markets row is promoted,
// 'frozen' when the window ends before promotion, and 'failed' on terminal
// registration errors. registered_onchain_at is the spend-cap anchor.
const MIGRATION_056_POLYMARKET_DISCOVERY = `
  CREATE TABLE IF NOT EXISTS polymarket_discovery_state (
    condition_id            TEXT PRIMARY KEY,
    question                TEXT,
    slug                    TEXT,
    end_date_epoch_s        INTEGER NOT NULL CHECK (end_date_epoch_s > 0),
    status                  TEXT NOT NULL CHECK (status IN (
      'draft','broadcasting','confirmed','listed','frozen','failed'
    )),
    attempt_count           INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    tx_hash                 TEXT,
    gas_used                TEXT,
    effective_gas_price_wei TEXT,
    last_error              TEXT,
    registered_onchain_at   TEXT,
    listed_at               TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_polymarket_discovery_status
    ON polymarket_discovery_state(status);
  CREATE INDEX IF NOT EXISTS idx_polymarket_discovery_registered
    ON polymarket_discovery_state(registered_onchain_at)
    WHERE registered_onchain_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_polymarket_discovery_end_date
    ON polymarket_discovery_state(end_date_epoch_s);

  CREATE TABLE IF NOT EXISTS polymarket_discovery_health (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    enabled             INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    tick_interval_sec   INTEGER,
    last_tick_at        TEXT,
    last_success_at     TEXT,
    last_error          TEXT,
    relayer_balance_wei TEXT,
    balance_status      TEXT CHECK (
      balance_status IS NULL OR balance_status IN ('ok','warning','critical')
    ),
    updated_at          TEXT NOT NULL
  );
`;

const MIGRATION_057_FHENIX_REVEAL_JOBS = `
  ALTER TABLE fhenix_sealed_calls ADD COLUMN reveal_sender TEXT;
  ALTER TABLE fhenix_sealed_calls ADD COLUMN reveal_source TEXT
    CHECK (reveal_source IS NULL OR reveal_source IN (
      'agent','daemon_fallback','unattributed_external'
    ));

  CREATE TABLE IF NOT EXISTS fhenix_reveal_jobs (
    call_id                  TEXT PRIMARY KEY
                             REFERENCES fhenix_sealed_calls(call_id) ON DELETE CASCADE,
    chain_id                 INTEGER NOT NULL,
    contract_address         TEXT NOT NULL,
    onchain_call_id          TEXT NOT NULL,
    reveal_open_at           TEXT NOT NULL,
    phase                    TEXT NOT NULL CHECK (phase IN (
      'eligible',
      'open_tx_pending',
      'opened_confirmed',
      'decrypt_pending',
      'partially_decrypted',
      'ready_to_publish',
      'publish_tx_pending',
      'quarantined',
      'terminal_daemon',
      'terminal_external'
    )),
    open_tx_hash             TEXT,
    open_block_number        INTEGER,
    publish_tx_hash          TEXT,
    publish_block_number     INTEGER,
    binary_index_value       INTEGER,
    binary_index_signature   TEXT,
    confidence_value         INTEGER,
    confidence_signature     TEXT,
    attempt_count            INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at          TEXT NOT NULL,
    last_error               TEXT,
    -- Worker-health escalation: NULL (healthy) | 'warn' | 'escalate'. Set by
    -- the worker once a still-unrevealed job passes the warn / escalate age
    -- thresholds. Never terminalizes the call — a call is revealable forever.
    alert_level              TEXT CHECK (alert_level IS NULL OR alert_level IN ('warn','escalate')),
    first_eligible_at        TEXT NOT NULL,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fhenix_reveal_jobs_due
    ON fhenix_reveal_jobs(phase, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_fhenix_reveal_jobs_open_tx
    ON fhenix_reveal_jobs(chain_id, open_tx_hash)
    WHERE open_tx_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_fhenix_reveal_jobs_publish_tx
    ON fhenix_reveal_jobs(chain_id, publish_tx_hash)
    WHERE publish_tx_hash IS NOT NULL;
`;

const MIGRATION_058_REVEAL_WORKER_SELFHEAL = `
  ALTER TABLE fhenix_reveal_jobs ADD COLUMN tx_broadcast_at TEXT;

  UPDATE fhenix_sealed_calls
     SET reveal_status = 'pending',
         invalid_reason = NULL,
         terminal_at = NULL
   WHERE reveal_status = 'missed'
     AND revealed_at IS NULL;
`;

const MIGRATION_059_ENTITLEMENTS = `
  CREATE TABLE IF NOT EXISTS entitlements (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id              INTEGER NOT NULL,
    contract_address      TEXT NOT NULL,
    -- Murmur's internal sealed-call id (fhenix_sealed_calls.call_id) when known.
    call_id               TEXT,
    -- The on-chain callId (bytes32 hex, lowercased) passed to grantDecryptAccess.
    onchain_call_id       TEXT NOT NULL,
    -- The paying subscriber, derived from the VERIFIED payer wallet (never JSON).
    subscriber_address    TEXT NOT NULL,
    -- The producing agent (fhenix_sealed_calls.agent_id) recorded for later
    -- accounting; v1 pays all revenue to Murmur with NO producer split.
    producer_agent_id     TEXT,
    -- The nanopay receipt this entitlement settled against (nanopay_receipts.id
    -- as text, or the Circle transaction UUID) for reconciliation.
    nanopay_receipt_id    TEXT,
    amount                TEXT,
    currency              TEXT,
    status                TEXT NOT NULL CHECK (status IN (
      'payment_settling',
      'grant_queued',
      'grant_broadcast',
      'granted',
      'settlement_unknown',
      'grant_failed_refund_due',
      'refunded'
    )),
    grant_tx_hash         TEXT,
    grant_block_number    INTEGER,
    grant_attempts        INTEGER NOT NULL DEFAULT 0 CHECK (grant_attempts >= 0),
    last_error            TEXT,
    -- Refund lifecycle, orthogonal to status: NULL | 'refund_due' | 'refunded'.
    refund_status         TEXT CHECK (refund_status IS NULL OR refund_status IN ('refund_due','refunded')),
    -- Backoff watermark for the grant reconciler (ISO). Due when <= now.
    next_attempt_at       TEXT,
    granted_at            TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  );

  -- One entitlement per (chain, contract, on-chain call, subscriber). Inserted
  -- BEFORE settlement so concurrent payment nonces cannot double-charge the
  -- same access. Normalized lowercase columns keep case variants from bypassing
  -- the constraint (contract/subscriber are case-insensitive EVM addresses;
  -- onchain_call_id is a lowercased bytes32).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_reservation
    ON entitlements(chain_id, contract_address, onchain_call_id, subscriber_address);
  -- Reconciler due-work scan: non-terminal statuses ordered by next_attempt_at.
  CREATE INDEX IF NOT EXISTS idx_entitlements_due
    ON entitlements(status, next_attempt_at);
`;

// ─── Migration 034 — local-FHE retreat ──────────────────────────────────────
//
// Drops the retired daemon-local FHE pipeline. Existing deployments that had
// already crossed the old slots are cleaned up here; fresh deployments skipped
// those slots entirely.
const MIGRATION_034_RETREAT = `
  DROP TABLE IF EXISTS fhe_decrypt_shares;
  DROP TABLE IF EXISTS fhe_score_releases;
  DROP TABLE IF EXISTS fhe_decrypt_requests;
  DROP TABLE IF EXISTS fhe_key_holders;
  DROP TABLE IF EXISTS fhe_score_jobs;
  DROP TABLE IF EXISTS fhe_call_ciphertexts;
  DROP TABLE IF EXISTS privacy_policy_events;
`;

// ─── Migration 035 — canonical Fhenix sealed verdicts ────────────────────────
//
// Fhenix-sealed calls replace plaintext submission as Murmur's canonical
// prediction path. The submissions row carries public metadata only until the
// Fhenix contract releases a verified post-horizon reveal; at that point the
// daemon writes the universal commitment_json and the ordinary resolver/scorer
// can finish the call.
const MIGRATION_035_FHENIX_SEALED = `
  CREATE TABLE IF NOT EXISTS fhenix_sealed_calls (
    call_id              TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    chain_id             INTEGER NOT NULL,
    contract_address     TEXT NOT NULL,
    onchain_call_id      TEXT NOT NULL,
    submit_tx_hash       TEXT NOT NULL,
    submit_log_index     INTEGER NOT NULL CHECK (submit_log_index >= 0),
    side_ct_hash         TEXT NOT NULL,
    confidence_ct_hash   TEXT NOT NULL,
    reveal_open_at       TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    opened_at            TEXT,
    revealed_at          TEXT,
    reveal_tx_hash       TEXT,
    reveal_log_index     INTEGER CHECK (reveal_log_index IS NULL OR reveal_log_index >= 0),
    revealed_side        TEXT CHECK (revealed_side IS NULL OR revealed_side IN ('BUY','SELL')),
    revealed_confidence  REAL CHECK (
      revealed_confidence IS NULL OR
      (revealed_confidence >= 0.51 AND revealed_confidence <= 0.95)
    ),
    revealed_confidence_bps INTEGER CHECK (
      revealed_confidence_bps IS NULL OR
      (revealed_confidence_bps >= 5100 AND revealed_confidence_bps <= 9500)
    ),
    side_signature       TEXT,
    confidence_signature TEXT,
    UNIQUE (chain_id, contract_address, onchain_call_id),
    UNIQUE (chain_id, submit_tx_hash, submit_log_index)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fhenix_reveal_event
    ON fhenix_sealed_calls(chain_id, reveal_tx_hash, reveal_log_index)
    WHERE reveal_tx_hash IS NOT NULL AND reveal_log_index IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_fhenix_sealed_open
    ON fhenix_sealed_calls(reveal_open_at)
    WHERE revealed_at IS NULL;
`;

// ─── Migration 036 — remove retired local-FHE columns ───────────────────────
//
// Older local DBs may already have pre-Fhenix cleartext-payload or encrypted-
// score columns. Rebuild the two affected tables to the canonical shape.
const MIGRATION_036_T1_RESOLUTIONS_REBUILD = `
  DROP TABLE IF EXISTS t1_resolutions_v036;

  CREATE TABLE t1_resolutions_v036 (
    call_id               TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    t1                    TEXT NOT NULL,
    p1                    TEXT NOT NULL,
    t1_feed               TEXT NOT NULL,
    signed_return         TEXT NOT NULL,
    outcome               TEXT NOT NULL CHECK (outcome IN ('win','loss','void','oracle_unavailable')),
    call_score            REAL,
    resolved_at           TEXT NOT NULL,
    resolved_outcome_json TEXT,
    payout_vector_json    TEXT
  );

  INSERT INTO t1_resolutions_v036 (
    call_id, t1, p1, t1_feed, signed_return, outcome, call_score, resolved_at,
    resolved_outcome_json, payout_vector_json
  )
  SELECT
    call_id, t1, p1, t1_feed, signed_return, outcome, call_score, resolved_at,
    resolved_outcome_json, payout_vector_json
  FROM t1_resolutions;

  DROP TABLE t1_resolutions;
  ALTER TABLE t1_resolutions_v036 RENAME TO t1_resolutions;
`;

const MIGRATION_036_SUBMISSIONS_REBUILD = `
  DROP TABLE IF EXISTS submissions_v036;

  CREATE TABLE submissions_v036 (
    call_id                TEXT PRIMARY KEY,
    agent_id               TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    client_order_id        TEXT NOT NULL,
    horizon_seconds        INTEGER NOT NULL CHECK (horizon_seconds > 0),
    submitted_at           TEXT NOT NULL,
    accepted_at            TEXT NOT NULL,
    status                 TEXT NOT NULL CHECK (status IN ('accepted','pending_t0','pending_t1','resolved','disputed','re_resolved','rejected')),
    rationale              TEXT,
    strategy_tag           TEXT,
    schema_version         INTEGER NOT NULL,
    scoring_version        INTEGER NOT NULL,
    dedup_key              TEXT NOT NULL,
    privacy_mode           TEXT,
    commit_hash            TEXT,
    commit_scheme          TEXT,
    market_id              TEXT,
    market_config_version  INTEGER,
    prediction_value       TEXT,
    prediction_low         TEXT,
    prediction_high        TEXT,
    round_id               TEXT,
    commitment_json        TEXT,
    predicted_outcome_json TEXT,
    outcome_labels_json    TEXT,
    adapter_id             TEXT,
    market_family          TEXT,
    program_version        INTEGER NOT NULL DEFAULT 1,
    UNIQUE(agent_id, client_order_id),
    UNIQUE(dedup_key)
  );

  INSERT INTO submissions_v036 (
    call_id, agent_id, client_order_id, horizon_seconds,
    submitted_at, accepted_at, status,
    rationale, strategy_tag, schema_version, scoring_version, dedup_key,
    privacy_mode, commit_hash, commit_scheme,
    market_id, market_config_version,
    prediction_value, prediction_low, prediction_high, round_id,
    commitment_json, predicted_outcome_json, outcome_labels_json,
    adapter_id, market_family, program_version
  )
  SELECT
    call_id, agent_id, client_order_id, horizon_seconds,
    submitted_at, accepted_at, status,
    rationale, strategy_tag, schema_version, scoring_version, dedup_key,
    privacy_mode, commit_hash, commit_scheme,
    market_id, market_config_version,
    prediction_value, prediction_low, prediction_high, round_id,
    commitment_json, predicted_outcome_json, outcome_labels_json,
    adapter_id, market_family, program_version
  FROM submissions;

  DROP TABLE submissions;
  ALTER TABLE submissions_v036 RENAME TO submissions;

  CREATE INDEX idx_submissions_agent ON submissions(agent_id);
  CREATE INDEX idx_submissions_status ON submissions(status);
  CREATE INDEX idx_submissions_commit_hash ON submissions(commit_hash) WHERE commit_hash IS NOT NULL;
  CREATE INDEX idx_submissions_privacy_mode ON submissions(privacy_mode);
  CREATE INDEX idx_submissions_market ON submissions(market_id) WHERE market_id IS NOT NULL;
  CREATE INDEX idx_submissions_round ON submissions(round_id) WHERE round_id IS NOT NULL;
  CREATE INDEX idx_submissions_market_family
    ON submissions(market_family) WHERE market_family IS NOT NULL;
  CREATE INDEX idx_submissions_adapter
    ON submissions(adapter_id) WHERE adapter_id IS NOT NULL;
`;

const MIGRATION_036_DROP_RETIRED_FHE_ARTIFACTS = `
  DROP TABLE IF EXISTS fhe_decrypt_shares;
  DROP TABLE IF EXISTS fhe_score_releases;
  DROP TABLE IF EXISTS fhe_decrypt_requests;
  DROP TABLE IF EXISTS fhe_key_holders;
  DROP TABLE IF EXISTS fhe_score_jobs;
  DROP TABLE IF EXISTS fhe_call_ciphertexts;
  DROP TABLE IF EXISTS privacy_policy_events;
  DROP TABLE IF EXISTS fhe_circuits;
  DROP TABLE IF EXISTS fhe_keysets;
`;

// ─── Migration 037 — paid inference feed contracts ──────────────────────────
//
// Feed contracts are the marketplace promise layer. They do not change the
// call scorer; they record what an agent promised subscribers and timestamp
// sealed feed-packet deliveries so Murmur can score reliability separately
// from predictive accuracy.
const MIGRATION_037_FEED_CONTRACTS = `
  CREATE TABLE IF NOT EXISTS feed_contracts (
    feed_id                   TEXT PRIMARY KEY,
    agent_id                  TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    name                      TEXT NOT NULL CHECK (length(name) >= 3 AND length(name) <= 80),
    description               TEXT CHECK (description IS NULL OR length(description) <= 500),
    status                    TEXT NOT NULL CHECK (status IN ('draft','listed','paused','retired')),
    venue                     TEXT NOT NULL CHECK (length(venue) >= 2 AND length(venue) <= 64),
    resolution_classes_json   TEXT NOT NULL,
    edge_classes_json         TEXT NOT NULL,
    covered_market_ids_json   TEXT NOT NULL,
    delivery_cadence_seconds  INTEGER CHECK (
      delivery_cadence_seconds IS NULL OR delivery_cadence_seconds >= 60
    ),
    trigger_rules_json        TEXT NOT NULL,
    max_latency_seconds       INTEGER CHECK (
      max_latency_seconds IS NULL OR max_latency_seconds >= 60
    ),
    subscriber_capacity       INTEGER NOT NULL CHECK (subscriber_capacity > 0),
    commercial_template       TEXT NOT NULL CHECK (
      commercial_template IN (
        'per_alert',
        'capacity_capped_subscription',
        'exclusive_auction',
        'basket_subscription',
        'streaming_escrow_subscription',
        'verifiable_profit_share'
      )
    ),
    reveal_policy_json        TEXT NOT NULL,
    refund_rule_json          TEXT NOT NULL,
    slash_rule_json           TEXT NOT NULL,
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_feed_contracts_agent
    ON feed_contracts(agent_id);
  CREATE INDEX IF NOT EXISTS idx_feed_contracts_status
    ON feed_contracts(status);
  CREATE INDEX IF NOT EXISTS idx_feed_contracts_venue
    ON feed_contracts(venue);

  CREATE TABLE IF NOT EXISTS feed_packets (
    packet_id            TEXT PRIMARY KEY,
    feed_id              TEXT NOT NULL REFERENCES feed_contracts(feed_id) ON DELETE CASCADE,
    agent_id             TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    market_id            TEXT,
    packet_kind          TEXT NOT NULL CHECK (
      packet_kind IN ('verdict','revision','heartbeat','abstain','risk_warning')
    ),
    sequence             INTEGER NOT NULL CHECK (sequence > 0),
    payload_schema       TEXT NOT NULL,
    submitted_at         TEXT NOT NULL,
    accepted_at          TEXT NOT NULL,
    reveal_after         TEXT NOT NULL,
    delivery_deadline_at TEXT,
    sla_status           TEXT NOT NULL CHECK (sla_status IN ('on_time','late','unscheduled')),
    chain_id             INTEGER NOT NULL,
    contract_address     TEXT NOT NULL,
    onchain_packet_id    TEXT NOT NULL,
    submit_tx_hash       TEXT NOT NULL,
    submit_log_index     INTEGER NOT NULL CHECK (submit_log_index >= 0),
    packet_ct_hash       TEXT NOT NULL,
    side_ct_hash         TEXT,
    confidence_ct_hash   TEXT,
    created_at           TEXT NOT NULL,
    UNIQUE(feed_id, sequence),
    UNIQUE(chain_id, contract_address, onchain_packet_id),
    UNIQUE(chain_id, submit_tx_hash, submit_log_index)
  );

  CREATE INDEX IF NOT EXISTS idx_feed_packets_feed
    ON feed_packets(feed_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_feed_packets_agent
    ON feed_packets(agent_id, accepted_at);
  CREATE INDEX IF NOT EXISTS idx_feed_packets_market
    ON feed_packets(market_id) WHERE market_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_feed_packets_sla
    ON feed_packets(feed_id, sla_status);
`;

// ─── Migration 038 — generic binary Fhenix reveals ──────────────────────────
//
// The encrypted euint8 carried by the Fhenix call contract is a binary
// outcome index, not a native-price-only BUY/SELL side. Rebuild the reveal
// columns to store that generic index so the same sealed path can score
// Polymarket and future binary market venues.
const MIGRATION_038_FHENIX_BINARY_REVEALS = `
  DROP TABLE IF EXISTS fhenix_sealed_calls_v038;

  CREATE TABLE fhenix_sealed_calls_v038 (
    call_id              TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    chain_id             INTEGER NOT NULL,
    contract_address     TEXT NOT NULL,
    onchain_call_id      TEXT NOT NULL,
    submit_tx_hash       TEXT NOT NULL,
    submit_log_index     INTEGER NOT NULL CHECK (submit_log_index >= 0),
    side_ct_hash         TEXT NOT NULL,
    confidence_ct_hash   TEXT NOT NULL,
    reveal_open_at       TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    opened_at            TEXT,
    revealed_at          TEXT,
    reveal_tx_hash       TEXT,
    reveal_log_index     INTEGER CHECK (reveal_log_index IS NULL OR reveal_log_index >= 0),
    revealed_binary_index INTEGER CHECK (
      revealed_binary_index IS NULL OR revealed_binary_index IN (0, 1)
    ),
    revealed_confidence  REAL CHECK (
      revealed_confidence IS NULL OR
      (revealed_confidence >= 0.51 AND revealed_confidence <= 0.95)
    ),
    revealed_confidence_bps INTEGER CHECK (
      revealed_confidence_bps IS NULL OR
      (revealed_confidence_bps >= 5100 AND revealed_confidence_bps <= 9500)
    ),
    binary_index_signature TEXT,
    confidence_signature   TEXT,
    UNIQUE (chain_id, contract_address, onchain_call_id),
    UNIQUE (chain_id, submit_tx_hash, submit_log_index)
  );

  INSERT INTO fhenix_sealed_calls_v038 (
    call_id, chain_id, contract_address, onchain_call_id,
    submit_tx_hash, submit_log_index, side_ct_hash, confidence_ct_hash,
    reveal_open_at, created_at, opened_at, revealed_at,
    reveal_tx_hash, reveal_log_index, revealed_binary_index,
    revealed_confidence, revealed_confidence_bps,
    binary_index_signature, confidence_signature
  )
  SELECT
    call_id, chain_id, contract_address, onchain_call_id,
    submit_tx_hash, submit_log_index, side_ct_hash, confidence_ct_hash,
    reveal_open_at, created_at, opened_at, revealed_at,
    reveal_tx_hash, reveal_log_index,
    CASE revealed_side
      WHEN 'BUY' THEN 0
      WHEN 'SELL' THEN 1
      ELSE NULL
    END,
    revealed_confidence, revealed_confidence_bps,
    side_signature, confidence_signature
  FROM fhenix_sealed_calls;

  DROP TABLE fhenix_sealed_calls;
  ALTER TABLE fhenix_sealed_calls_v038 RENAME TO fhenix_sealed_calls;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_fhenix_reveal_event
    ON fhenix_sealed_calls(chain_id, reveal_tx_hash, reveal_log_index)
    WHERE reveal_tx_hash IS NOT NULL AND reveal_log_index IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_fhenix_sealed_open
    ON fhenix_sealed_calls(reveal_open_at)
    WHERE revealed_at IS NULL;
`;

// ─── Migration 039 — Fhenix binary-index naming cleanup ────────────────────
//
// The encrypted euint8 in MurmurSealedVerdicts is a binary outcome index
// for every supported binary market, not a native-price BUY/SELL side.
// Rebuild the sealed-call table to expose that in the column name and drop
// daemon-stored decrypt signatures: the verified Fhenix reveal event is now
// the trust root, so signatures in HTTP JSON would be unverified duplicate
// state.
const MIGRATION_039_FHENIX_BINARY_INDEX_NAMING = `
  DROP TABLE IF EXISTS fhenix_sealed_calls_v039;

  CREATE TABLE fhenix_sealed_calls_v039 (
    call_id              TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    chain_id             INTEGER NOT NULL,
    contract_address     TEXT NOT NULL,
    onchain_call_id      TEXT NOT NULL,
    submit_tx_hash       TEXT NOT NULL,
    submit_log_index     INTEGER NOT NULL CHECK (submit_log_index >= 0),
    binary_index_ct_hash TEXT NOT NULL,
    confidence_ct_hash   TEXT NOT NULL,
    reveal_open_at       TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    opened_at            TEXT,
    revealed_at          TEXT,
    reveal_tx_hash       TEXT,
    reveal_log_index     INTEGER CHECK (reveal_log_index IS NULL OR reveal_log_index >= 0),
    revealed_binary_index INTEGER CHECK (
      revealed_binary_index IS NULL OR revealed_binary_index IN (0, 1)
    ),
    revealed_confidence  REAL CHECK (
      revealed_confidence IS NULL OR
      (revealed_confidence >= 0.51 AND revealed_confidence <= 0.95)
    ),
    revealed_confidence_bps INTEGER CHECK (
      revealed_confidence_bps IS NULL OR
      (revealed_confidence_bps >= 5100 AND revealed_confidence_bps <= 9500)
    ),
    UNIQUE (chain_id, contract_address, onchain_call_id),
    UNIQUE (chain_id, submit_tx_hash, submit_log_index)
  );

  INSERT INTO fhenix_sealed_calls_v039 (
    call_id, chain_id, contract_address, onchain_call_id,
    submit_tx_hash, submit_log_index, binary_index_ct_hash, confidence_ct_hash,
    reveal_open_at, created_at, opened_at, revealed_at,
    reveal_tx_hash, reveal_log_index, revealed_binary_index,
    revealed_confidence, revealed_confidence_bps
  )
  SELECT
    call_id, chain_id, contract_address, onchain_call_id,
    submit_tx_hash, submit_log_index, side_ct_hash, confidence_ct_hash,
    reveal_open_at, created_at, opened_at, revealed_at,
    reveal_tx_hash, reveal_log_index, revealed_binary_index,
    revealed_confidence, revealed_confidence_bps
  FROM fhenix_sealed_calls;

  DROP TABLE fhenix_sealed_calls;
  ALTER TABLE fhenix_sealed_calls_v039 RENAME TO fhenix_sealed_calls;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_fhenix_reveal_event
    ON fhenix_sealed_calls(chain_id, reveal_tx_hash, reveal_log_index)
    WHERE reveal_tx_hash IS NOT NULL AND reveal_log_index IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_fhenix_sealed_open
    ON fhenix_sealed_calls(reveal_open_at)
    WHERE revealed_at IS NULL;
`;

// ─── Migration 040 — feed packet binary-index naming cleanup ─────────────────
//
// Feed packet metadata follows the same Fhenix vocabulary as sealed calls:
// an optional encrypted binary outcome index, not a BUY/SELL side.
const MIGRATION_040_FEED_BINARY_INDEX_NAMING = `
  DROP TABLE IF EXISTS feed_packets_v040;

  CREATE TABLE feed_packets_v040 (
    packet_id            TEXT PRIMARY KEY,
    feed_id              TEXT NOT NULL REFERENCES feed_contracts(feed_id) ON DELETE CASCADE,
    agent_id             TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    market_id            TEXT,
    packet_kind          TEXT NOT NULL CHECK (
      packet_kind IN ('verdict','revision','heartbeat','abstain','risk_warning')
    ),
    sequence             INTEGER NOT NULL CHECK (sequence > 0),
    payload_schema       TEXT NOT NULL,
    submitted_at         TEXT NOT NULL,
    accepted_at          TEXT NOT NULL,
    reveal_after         TEXT NOT NULL,
    delivery_deadline_at TEXT,
    sla_status           TEXT NOT NULL CHECK (sla_status IN ('on_time','late','unscheduled')),
    chain_id             INTEGER NOT NULL,
    contract_address     TEXT NOT NULL,
    onchain_packet_id    TEXT NOT NULL,
    submit_tx_hash       TEXT NOT NULL,
    submit_log_index     INTEGER NOT NULL CHECK (submit_log_index >= 0),
    packet_ct_hash       TEXT NOT NULL,
    binary_index_ct_hash TEXT,
    confidence_ct_hash   TEXT,
    created_at           TEXT NOT NULL,
    UNIQUE(feed_id, sequence),
    UNIQUE(chain_id, contract_address, onchain_packet_id),
    UNIQUE(chain_id, submit_tx_hash, submit_log_index)
  );

  INSERT INTO feed_packets_v040 (
    packet_id, feed_id, agent_id, market_id, packet_kind, sequence,
    payload_schema, submitted_at, accepted_at, reveal_after,
    delivery_deadline_at, sla_status, chain_id, contract_address,
    onchain_packet_id, submit_tx_hash, submit_log_index, packet_ct_hash,
    binary_index_ct_hash, confidence_ct_hash, created_at
  )
  SELECT
    packet_id, feed_id, agent_id, market_id, packet_kind, sequence,
    payload_schema, submitted_at, accepted_at, reveal_after,
    delivery_deadline_at, sla_status, chain_id, contract_address,
    onchain_packet_id, submit_tx_hash, submit_log_index, packet_ct_hash,
    side_ct_hash, confidence_ct_hash, created_at
  FROM feed_packets;

  DROP TABLE feed_packets;
  ALTER TABLE feed_packets_v040 RENAME TO feed_packets;

  CREATE INDEX IF NOT EXISTS idx_feed_packets_feed
    ON feed_packets(feed_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_feed_packets_agent
    ON feed_packets(agent_id, accepted_at);
  CREATE INDEX IF NOT EXISTS idx_feed_packets_market
    ON feed_packets(market_id) WHERE market_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_feed_packets_sla
    ON feed_packets(feed_id, sla_status);
`;

// ─── Migration 041 — Fhenix event indexer + reveal terminal states ──────────
//
// The sealed path now has three terminal reveal outcomes:
//   - revealed: valid public verdict can be scored against market outcome
//   - invalid: Fhenix proved a decrypt result, but it violated Murmur's
//              verdict domain (e.g. binary index > 1 or confidence out of
//              bounds)
//   - missed: reveal window + grace elapsed without a verified reveal
//
// Invalid/missed are call lifecycle terminal states, not market scores. They
// keep public reputation honest without forging a fake market outcome row.
const MIGRATION_041_SUBMISSIONS_REVEAL_TERMINALS = `
  DROP TABLE IF EXISTS submissions_v041;

  CREATE TABLE submissions_v041 (
    call_id                TEXT PRIMARY KEY,
    agent_id               TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    client_order_id        TEXT NOT NULL,
    horizon_seconds        INTEGER NOT NULL CHECK (horizon_seconds > 0),
    submitted_at           TEXT NOT NULL,
    accepted_at            TEXT NOT NULL,
    status                 TEXT NOT NULL CHECK (
      status IN (
        'accepted',
        'pending_t0',
        'pending_t1',
        'resolved',
        'disputed',
        're_resolved',
        'rejected',
        'invalid_reveal',
        'missed_reveal'
      )
    ),
    rationale              TEXT,
    strategy_tag           TEXT,
    schema_version         INTEGER NOT NULL,
    scoring_version        INTEGER NOT NULL,
    dedup_key              TEXT NOT NULL,
    privacy_mode           TEXT,
    commit_hash            TEXT,
    commit_scheme          TEXT,
    market_id              TEXT,
    market_config_version  INTEGER,
    prediction_value       TEXT,
    prediction_low         TEXT,
    prediction_high        TEXT,
    round_id               TEXT,
    commitment_json        TEXT,
    predicted_outcome_json TEXT,
    outcome_labels_json    TEXT,
    adapter_id             TEXT,
    market_family          TEXT,
    program_version        INTEGER NOT NULL DEFAULT 1,
    UNIQUE(agent_id, client_order_id),
    UNIQUE(dedup_key)
  );

  INSERT INTO submissions_v041 (
    call_id, agent_id, client_order_id, horizon_seconds,
    submitted_at, accepted_at, status,
    rationale, strategy_tag, schema_version, scoring_version, dedup_key,
    privacy_mode, commit_hash, commit_scheme,
    market_id, market_config_version,
    prediction_value, prediction_low, prediction_high, round_id,
    commitment_json, predicted_outcome_json, outcome_labels_json,
    adapter_id, market_family, program_version
  )
  SELECT
    call_id, agent_id, client_order_id, horizon_seconds,
    submitted_at, accepted_at, status,
    rationale, strategy_tag, schema_version, scoring_version, dedup_key,
    privacy_mode, commit_hash, commit_scheme,
    market_id, market_config_version,
    prediction_value, prediction_low, prediction_high, round_id,
    commitment_json, predicted_outcome_json, outcome_labels_json,
    adapter_id, market_family, program_version
  FROM submissions;

  DROP TABLE submissions;
  ALTER TABLE submissions_v041 RENAME TO submissions;

  CREATE INDEX idx_submissions_agent ON submissions(agent_id);
  CREATE INDEX idx_submissions_status ON submissions(status);
  CREATE INDEX idx_submissions_commit_hash ON submissions(commit_hash) WHERE commit_hash IS NOT NULL;
  CREATE INDEX idx_submissions_privacy_mode ON submissions(privacy_mode);
  CREATE INDEX idx_submissions_market ON submissions(market_id) WHERE market_id IS NOT NULL;
  CREATE INDEX idx_submissions_round ON submissions(round_id) WHERE round_id IS NOT NULL;
  CREATE INDEX idx_submissions_market_family
    ON submissions(market_family) WHERE market_family IS NOT NULL;
  CREATE INDEX idx_submissions_adapter
    ON submissions(adapter_id) WHERE adapter_id IS NOT NULL;
`;

const MIGRATION_041_FHENIX_SEALED_REVEAL_TERMINALS = `
  DROP TABLE IF EXISTS fhenix_sealed_calls_v041;

  CREATE TABLE fhenix_sealed_calls_v041 (
    call_id              TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    chain_id             INTEGER NOT NULL,
    contract_address     TEXT NOT NULL,
    onchain_call_id      TEXT NOT NULL,
    submit_tx_hash       TEXT NOT NULL,
    submit_log_index     INTEGER NOT NULL CHECK (submit_log_index >= 0),
    binary_index_ct_hash TEXT NOT NULL,
    confidence_ct_hash   TEXT NOT NULL,
    reveal_open_at       TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    opened_at            TEXT,
    revealed_at          TEXT,
    reveal_tx_hash       TEXT,
    reveal_log_index     INTEGER CHECK (reveal_log_index IS NULL OR reveal_log_index >= 0),
    revealed_binary_index INTEGER CHECK (
      revealed_binary_index IS NULL OR (revealed_binary_index >= 0 AND revealed_binary_index <= 255)
    ),
    revealed_confidence  REAL CHECK (
      revealed_confidence IS NULL OR
      (revealed_confidence >= 0.51 AND revealed_confidence <= 0.95)
    ),
    revealed_confidence_bps INTEGER CHECK (
      revealed_confidence_bps IS NULL OR
      (revealed_confidence_bps >= 0 AND revealed_confidence_bps <= 65535)
    ),
    reveal_status        TEXT NOT NULL DEFAULT 'pending'
                          CHECK (reveal_status IN ('pending','revealed','invalid','missed')),
    invalid_reason       TEXT,
    terminal_at          TEXT,
    submit_block_number  INTEGER,
    reveal_block_number  INTEGER,
    UNIQUE (chain_id, contract_address, onchain_call_id),
    UNIQUE (chain_id, submit_tx_hash, submit_log_index)
  );

  INSERT INTO fhenix_sealed_calls_v041 (
    call_id, chain_id, contract_address, onchain_call_id,
    submit_tx_hash, submit_log_index, binary_index_ct_hash, confidence_ct_hash,
    reveal_open_at, created_at, opened_at, revealed_at,
    reveal_tx_hash, reveal_log_index, revealed_binary_index,
    revealed_confidence, revealed_confidence_bps,
    reveal_status, invalid_reason, terminal_at,
    submit_block_number, reveal_block_number
  )
  SELECT
    call_id, chain_id, contract_address, onchain_call_id,
    submit_tx_hash, submit_log_index, binary_index_ct_hash, confidence_ct_hash,
    reveal_open_at, created_at, opened_at, revealed_at,
    reveal_tx_hash, reveal_log_index, revealed_binary_index,
    revealed_confidence, revealed_confidence_bps,
    CASE WHEN revealed_at IS NOT NULL THEN 'revealed' ELSE 'pending' END,
    NULL,
    revealed_at,
    NULL,
    NULL
  FROM fhenix_sealed_calls;

  DROP TABLE fhenix_sealed_calls;
  ALTER TABLE fhenix_sealed_calls_v041 RENAME TO fhenix_sealed_calls;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_fhenix_reveal_event
    ON fhenix_sealed_calls(chain_id, reveal_tx_hash, reveal_log_index)
    WHERE reveal_tx_hash IS NOT NULL AND reveal_log_index IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_fhenix_sealed_open
    ON fhenix_sealed_calls(reveal_open_at)
    WHERE revealed_at IS NULL;
`;

const MIGRATION_041_FHENIX_EVENT_INDEXER = `
  UPDATE fhenix_sealed_calls
  SET reveal_status = CASE
      WHEN revealed_at IS NOT NULL THEN 'revealed'
      ELSE reveal_status
    END,
    terminal_at = CASE
      WHEN revealed_at IS NOT NULL THEN COALESCE(terminal_at, revealed_at)
      ELSE terminal_at
    END;

  CREATE TABLE IF NOT EXISTS fhenix_event_cursors (
    chain_id          INTEGER NOT NULL,
    contract_address  TEXT NOT NULL,
    event_name        TEXT NOT NULL,
    last_block_number INTEGER NOT NULL CHECK (last_block_number >= 0),
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (chain_id, contract_address, event_name)
  );

  CREATE TABLE IF NOT EXISTS fhenix_events (
    chain_id         INTEGER NOT NULL,
    contract_address TEXT NOT NULL,
    event_name       TEXT NOT NULL,
    tx_hash          TEXT NOT NULL,
    log_index        INTEGER NOT NULL CHECK (log_index >= 0),
    block_number     INTEGER NOT NULL CHECK (block_number >= 0),
    block_hash       TEXT,
    payload_json     TEXT NOT NULL,
    observed_at      TEXT NOT NULL,
    PRIMARY KEY (chain_id, tx_hash, log_index)
  );

  CREATE INDEX IF NOT EXISTS idx_fhenix_events_contract_block
    ON fhenix_events(chain_id, contract_address, block_number);
  CREATE INDEX IF NOT EXISTS idx_fhenix_events_name
    ON fhenix_events(event_name, observed_at);
  CREATE INDEX IF NOT EXISTS idx_fhenix_sealed_reveal_status
    ON fhenix_sealed_calls(reveal_status, reveal_open_at);
`;

// ─── Migration 042 — Controller Wallets + Runtime Keys ─────────────────────
//
// The human owner controls an agent-specific Controller Wallet, but bots never
// need to automate that wallet. Owners sign offchain authorizations; Murmur
// stores the binding and hashes short-lived Runtime Keys that the Gateway will
// enforce before relaying Fhenix calls.
const MIGRATION_042_CONTROLLER_WALLETS = `
  CREATE TABLE IF NOT EXISTS agent_controller_wallets (
    agent_id           TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    account_id         TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    wallet_address     TEXT NOT NULL,
    chain_id           TEXT NOT NULL,
    wallet_kind        TEXT NOT NULL CHECK (wallet_kind IN ('embedded','external')),
    provider           TEXT CHECK (provider IS NULL OR length(provider) <= 64),
    binding_message    TEXT NOT NULL,
    binding_signature  TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    last_attested_at   TEXT,
    reattestation_due_at TEXT,
    last_reattestation_nonce TEXT,
    last_reattestation_message TEXT,
    last_reattestation_signature TEXT,
    UNIQUE(wallet_address, chain_id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_controller_wallets_account
    ON agent_controller_wallets(account_id);
  CREATE INDEX IF NOT EXISTS idx_agent_controller_wallets_wallet
    ON agent_controller_wallets(wallet_address, chain_id);

  CREATE TABLE IF NOT EXISTS agent_runtime_keys (
    runtime_key_id             TEXT PRIMARY KEY,
    account_id                 TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    agent_id                   TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    runtime_key_hash           TEXT NOT NULL UNIQUE,
    runtime_key_prefix         TEXT NOT NULL,
    label                      TEXT CHECK (label IS NULL OR length(label) <= 80),
    policy_json                TEXT NOT NULL,
    policy_hash                TEXT NOT NULL,
    controller_wallet_address  TEXT NOT NULL,
    controller_chain_id        TEXT NOT NULL,
    authorization_nonce        TEXT NOT NULL,
    authorization_message      TEXT NOT NULL,
    authorization_signature    TEXT NOT NULL,
    created_at                 TEXT NOT NULL,
    expires_at                 TEXT,
    revoked_at                 TEXT,
    revoke_reason              TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 160),
    UNIQUE(agent_id, authorization_message)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_runtime_keys_account_agent
    ON agent_runtime_keys(account_id, agent_id);
  CREATE INDEX IF NOT EXISTS idx_agent_runtime_keys_active
    ON agent_runtime_keys(agent_id, expires_at)
    WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_agent_runtime_keys_policy
    ON agent_runtime_keys(policy_hash);
`;

const MIGRATION_046_CONTROLLER_REATTESTATIONS = `
  CREATE TABLE IF NOT EXISTS agent_controller_wallet_reattestations (
    attestation_id       TEXT PRIMARY KEY,
    account_id           TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    agent_id             TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    wallet_address       TEXT NOT NULL,
    chain_id             TEXT NOT NULL,
    attestation_nonce    TEXT NOT NULL,
    attestation_message  TEXT NOT NULL,
    attestation_signature TEXT NOT NULL,
    attested_at          TEXT NOT NULL,
    next_due_at          TEXT NOT NULL,
    UNIQUE(agent_id, attestation_nonce)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_controller_reattestations_agent
    ON agent_controller_wallet_reattestations(agent_id, attested_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_controller_wallets_reattestation_due
    ON agent_controller_wallets(reattestation_due_at);
  UPDATE agent_controller_wallets
     SET last_attested_at = COALESCE(last_attested_at, created_at),
         reattestation_due_at = COALESCE(
           reattestation_due_at,
           strftime('%Y-%m-%dT%H:%M:%SZ', datetime(created_at, '+14 days'))
         )
   WHERE last_attested_at IS NULL
      OR reattestation_due_at IS NULL;
`;

const MIGRATION_043_SUBMISSION_RUNTIME_KEYS = `
  CREATE INDEX IF NOT EXISTS idx_submissions_runtime_key
    ON submissions(runtime_key_id)
    WHERE runtime_key_id IS NOT NULL;
`;

const MIGRATION_044_FHENIX_GATEWAY_TX_ATTEMPTS = `
  CREATE TABLE IF NOT EXISTS fhenix_gateway_tx_attempts (
    attempt_id                 TEXT PRIMARY KEY,
    status                     TEXT NOT NULL CHECK (
      status IN ('queued','submitted','confirmed','accepted','failed_retryable','failed_terminal')
    ),
    runtime_key_id             TEXT REFERENCES agent_runtime_keys(runtime_key_id) ON DELETE SET NULL,
    runtime_key_policy_hash    TEXT NOT NULL,
    runtime_key_policy_json    TEXT NOT NULL,
    account_id                 TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    agent_id                   TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    chain_id                   INTEGER NOT NULL,
    contract_address           TEXT NOT NULL,
    relayer_address            TEXT NOT NULL,
    agent_wallet_address       TEXT NOT NULL,
    market_id                  TEXT NOT NULL,
    market_id_hash             TEXT NOT NULL,
    market_ref_protocol        TEXT NOT NULL,
    market_config_version      INTEGER NOT NULL,
    client_order_id            TEXT NOT NULL,
    client_nonce               TEXT NOT NULL,
    submitted_at               TEXT NOT NULL,
    rationale                  TEXT,
    strategy_tag               TEXT,
    binary_index_input_json    TEXT NOT NULL,
    confidence_input_json      TEXT NOT NULL,
    tx_hash                    TEXT,
    submit_log_index           INTEGER CHECK (submit_log_index IS NULL OR submit_log_index >= 0),
    submit_block_number        INTEGER,
    onchain_call_id            TEXT,
    binary_index_ct_hash       TEXT,
    confidence_ct_hash         TEXT,
    accepted_at                TEXT,
    reveal_open_at             TEXT,
    call_id                    TEXT REFERENCES submissions(call_id) ON DELETE SET NULL,
    attempt_count              INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at            TEXT NOT NULL,
    last_error                 TEXT,
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    UNIQUE(agent_id, client_order_id),
    UNIQUE(chain_id, contract_address, agent_wallet_address, market_id_hash, client_nonce)
  );
  CREATE INDEX IF NOT EXISTS idx_fhenix_gateway_status_next
    ON fhenix_gateway_tx_attempts(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_fhenix_gateway_tx_hash
    ON fhenix_gateway_tx_attempts(chain_id, tx_hash)
    WHERE tx_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_fhenix_gateway_call_id
    ON fhenix_gateway_tx_attempts(call_id)
    WHERE call_id IS NOT NULL;
`;

const MIGRATION_045_FHENIX_GATEWAY_FEED_PACKET_TX_ATTEMPTS = `
  CREATE TABLE IF NOT EXISTS fhenix_gateway_feed_packet_tx_attempts (
    attempt_id                 TEXT PRIMARY KEY,
    status                     TEXT NOT NULL CHECK (
      status IN ('queued','submitted','confirmed','accepted','failed_retryable','failed_terminal')
    ),
    runtime_key_id             TEXT REFERENCES agent_runtime_keys(runtime_key_id) ON DELETE SET NULL,
    runtime_key_policy_hash    TEXT NOT NULL,
    runtime_key_policy_json    TEXT NOT NULL,
    account_id                 TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    agent_id                   TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    chain_id                   INTEGER NOT NULL,
    contract_address           TEXT NOT NULL,
    relayer_address            TEXT NOT NULL,
    agent_wallet_address       TEXT NOT NULL,
    feed_id                    TEXT NOT NULL REFERENCES feed_contracts(feed_id) ON DELETE CASCADE,
    feed_id_hash               TEXT NOT NULL,
    market_id                  TEXT,
    market_id_hash             TEXT NOT NULL,
    packet_kind                TEXT NOT NULL CHECK (
      packet_kind IN ('verdict','revision','heartbeat','abstain','risk_warning')
    ),
    sequence                   INTEGER NOT NULL CHECK (sequence > 0),
    payload_schema             TEXT NOT NULL,
    client_order_id            TEXT NOT NULL,
    client_nonce               TEXT NOT NULL,
    submitted_at               TEXT NOT NULL,
    delivery_deadline_at       TEXT,
    reveal_after               TEXT NOT NULL,
    action_input_json          TEXT NOT NULL,
    signal_input_json          TEXT NOT NULL,
    tx_hash                    TEXT,
    submit_log_index           INTEGER CHECK (submit_log_index IS NULL OR submit_log_index >= 0),
    submit_block_number        INTEGER,
    onchain_packet_id          TEXT,
    action_ct_hash             TEXT,
    signal_ct_hash             TEXT,
    accepted_at                TEXT,
    packet_id                  TEXT REFERENCES feed_packets(packet_id) ON DELETE SET NULL,
    attempt_count              INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at            TEXT NOT NULL,
    last_error                 TEXT,
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    UNIQUE(agent_id, feed_id, client_order_id),
    UNIQUE(chain_id, contract_address, agent_wallet_address, feed_id_hash, market_id_hash, client_nonce)
  );
  CREATE INDEX IF NOT EXISTS idx_fhenix_gateway_feed_status_next
    ON fhenix_gateway_feed_packet_tx_attempts(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_fhenix_gateway_feed_tx_hash
    ON fhenix_gateway_feed_packet_tx_attempts(chain_id, tx_hash)
    WHERE tx_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_fhenix_gateway_feed_packet_id
    ON fhenix_gateway_feed_packet_tx_attempts(packet_id)
    WHERE packet_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_fhenix_gateway_feed_sequence
    ON fhenix_gateway_feed_packet_tx_attempts(feed_id, sequence);
`;

const MIGRATION_047_FEED_SLA_INCIDENTS = `
  CREATE TABLE IF NOT EXISTS feed_sla_incidents (
    incident_id                   TEXT PRIMARY KEY,
    feed_id                       TEXT NOT NULL REFERENCES feed_contracts(feed_id) ON DELETE CASCADE,
    agent_id                      TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    incident_kind                 TEXT NOT NULL CHECK (incident_kind IN ('missed_packet')),
    status                        TEXT NOT NULL CHECK (status IN ('open','fulfilled_late')),
    expected_sequence             INTEGER NOT NULL CHECK (expected_sequence > 0),
    expected_delivery_deadline_at TEXT NOT NULL,
    detected_at                   TEXT NOT NULL,
    grace_seconds                 INTEGER NOT NULL CHECK (grace_seconds >= 0),
    refund_action                 TEXT NOT NULL CHECK (refund_action IN ('none','credit','prorated')),
    slash_action                  TEXT NOT NULL CHECK (slash_action IN ('none','reputation','stake')),
    fulfilled_packet_id           TEXT REFERENCES feed_packets(packet_id) ON DELETE SET NULL,
    fulfilled_at                  TEXT,
    details_json                  TEXT NOT NULL,
    created_at                    TEXT NOT NULL,
    updated_at                    TEXT NOT NULL,
    UNIQUE(feed_id, expected_sequence)
  );

  CREATE INDEX IF NOT EXISTS idx_feed_sla_incidents_feed_status
    ON feed_sla_incidents(feed_id, status);
  CREATE INDEX IF NOT EXISTS idx_feed_sla_incidents_status_detected
    ON feed_sla_incidents(status, detected_at);
  CREATE INDEX IF NOT EXISTS idx_feed_sla_incidents_agent
    ON feed_sla_incidents(agent_id, detected_at);
`;

const MIGRATION_049_OPERATOR_ALERTS = `
  CREATE TABLE IF NOT EXISTS operator_alerts (
    alert_id                    TEXT PRIMARY KEY,
    alert_key                   TEXT NOT NULL UNIQUE,
    source                      TEXT NOT NULL,
    kind                        TEXT NOT NULL,
    severity                    TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
    status                      TEXT NOT NULL CHECK (status IN ('open','resolved')),
    title                       TEXT NOT NULL,
    description                 TEXT NOT NULL,
    payload_json                TEXT NOT NULL,
    first_seen_at               TEXT NOT NULL,
    last_seen_at                TEXT NOT NULL,
    occurrence_count            INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
    resolved_at                 TEXT,
    delivery_status             TEXT NOT NULL DEFAULT 'pending'
                                CHECK (delivery_status IN ('pending','delivered','failed')),
    delivery_attempts           INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
    next_delivery_at            TEXT,
    last_delivery_at            TEXT,
    last_delivery_status        INTEGER,
    last_delivery_error         TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_operator_alerts_status_source
    ON operator_alerts(status, source, severity);
  CREATE INDEX IF NOT EXISTS idx_operator_alerts_delivery
    ON operator_alerts(delivery_status, next_delivery_at)
    WHERE status = 'open';
  CREATE INDEX IF NOT EXISTS idx_operator_alerts_last_seen
    ON operator_alerts(last_seen_at);
`;

const MIGRATION_051_NANOPAY_RECEIPTS = `
  CREATE TABLE IF NOT EXISTS nanopay_receipts (
    id                              INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Composite idempotency key (per design 2026-05-23-wave-l-a):
    --   EIP-3009 nonces are unique per-payer, not globally. The
    --   composite extends with source_domain (verifying contract on
    --   the chain where the EIP-3009 sig was generated) + content
    --   hashes so "same payer+nonce, different payload" is detected
    --   as 409 Conflict before a second Circle /settle is attempted.
    payer                           TEXT NOT NULL,
    eip3009_nonce                   TEXT NOT NULL,
    source_domain                   TEXT NOT NULL,
    payment_payload_hash            TEXT NOT NULL,
    payment_requirements_hash       TEXT NOT NULL,

    -- Status state machine:
    --   settling: row written BEFORE Circle /settle; expected to
    --             transition to settled or failed within seconds.
    --   settled: Circle /settle returned 200 + transaction UUID.
    --   failed: Circle /settle returned 4xx (insufficient balance,
    --           bad sig, etc.). Buyer can re-submit with a fresh nonce.
    --   settlement_unknown: reconciliation could not determine state
    --                       after N attempts (Phase 3 reconciler).
    --                       Operator intervention required.
    status                          TEXT NOT NULL
                                    CHECK (status IN ('settling','settled','failed','settlement_unknown')),

    -- Circle's response field on POST /v1/x402/settle is the
    -- transaction UUID. Set on transition to 'settled'.
    circle_transaction_uuid         TEXT,

    -- Application context — what the buyer paid for.
    pipeline_id                     TEXT NOT NULL,

    -- EIP-712 typed-data hash that deterministically identifies this
    -- per-call signal (binds pipelineId + payer + EIP-3009 nonce via
    -- the chain's domain separator). Cross-rail replay-safe because
    -- the escrow rail (Wave L.B) consumes a different typed-data hash.
    request_signal_id               TEXT NOT NULL,

    paid_amount_usdc_atoms          TEXT NOT NULL,

    -- Full Fhenix anchor tuple as JSON: chainId, sealed-verdicts
    -- contract addr, onchainCallId, marketId, agent, submit tx/log,
    -- both ciphertext hashes, revealOpenAt, commitScheme. Lets
    -- callers verify the served signal == sealed-Fhenix-anchored
    -- signal (single-stream invariant) without re-querying chain.
    binding_json                    TEXT NOT NULL,

    -- Reveal artifact, present once the sealed-Fhenix horizon opens.
    -- Pre-reveal calls store NULL and the binding includes an anchor
    -- handle + revealOpenAt instead.
    reveal_artifact_json            TEXT,

    created_at                      TEXT NOT NULL,
    settled_at                      TEXT,
    failed_at                       TEXT,
    failure_reason                  TEXT
  );

  -- Prefix-level UNIQUE on (payer, eip3009_nonce, source_domain) is
  -- the load-bearing race protection. EIP-3009 nonces are unique
  -- per-(payer, verifying-contract); the source_domain captures the
  -- verifying contract. So at most ONE row per (payer, nonce, source)
  -- is correct semantics. Concurrent inserts with the same prefix but
  -- different payload/requirements hashes (e.g. attacker trying to
  -- get a second settle attempt for the same authorization) will fail
  -- with SQLITE_CONSTRAINT_UNIQUE. The route handler catches this and
  -- re-reads, comparing hashes to decide cached-replay vs 409 conflict.
  -- (Per codex audit 2026-05-23.)
  CREATE UNIQUE INDEX IF NOT EXISTS idx_nanopay_receipts_payer_nonce_domain
    ON nanopay_receipts(payer, eip3009_nonce, source_domain);

  -- Index for the Phase 3 reconciliation cron to find stuck 'settling'
  -- rows quickly. Phase 1 doesn't actively use this but defines it now
  -- so Phase 3 doesn't add an ALTER on an already-populated table.
  CREATE INDEX IF NOT EXISTS idx_nanopay_receipts_status_created
    ON nanopay_receipts(status, created_at);
`;

// ─── Migration 060 — agent-auth hardening ───────────────────────────────────
const MIGRATION_060_RUNTIME_KEY_POP_NONCES = `
  CREATE TABLE IF NOT EXISTS agent_runtime_key_nonces (
    runtime_key_id TEXT NOT NULL,
    nonce          TEXT NOT NULL,
    seen_at        TEXT NOT NULL,
    PRIMARY KEY (runtime_key_id, nonce)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_agent_runtime_key_nonces_seen
    ON agent_runtime_key_nonces(seen_at);
`;

// Rebuild copied from MIGRATION_053 (same triggers/indexes) with the two
// account kill-switch kinds appended to the closed CHECK.
const MIGRATION_060_SECURITY_EVENT_KINDS = `
  DROP TRIGGER IF EXISTS trg_agent_security_events_no_update;
  DROP TRIGGER IF EXISTS trg_agent_security_events_no_delete;

  DROP TABLE IF EXISTS agent_security_events_v060;
  CREATE TABLE agent_security_events_v060 (
    event_id     TEXT PRIMARY KEY,
    agent_id     TEXT,
    account_id   TEXT,
    kind         TEXT NOT NULL CHECK (kind IN (
      'admin_claim',
      'admin_polymarket_upsert',
      'admin_market_status_change',
      'admin_ref_delete',
      'admin_account_unlink',
      'admin_fhenix_gateway_retry',
      'admin_fhenix_feed_packet_backfill',
      'account_kill_switch_engaged',
      'account_kill_switch_released'
    )),
    actor        TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL
  );

  INSERT INTO agent_security_events_v060 (
    event_id, agent_id, account_id, kind, actor, payload_json, created_at
  )
  SELECT
    event_id, agent_id, account_id, kind, actor, payload_json, created_at
  FROM agent_security_events;

  DROP TABLE agent_security_events;
  ALTER TABLE agent_security_events_v060 RENAME TO agent_security_events;

  CREATE INDEX idx_agent_security_events_agent
    ON agent_security_events(agent_id)
    WHERE agent_id IS NOT NULL;
  CREATE INDEX idx_agent_security_events_account
    ON agent_security_events(account_id)
    WHERE account_id IS NOT NULL;
  CREATE INDEX idx_agent_security_events_kind
    ON agent_security_events(kind);
  CREATE INDEX idx_agent_security_events_created
    ON agent_security_events(created_at DESC);
  CREATE INDEX idx_agent_security_events_polymarket_condition
    ON agent_security_events(json_extract(payload_json, '$.conditionId'))
    WHERE kind = 'admin_polymarket_upsert';

  CREATE TRIGGER trg_agent_security_events_no_update
  BEFORE UPDATE ON agent_security_events
  BEGIN
    SELECT RAISE(ABORT, 'agent_security_events rows are append-only');
  END;
  CREATE TRIGGER trg_agent_security_events_no_delete
  BEFORE DELETE ON agent_security_events
  BEGIN
    SELECT RAISE(ABORT, 'agent_security_events rows are append-only');
  END;
`;

/**
 * Apply an ALTER TABLE ADD COLUMN only if the column doesn't already exist.
 * SQLite's PRAGMA table_info() is the canonical existence check.
 */
function applyAlterTableAddColumn(
  db: Database.Database,
  table: string,
  column: string,
  sql: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(sql);
}

// ─── Migration 005 — wallet binding + wallet_only tier + claim indexes ──────
//
// Three things at once:
//   1. agents gains `wallet_address` + `chain_id` as top-level columns so
//      reputation without a verified_identities join on every profile read.
//   2. agents.kind enum originally extended to include wallet-owned agents.
//      SQLite CHECK constraints can't be ALTERed in place, so this migration
//      rebuilt the agents table.
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

// ─── Re-export ground type for migration knowledge ───────────────────────────

export const VERDICT_DB_SCHEMA_VERSION = 1 as const;
