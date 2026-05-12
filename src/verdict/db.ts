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
    //     existing wallet-only and benchmark agents keep authenticating
    //     until Phase 4 cuts the dispatcher over.
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
    // Z0 — operator-blind privacy foundation.
    //
    // Two additive tables wire the FHE provider boundary without
    // touching any existing privacy path:
    //   - fhe_keysets:  public-key metadata per provider/keyset, with
    //                   lifecycle status. The submission path (Z1) FKs
    //                   into `keyset_id`. The committee/operator never
    //                   stores plaintext private keys here.
    //   - fhe_circuits: compiled circuit handles per (provider, name,
    //                   vector_max_len) so the resolver (Z2) knows
    //                   which artifact to call when scoring.
    //
    // Pure additive: no backfill, no rebuild, no FK impact on
    // submissions/agents/markets. Legacy_plaintext and committed
    // agents are unaffected.
    db.exec(MIGRATION_023);
    v = 23;
    set.run("schema_version", String(v));
  }

  if (v < 24) {
    // Z1 — operator-blind submission storage.
    //
    // fhe_call_ciphertexts stores ONLY the encrypted payout vector,
    // its hash, and the binding metadata the resolver (Z2) needs to
    // pick the right circuit. The daemon never decrypts the blob —
    // ciphertext_blob is opaque bytes whose only daemon-side property
    // is `sha256(blob) === ciphertext_hash`.
    //
    // UNIQUE(ciphertext_hash) defends against cross-agent replay of a
    // captured ciphertext. UNIQUE(keyset_id, nonce) defends against
    // same-agent nonce reuse (the preimage binds nonce, so reusing it
    // would otherwise produce a stale-but-valid commit hash).
    //
    // Pure additive — no rebuild, no FK impact on existing tables.
    // Legacy_plaintext and committed agents are unaffected.
    db.exec(MIGRATION_024);
    v = 24;
    set.run("schema_version", String(v));
  }

  if (v < 25) {
    // Z2 — homomorphic scoring jobs + score-ciphertext pointers on
    // t1_resolutions.
    //
    // fhe_score_jobs is the per-call queue/state machine the resolver
    // writes to when it computes (or fails to compute) an encrypted
    // score for an fhe_direct row. The job row is the only operator-
    // visible state for the encrypted score until Z3's threshold
    // committee decrypts it. It carries the encrypted_score blob,
    // its hash, the transcript hash binding (circuit_id, ciphertext
    // hash, resolved outcome), retry bookkeeping, and the last error
    // string for diagnosis. There is no plaintext score column here
    // by construction — Z3 owns the decrypted bounded score and that
    // lands on `t1_resolutions.call_score` after quorum release.
    //
    // The two additive columns on t1_resolutions point the legacy
    // resolution row at the new encrypted artifact:
    //   - score_ciphertext_hash: same value as fhe_score_jobs.
    //     score_ciphertext_hash; duplicated on t1_resolutions so the
    //     /v1/calls/:id read can serve both rows with one query.
    //   - fhe_circuit_id: FK into fhe_circuits, lets disputes replay
    //     the exact compiled circuit the score was computed against.
    //
    // Pure additive — legacy_plaintext and committed paths read the
    // unchanged t1_resolutions columns and never touch fhe_score_jobs.
    // Codex Z2 fix — table create + index are idempotent (`IF NOT EXISTS`),
    // but ALTER TABLE ADD COLUMN is NOT in SQLite. Apply the two ALTERs
    // through the existence-guarded helper so a partial-completion rerun
    // doesn't abort with "duplicate column name".
    db.exec(MIGRATION_025_TABLES);
    for (const { table, column, sql } of MIGRATION_025_ALTERS) {
      applyAlterTableAddColumn(db, table, column, sql);
    }
    v = 25;
    set.run("schema_version", String(v));
  }

  if (v < 26) {
    // Z3 — threshold score release.
    //
    // Four additive tables that wire the 5-of-9 threshold-key ceremony
    // described in docs/operator-blind-privacy-plan.md §3. The committee
    // decrypts ONLY the bounded score ciphertext (never the prediction)
    // and the row layout is intentionally narrow so the prediction
    // ciphertext / plaintext score never have a home here:
    //
    //   - fhe_key_holders: the 9-seat registry. `category` enforces the
    //     plan's seat composition (1 Murmur + 3 attesters + 3 agents +
    //     2 partners). `public_identity` is the ed25519 pubkey hex used
    //     to verify partial-decrypt signatures. `enabled`/`retired_at`
    //     drive holder rotation without breaking historical share rows.
    //   - fhe_decrypt_requests: one row per call's decrypt ceremony.
    //     `transcript_hash` binds the same canonical bytes the resolver
    //     hashed at score time (see canonicalTranscriptBytes() in
    //     fhe/provider.ts), so a holder can independently verify the
    //     request matches DB state before signing.  Status machine:
    //     `pending_shares` → `quorum_reached` → `released`, with
    //     `expired`/`frozen` as terminal failure states for ops.
    //   - fhe_decrypt_shares: one row per holder per request. The
    //     partial_decrypt blob is provider-specific opaque bytes; the
    //     share_signature is ed25519(request_hash || partial) so the
    //     transcript on /v1/calls/:id/fhe-transcript is third-party
    //     auditable.
    //   - fhe_score_releases: terminal record of a successful quorum
    //     release. `released_score` is the ONLY plaintext bounded score
    //     in v0 (also copied to t1_resolutions.call_score on release).
    //     `quorum_signatures` carries the JSON array of holder_id +
    //     pubkey + signature so anyone can replay the verification.
    //
    // Migration 026 is CREATE-only — no ALTER TABLE, so it's
    // unconditionally idempotent via `IF NOT EXISTS` and doesn't need
    // the applyAlterTableAddColumn helper (codex Z2 review fix #4 only
    // applied to the migration-025 ALTERs).
    db.exec(MIGRATION_026);
    v = 26;
    set.run("schema_version", String(v));
  }

  // Migration 027 is RESERVED for Z5 (production-gate for the FHE
  // threshold-committee promotion). Phase 11 takes 028 even though
  // 027 isn't filled yet — the gap is intentional so the FHE block
  // stays contiguous, and Z5 lands without renumbering Polymarket
  // state. The ladder helper `if (v < 27)` would simply be a no-op
  // here today; rather than ship a sentinel that has to be deleted
  // when Z5 lands, we let the version cursor jump straight to 28 on
  // a clean boot.

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
    // This migration is REGISTRY-only. Operational use of Polymarket
    // conditionIds via the agent /v2/calls path remains blocked on:
    //   1. MarketIdSchema regex (schema.ts) — currently constrains to
    //      lowercase dot-separated segments (e.g. 'eth.1h'); Polymarket
    //      conditionIds are '0x[hex64]'.
    //   2. AssetIdSchema enum — closed list of native-price assets;
    //      'polymarket:event' isn't a member.
    //   3. AcceptedCallSchema — native-price-shaped: requires asset_id,
    //      side, horizon_hours, oracle_policy. Z4 introduces the
    //      discriminated variant.
    //   4. submitCall rate limiters — per-asset cap keys on asset_id,
    //      which is meaningless for external markets.
    //
    // All four unblock together with Z4 (discriminated AcceptedCall +
    // adapter-aware schema variants). At that point the synthetic asset
    // + oracle seeded here become the anchor rows that external markets'
    // markets-row INSERTs reference, satisfying the NOT NULL FKs on
    // markets.asset_id and markets.primary_oracle_id without rewriting
    // the markets table.
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
// Existing legacy_plaintext rows still satisfy the relaxed constraints
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
//     agents.api_key_hash column for casual-tier agents. The legacy column
//     stays in place so wallet-only and benchmark agents keep working
//     until Phase 4 cuts the dispatcher over.
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

// ─── Migration 023 — Z0 FHE foundation (additive) ───────────────────────────
//
// Two tables, no backfill. Both are independent of submissions/agents
// so legacy_plaintext + committed paths are unaffected.
//
// fhe_keysets
//   - keyset_id: opaque PK; the submission path FKs against this in Z1.
//   - provider: provider that owns the secret share (today: mock,
//     zama_local; future: zama_kms, fhenix_cofhe). CHECK constraint
//     stays in step with `FheProviderName` in fhe/provider.ts.
//   - public_key_blob: provider-specific public-key serialization.
//     SQLite BLOB; size is provider-defined.
//   - public_key_hash: hex sha256(public_key_blob). Bound into the
//     commit preimage so an agent's submission pins which keyset it
//     was encrypted to (rotation safety).
//   - status: pending → active → suspended → revoked. Only `active`
//     keysets accept new submissions; older statuses are honored for
//     pending/in-flight calls.
//   - vector_max_len: max payout-vector length the keyset's compiled
//     circuits support. Z1's submission validator rejects vectors
//     longer than this.
//
// fhe_circuits
//   - circuit_id: opaque PK.
//   - name: 'half_l1_distance_binary' (length 2) or 'half_l1_distance_n'
//     (variable length up to vector_max_len). CHECK constraint matches
//     `FheCircuit["name"]` in fhe/provider.ts.
//   - (provider, name, vector_max_len) is a UNIQUE tuple — the resolver
//     uses it as the lookup key when dispatching to scoreEncrypted.
//   - handle: provider-specific compiled-artifact identifier (e.g.
//     circuit hash, file path on the sidecar).
//
// Indexes: status + provider on keysets for the active-keyset lookup;
// name on circuits for the resolver's dispatch.
const MIGRATION_023 = `
  CREATE TABLE IF NOT EXISTS fhe_keysets (
    keyset_id           TEXT PRIMARY KEY,
    provider            TEXT NOT NULL CHECK (provider IN ('mock','zama_local','zama_kms','fhenix_cofhe')),
    public_key_blob     BLOB NOT NULL,
    public_key_hash     TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('pending','active','suspended','revoked')),
    vector_max_len      INTEGER NOT NULL,
    created_at          TEXT NOT NULL,
    activated_at        TEXT,
    suspended_at        TEXT,
    notes               TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fhe_keysets_status ON fhe_keysets(status);
  CREATE INDEX IF NOT EXISTS idx_fhe_keysets_provider ON fhe_keysets(provider);

  CREATE TABLE IF NOT EXISTS fhe_circuits (
    circuit_id          TEXT PRIMARY KEY,
    name                TEXT NOT NULL CHECK (name IN ('half_l1_distance_binary','half_l1_distance_n')),
    description         TEXT,
    vector_max_len      INTEGER NOT NULL,
    compiled_at         TEXT NOT NULL,
    provider            TEXT NOT NULL CHECK (provider IN ('mock','zama_local','zama_kms','fhenix_cofhe')),
    handle              TEXT NOT NULL,
    UNIQUE (provider, name, vector_max_len)
  );
  CREATE INDEX IF NOT EXISTS idx_fhe_circuits_name ON fhe_circuits(name);
`;

// ─── Migration 024 — fhe_call_ciphertexts (Z1) ──────────────────────────────
//
// Stores per-call encrypted payout vectors for fhe_direct submissions.
// One row per accepted fhe_direct call; FK cascades on submissions
// delete so a developer's local rollback / dev wipe of submissions
// doesn't leave orphan ciphertext rows.
//
// `ciphertext_blob` is BLOB (binary) not TEXT — base64 is the wire
// shape, the database stores raw decoded bytes so byte-for-byte
// dispute replay reproduces the same sha256 without re-decoding.
//
// `payout_denominator` is TEXT (decimal-stringified bigint) because
// SQLite INTEGER caps at 2^63-1 and the universal Commitment shape
// allows arbitrary-precision denominators. Same convention as
// `submissions.commitment_json`'s payoutDenominator field.
const MIGRATION_024 = `
  CREATE TABLE IF NOT EXISTS fhe_call_ciphertexts (
    call_id              TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    keyset_id            TEXT NOT NULL REFERENCES fhe_keysets(keyset_id),
    circuit_id           TEXT NOT NULL REFERENCES fhe_circuits(circuit_id),
    ciphertext_format    TEXT NOT NULL,
    ciphertext_blob      BLOB NOT NULL,
    ciphertext_hash      TEXT NOT NULL,
    vector_len           INTEGER NOT NULL,
    payout_denominator   TEXT NOT NULL,
    nonce                TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    UNIQUE (ciphertext_hash),
    UNIQUE (keyset_id, nonce)
  );
  CREATE INDEX IF NOT EXISTS idx_fhe_ct_keyset ON fhe_call_ciphertexts(keyset_id);
  CREATE INDEX IF NOT EXISTS idx_fhe_ct_format ON fhe_call_ciphertexts(ciphertext_format);
`;

// ─── Migration 025 — fhe_score_jobs + t1_resolutions FHE pointers (Z2) ──────
//
// One row per fhe_direct call once the resolver has tried to score it.
// Status machine:
//   - queued                  — resolver pushed a job, sidecar not yet called
//   - running                 — score attempt in flight (set/cleared by caller)
//   - scored_pending_decrypt  — sidecar returned an encrypted score; awaiting Z3
//   - failed                  — terminal-ish; attempts column + last_error tell
//                               the operator what to do
//
// `attempts` increments on every retry so a stuck call surfaces quickly in
// /v1/readyz; the resolver decides when to give up based on this count, not
// on a hardcoded clock. Cold-start posture (plan §5): if the sidecar is
// unavailable, the JOB row records the failure but the CALL stays
// pending_t1, never downgrades to plaintext.
//
// score_ciphertext is BLOB (raw bytes from the provider). score_ciphertext_hash
// is sha256 hex; transcript_hash is the provider-attested binding hash.
//
// Codex Z2 review FAIL #4 — `ALTER TABLE ... ADD COLUMN` is NOT idempotent in
// SQLite: a rerun (e.g. after a crash between the ALTER and the schema_version
// bump, or a manual fix) hits "duplicate column name" and aborts the
// migration. Splitting MIGRATION_025 into the idempotent CREATE TABLE block
// (still safe to re-run) and the two ALTERs which apply applyAlterTable() —
// a helper that no-ops when the target column already exists.
const MIGRATION_025_TABLES = `
  CREATE TABLE IF NOT EXISTS fhe_score_jobs (
    call_id              TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    status               TEXT NOT NULL CHECK (status IN ('queued','running','scored_pending_decrypt','failed')),
    provider             TEXT NOT NULL,
    circuit_id           TEXT NOT NULL REFERENCES fhe_circuits(circuit_id),
    score_ciphertext     BLOB,
    score_ciphertext_hash TEXT,
    transcript_hash      TEXT,
    attempts             INTEGER NOT NULL DEFAULT 0,
    last_attempt_at      TEXT,
    last_error           TEXT,
    computed_at          TEXT,
    created_at           TEXT NOT NULL,
    UNIQUE (call_id)
  );
  CREATE INDEX IF NOT EXISTS idx_fhe_score_jobs_status ON fhe_score_jobs(status);
`;

// ─── Migration 026 — Z3 threshold-key ceremony tables ──────────────────────
//
// Pure CREATE-only block (no ALTER TABLE), so it is safe to re-run on a
// half-applied state. The schema is locked-in by docs/operator-blind-
// privacy-plan.md §3 — see the prose in applyMigrations() above for why
// each table looks the way it does.
const MIGRATION_026 = `
  CREATE TABLE IF NOT EXISTS fhe_key_holders (
    holder_id           TEXT PRIMARY KEY,
    category            TEXT NOT NULL CHECK (category IN ('murmur','attester','agent','partner')),
    display_name        TEXT NOT NULL,
    public_identity     TEXT NOT NULL,
    enabled             INTEGER NOT NULL DEFAULT 1,
    registered_at       TEXT NOT NULL,
    retired_at          TEXT
  );

  CREATE TABLE IF NOT EXISTS fhe_decrypt_requests (
    request_id            TEXT PRIMARY KEY,
    call_id               TEXT NOT NULL REFERENCES submissions(call_id) ON DELETE CASCADE,
    score_ciphertext_hash TEXT NOT NULL,
    transcript_hash       TEXT NOT NULL,
    resolved_outcome_hash TEXT NOT NULL,
    keyset_id             TEXT NOT NULL,
    status                TEXT NOT NULL CHECK (status IN ('pending_shares','quorum_reached','released','expired','frozen')),
    created_at            TEXT NOT NULL,
    released_at           TEXT,
    expires_at            TEXT,
    UNIQUE (call_id, score_ciphertext_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_fhe_decrypt_requests_status ON fhe_decrypt_requests(status);

  CREATE TABLE IF NOT EXISTS fhe_decrypt_shares (
    share_id            TEXT PRIMARY KEY,
    request_id          TEXT NOT NULL REFERENCES fhe_decrypt_requests(request_id) ON DELETE CASCADE,
    holder_id           TEXT NOT NULL REFERENCES fhe_key_holders(holder_id),
    partial_decrypt     BLOB NOT NULL,
    share_signature     TEXT NOT NULL,
    submitted_at        TEXT NOT NULL,
    UNIQUE (request_id, holder_id)
  );

  CREATE TABLE IF NOT EXISTS fhe_score_releases (
    request_id          TEXT PRIMARY KEY REFERENCES fhe_decrypt_requests(request_id) ON DELETE CASCADE,
    call_id             TEXT NOT NULL,
    released_score      REAL NOT NULL CHECK (released_score >= 0 AND released_score <= 1),
    quorum_signatures   TEXT NOT NULL,
    released_at         TEXT NOT NULL
  );
`;

// ─── Migration 028 — Polymarket sync state (Phase 11) ──────────────────────
//
// Per-conditionId scratch pad for the Polymarket Gamma sync ticker. Every
// row is owned by exactly one markets entry (FK ON DELETE CASCADE) and
// keyed back to the adapter via `adapter_id` for fast per-adapter sweeps.
// CREATE-only — idempotent under `IF NOT EXISTS`, same posture as
// MIGRATION_026.
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

const MIGRATION_025_ALTERS: ReadonlyArray<{ table: string; column: string; sql: string }> = [
  {
    table: "t1_resolutions",
    column: "score_ciphertext_hash",
    sql: "ALTER TABLE t1_resolutions ADD COLUMN score_ciphertext_hash TEXT",
  },
  {
    table: "t1_resolutions",
    column: "fhe_circuit_id",
    sql: "ALTER TABLE t1_resolutions ADD COLUMN fhe_circuit_id TEXT REFERENCES fhe_circuits(circuit_id)",
  },
];

/**
 * Apply an ALTER TABLE ADD COLUMN only if the column doesn't already exist.
 * SQLite's PRAGMA table_info() is the canonical existence check. Used by
 * Migration 025 (codex Z2 review FAIL #4) so rerunning the migration after a
 * crash between the ALTER and the schema_version bump is safe.
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

  /**
   * Mutate an agent's `kind` post-registration.
   *
   * V2 §7.1 + §7.7 risk-2 invariant: tier is immutable per agent. Switching
   * tiers requires registering a NEW agent (new agent_id, fresh reputation).
   * The plan's stated motivation is anti-downgrade — an `attested` agent
   * forfeiting their Olas bond by silently flipping to `casual`.
   *
   * Two legitimate exceptions live today:
   *   1. `claim` flow: `shadow` → `verified` when an operator proves
   *      control of the X/Telegram identity that produced the shadow
   *      ingested posts. The shadow agent is a NON-OPERATOR-MINTED row
   *      (auto-created by the post ingester); the operator's claim
   *      converts it into their canonical identity. This is upgrade-only
   *      and explicitly sanctioned by the claim flow.
   *   2. `wallet-only claim` flow: pre-registered `shadow` self-claimed
   *      as `wallet_only` by an operator who proves wallet control. Same
   *      upgrade-only constraint.
   *
   * Wave 4d guard:
   *   - Callers MUST pass an explicit `{ reason }` marker so accidental
   *     in-place mutations elsewhere in the codebase grep / fail-loud.
   *   - Generic admin overrides require `MURMUR_ADMIN_TIER_OVERRIDE=1`.
   *   - The mutation is recorded via `usage_events` (caller responsibility)
   *     so the §7.7 audit trail picks up every transition.
   *
   * Throws when the caller is neither a sanctioned claim flow nor an
   * env-gated admin override.
   */
  setKind(
    db: Database.Database,
    agent_id: string,
    kind: AgentKind,
    opts: {
      reason:
        | "claim_completed_verified"
        | "claim_completed_wallet_only"
        | "admin_override";
    },
  ): void {
    if (
      opts.reason === "admin_override" &&
      process.env.MURMUR_ADMIN_TIER_OVERRIDE !== "1"
    ) {
      throw new Error(
        "agentsRepo.setKind: admin_override requires MURMUR_ADMIN_TIER_OVERRIDE=1",
      );
    }
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
  /** FIX 5 / migration 016 — adapter dispatch stamps. Migration 016 backfills
   *  these on EXISTING rows; new rows must populate at insert time so the
   *  family / adapter columns aren't NULL after the deploy. Both nullable
   *  here for resilience: if the caller resolves a market that doesn't
   *  carry adapter_id (e.g. a forward-compat market row pre-adapter), we
   *  fall back to ('native-price', 'financial-direction') at the call site
   *  the same way migration 016 does. */
  adapter_id?: string | null;
  market_family?: string | null;
  /** Phase 4 — universal-commitment storage stamps (V2 §2.2). Caller
   *  (submitCall) derives a {@link Commitment} from the legacy submission
   *  via `legacySubmissionToCommitment` for /v1 and uses the validated
   *  v2 body directly for /v2. Both columns persist the wire-shape JSON
   *  (bigints stringified) so the resolver's universal hot path can read
   *  them without re-deriving. NULL stays acceptable so smoke / legacy
   *  paths that haven't migrated still write — Phase 5's resolver falls
   *  back to {@link legacySubmissionToCommitment} when null.
   *  Render-only `outcome_labels_json` carries the adapter's labels for
   *  the payout vector positions (e.g. ['UP','DOWN'] for native-price).
   */
  commitment_json?: string | null;
  predicted_outcome_json?: string | null;
  outcome_labels_json?: string | null;
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
  /** Inserts submission + oracle policy atomically. (Wave 4b — receipts gone;
   *  Wave 4b-2 — Santiment-derived preflight insert gone.) */
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
          market_id, market_config_version,
          adapter_id, market_family,
          commitment_json, predicted_outcome_json, outcome_labels_json)
         VALUES (@call_id, @agent_id, @client_order_id, @asset_id, @side,
          @horizon_hours, @horizon_seconds,
          @confidence, @submitted_at, @accepted_at, @status, @rationale, @strategy_tag,
          @schema_version, @scoring_version, @dedup_key,
          @privacy_mode, @commit_hash, @commit_scheme,
          @market_id, @market_config_version,
          @adapter_id, @market_family,
          @commitment_json, @predicted_outcome_json, @outcome_labels_json)`,
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
        // BUG FIX (codex review v3 P2 #2): stamp adapter_id + market_family
        // at insert time. Migration 016 backfills legacy rows to
        // ('native-price', 'financial-direction'); new submissions accepted
        // after the deploy must populate the same defaults so family
        // filters and adapter dispatch don't see NULL columns. Caller
        // (submitCall) passes the values it looked up off the market row
        // — same fallback as the migration when a market predates adapters.
        adapter_id: i.adapter_id ?? null,
        market_family: i.market_family ?? null,
        // Phase 4 — universal commitment columns. /v2/calls passes the
        // body-supplied Commitment (validated by adapter.commitmentSchema);
        // /v1/calls derives via legacySubmissionToCommitment so the
        // resolver's universal hot path can read both submit shapes
        // uniformly without falling back to inverse derivation per call.
        commitment_json: i.commitment_json ?? null,
        predicted_outcome_json: i.predicted_outcome_json ?? null,
        outcome_labels_json: i.outcome_labels_json ?? null,
      });
      // Wave 4b-2 — preflights insert (Santiment-derived) gone. The
      // preflights TABLE survives in the schema as a vestigial empty
      // table; a future migration can drop it. Murmur is a pure ranking
      // layer over canonical price/event oracles — no sentiment metadata.
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
      // Wave 4b — receipts table dropped; calls + reveals + resolutions
      // are the canonical evidence trail. The acceptance receipt insert
      // that lived here previously is gone.
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
    // Phase E hydration: after MURMUR_PHASE_E_CLEANUP=1, asset_id on
    // committed-mode submissions is NULL — the canonical asset still
    // lives in call_reveals when reveal_hash_valid=1. LEFT JOIN +
    // COALESCE keeps cleaned committed rows inside the per-asset rate
    // cap so an agent can't slip the cap by repeatedly using committed
    // mode and waiting for the boot-time scrub to drop them out.
    // Legacy plaintext rows (no call_reveals) fall through to s.asset_id
    // unchanged.
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM submissions s
       LEFT JOIN call_reveals cr ON cr.call_id = s.call_id
       WHERE s.agent_id = ?
         AND COALESCE(s.asset_id, cr.asset_id) = ?
         AND s.accepted_at >= ?`,
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
    primary_feed: string;
    fallback_feed: string | null;
    primary_max_staleness_sec: number;
    fallback_max_staleness_sec: number | null;
    t0_grace_seconds: number;
    t0_extended_grace_seconds: number;
    // P4 Item 4: per-call market stamps for dispute / verify replay.
    // Null on pre-Phase-1 legacy rows; downstream falls back to global
    // VOID_BAND when null.
    market_id: string | null;
    market_config_version: number | null;
  } | null {
    // Phase E hydration: after MURMUR_PHASE_E_CLEANUP=1, the plaintext
    // columns on committed-mode submissions are NULL — the canonical
    // values still live in call_reveals when reveal_hash_valid=1. The
    // dispute resolver / replay path consumes these columns, so we
    // LEFT JOIN call_reveals and COALESCE side / asset_id / confidence /
    // horizon_hours. Legacy plaintext rows (no call_reveals) fall
    // through to s.* unchanged.
    return (
      (prep(
        db,
        `SELECT s.call_id, s.agent_id,
                COALESCE(s.asset_id, cr.asset_id)             AS asset_id,
                COALESCE(s.side, cr.side)                     AS side,
                COALESCE(s.horizon_hours, cr.horizon_hours)   AS horizon_hours,
                s.horizon_seconds,
                COALESCE(s.confidence, cr.confidence)         AS confidence,
                s.accepted_at, s.status, s.privacy_mode, s.commit_hash,
                s.market_id, s.market_config_version,
                op.primary_feed, op.fallback_feed,
                op.primary_max_staleness_sec, op.fallback_max_staleness_sec,
                op.t0_grace_seconds, op.t0_extended_grace_seconds
         FROM submissions s
         JOIN oracle_policies op ON op.call_id = s.call_id
         LEFT JOIN call_reveals cr ON cr.call_id = s.call_id
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
            market_id: string | null;
            market_config_version: number | null;
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
      // Phase 5 — universal payout-vector columns (MIGRATION_016). Both
      // optional so legacy callers (oracle_unavailable terminal path,
      // re-resolution disputes path) can keep writing without supplying
      // the universal shape. NULL → leaderboard reads continue to use
      // the legacy `outcome`/`call_score` columns; new universal-shape
      // consumers fall through to the legacy view via the resolver-side
      // mapping (see scoreOutcomeVector void-mapping rule).
      resolved_outcome_json?: string | null;
      payout_vector_json?: string | null;
      // Z2 — encrypted-score pointers (MIGRATION_025). Populated only for
      // fhe_direct rows; legacy_plaintext/committed rows keep these NULL.
      // The plaintext call_score column stays NULL for fhe_direct until
      // Z3's threshold release decrypts the score ciphertext.
      score_ciphertext_hash?: string | null;
      fhe_circuit_id?: string | null;
    },
  ): void {
    prep(
      db,
      `INSERT INTO t1_resolutions
       (call_id, t1, p1, t1_feed, signed_return, outcome, call_score, resolved_at,
        resolved_outcome_json, payout_vector_json,
        score_ciphertext_hash, fhe_circuit_id)
       VALUES (@call_id, @t1, @p1, @t1_feed, @signed_return, @outcome, @call_score, @resolved_at,
               @resolved_outcome_json, @payout_vector_json,
               @score_ciphertext_hash, @fhe_circuit_id)
       ON CONFLICT(call_id) DO UPDATE SET
         t1 = excluded.t1, p1 = excluded.p1, t1_feed = excluded.t1_feed,
         signed_return = excluded.signed_return, outcome = excluded.outcome,
         call_score = excluded.call_score, resolved_at = excluded.resolved_at,
         resolved_outcome_json = excluded.resolved_outcome_json,
         payout_vector_json = excluded.payout_vector_json,
         score_ciphertext_hash = excluded.score_ciphertext_hash,
         fhe_circuit_id = excluded.fhe_circuit_id`,
    ).run({
      ...input,
      resolved_outcome_json: input.resolved_outcome_json ?? null,
      payout_vector_json: input.payout_vector_json ?? null,
      score_ciphertext_hash: input.score_ciphertext_hash ?? null,
      fhe_circuit_id: input.fhe_circuit_id ?? null,
    });
  },

  loadFullCall(
    db: Database.Database,
    call_id: string,
  ): {
    submission: {
      call_id: string;
      agent_id: string;
      client_order_id: string;
      // Plaintext columns. NULL when privacy_mode='fhe_direct' (the submit
      // path explicitly nulls these — see submitFheDirectCall in
      // submissions.ts). Public surfaces MUST route this object through
      // projectCallRow to honour shouldExposePlaintext rather than trust
      // the column-present-and-typed shape; the nullable types here
      // enforce that contract at the type system layer (codex Z2 Drift B).
      asset_id: string | null;
      side: "BUY" | "SELL" | null;
      horizon_hours: number | null;
      confidence: number | null;
      submitted_at: string;
      accepted_at: string;
      status: CallStatus;
      rationale: string | null;
      strategy_tag: string | null;
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
          // Phase 5 — universal payout-vector additive fields. NULL when
          // the v2 dispatch path didn't run (legacy resolutions pre-cutover
          // or markets without a registered adapter). Wire shape — strings
          // round-trip through deserializeOutcome / parseStoredCommitment.
          resolved_outcome_json: string | null;
          payout_vector_json: string | null;
          // Z2 — encrypted-score pointers. Populated only for fhe_direct
          // rows whose resolver tick computed an encrypted score; NULL
          // for legacy_plaintext / committed / oracle_unavailable rows.
          score_ciphertext_hash: string | null;
          fhe_circuit_id: string | null;
        }
      | null;
  } | null {
    // Codex Z2 Drift B fix — explicit column list instead of `SELECT s.*`.
    // SELECT * is fail-open against future plaintext columns: if a
    // maintainer adds e.g. `predicted_outcome_json` to submissions and a
    // consumer later widens this return type to forward it, the column
    // would be in the row dict the day the column lands, with no audit
    // moment. Enumerating columns here forces a deliberate review when
    // anything new gets surfaced.
    const subRow = prep(
      db,
      `SELECT call_id, agent_id, client_order_id,
              asset_id, side, horizon_hours, confidence,
              submitted_at, accepted_at, status,
              rationale, strategy_tag
       FROM submissions
       WHERE call_id = ?`,
    ).get(call_id) as
      | {
          call_id: string;
          agent_id: string;
          client_order_id: string;
          asset_id: string | null;
          side: string | null;
          horizon_hours: number | null;
          confidence: number | null;
          submitted_at: string;
          accepted_at: string;
          status: CallStatus;
          rationale: string | null;
          strategy_tag: string | null;
        }
      | undefined;
    if (!subRow) return null;
    const t0Row = prep(
      db,
      "SELECT t0, p0, feed FROM t0_anchors WHERE call_id = ?",
    ).get(call_id) as { t0: string; p0: string; feed: string } | undefined;
    // Same explicit-column treatment for t1_resolutions. The Z2 + Phase 5
    // additive columns (resolved_outcome_json, payout_vector_json,
    // score_ciphertext_hash, fhe_circuit_id) are pulled by name so adding
    // a future column (e.g. a raw plaintext score) does NOT auto-surface
    // here.
    const resRow = prep(
      db,
      `SELECT t1, p1, t1_feed, signed_return, outcome, call_score,
              resolved_at, resolved_outcome_json, payout_vector_json,
              score_ciphertext_hash, fhe_circuit_id
       FROM t1_resolutions
       WHERE call_id = ?`,
    ).get(call_id) as
      | {
          t1: string;
          p1: string;
          t1_feed: string;
          signed_return: string;
          outcome: string;
          call_score: number | null;
          resolved_at: string;
          resolved_outcome_json: string | null;
          payout_vector_json: string | null;
          score_ciphertext_hash: string | null;
          fhe_circuit_id: string | null;
        }
      | undefined;
    return {
      submission: {
        call_id: subRow.call_id,
        agent_id: subRow.agent_id,
        client_order_id: subRow.client_order_id,
        asset_id: subRow.asset_id,
        // SQLite NULL → null; otherwise narrow into the 'BUY' | 'SELL'
        // enum via a runtime guard. The MIGRATION_001 CHECK that bounded
        // submissions.side to BUY/SELL was lifted in MIGRATION_015 (the
        // column went to nullable plain TEXT to accommodate fhe_direct
        // rows that null all plaintext fields). Application-layer
        // validation (SubmittedCallSchema's SideSchema) is the live
        // guard on the write path; this runtime guard is the
        // matching fail-closed on the read path.
        side: subRow.side === "BUY" || subRow.side === "SELL" ? subRow.side : null,
        horizon_hours: subRow.horizon_hours,
        confidence: subRow.confidence,
        submitted_at: subRow.submitted_at,
        accepted_at: subRow.accepted_at,
        status: subRow.status,
        rationale: subRow.rationale,
        strategy_tag: subRow.strategy_tag,
      },
      t0: t0Row ?? null,
      resolution: resRow
        ? {
            t1: resRow.t1,
            p1: resRow.p1,
            t1_feed: resRow.t1_feed,
            signed_return: resRow.signed_return,
            outcome: resRow.outcome,
            call_score: resRow.call_score ?? null,
            resolved_at: resRow.resolved_at,
            // Phase 5 — universal columns. NULL when the v2 path didn't
            // run; downstream call.resolved emit reads these and skips
            // populating the additive event fields.
            resolved_outcome_json: resRow.resolved_outcome_json,
            payout_vector_json: resRow.payout_vector_json,
            // Z2 additions — see resolutionsRepo.setResolution input shape.
            score_ciphertext_hash: resRow.score_ciphertext_hash,
            fhe_circuit_id: resRow.fhe_circuit_id,
          }
        : null,
    };
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
       (dispute_id, target_call_id, grounds, notes, filed_by, filed_at, status, resolved_at)
       VALUES (@dispute_id, @target_call_id, @grounds, @notes, @filed_by, @filed_at, @status, @resolved_at)`,
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
  ): void {
    prep(
      db,
      `UPDATE disputes
       SET status = ?, resolved_at = ?
       WHERE dispute_id = ?`,
    ).run(status, resolved_at, dispute_id);
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
  // FIX 5 — adapter dispatch surface columns. Backfilled by MIGRATION_016
  // for every existing row to ('native-price','financial-direction').
  // Stay nullable for forward-compat: a future row could land before its
  // adapter is registered.
  adapter_id: string | null;
  market_family: string | null;
  // Codex P11 review Critical B fix — adapter-private config (e.g.
  // Polymarket's conditionId/slug/outcomes/endDate snapshot). NOT NULL
  // with default '{}' at the schema level; native-price markets carry
  // an empty object today. The resolver parses this and spreads it into
  // adapter.observeResolution() context.
  config_json: string;
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
   * the prior version know they were resolved under different rules.
   *
   * P4 Phase A (Codex audit): bumpConfig now appends the NEW version's
   * snapshot to market_config_history INSIDE the same transaction as
   * the markets UPDATE. Audit-time replay can reconstruct the policy at
   * any version via `getConfigAt(db, market_id, version)`.
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

    db.transaction(() => {
      prep(
        db,
        `UPDATE markets
         SET ${setClause}, market_config_version = market_config_version + 1
         WHERE market_id = @market_id`,
      ).run({ ...patch, market_id });

      // Append snapshot for the new version. The history row's
      // market_config_version matches the row that's now live in markets.
      prep(
        db,
        `INSERT INTO market_config_history
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
           strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         FROM markets
         WHERE market_id = @market_id`,
      ).run({ market_id });
    })();
  },

  /**
   * Look up the historical snapshot of a market at a specific config
   * version. Returns the snapshot fields parsed from JSON, or null when
   * the (market_id, version) pair is unknown.
   *
   * Audit-time replay path: a v2 receipt carries (market_id,
   * market_config_version) — verifiers call getConfigAt to get the
   * exact policy under which the call was minted, regardless of any
   * later bumpConfig calls.
   *
   * Fail-closed: returns null on missing rows. Callers MUST check for
   * null and refuse to proceed (e.g., disputes / verify replay) rather
   * than falling back to the live markets row.
   */
  getConfigAt(
    db: Database.Database,
    market_id: string,
    market_config_version: number,
  ): MarketConfigSnapshot | null {
    const row = prep(
      db,
      `SELECT snapshot_json, recorded_at FROM market_config_history
       WHERE market_id = ? AND market_config_version = ?`,
    ).get(market_id, market_config_version) as
      | { snapshot_json: string; recorded_at: string }
      | undefined;
    if (!row) return null;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.snapshot_json) as Record<string, unknown>;
    } catch {
      return null;
    }
    return {
      market_id,
      market_config_version,
      asset_id: parsed.asset_id as string,
      market_kind: parsed.market_kind as MarketKind,
      horizon_seconds: parsed.horizon_seconds as number,
      primary_oracle_id: parsed.primary_oracle_id as string,
      fallback_oracle_id: (parsed.fallback_oracle_id as string | null) ?? null,
      primary_max_staleness_sec: parsed.primary_max_staleness_sec as number,
      fallback_max_staleness_sec:
        (parsed.fallback_max_staleness_sec as number | null) ?? null,
      t0_grace_seconds: parsed.t0_grace_seconds as number,
      t0_extended_grace_seconds: parsed.t0_extended_grace_seconds as number,
      void_band: parsed.void_band as string,
      round_cadence_seconds:
        (parsed.round_cadence_seconds as number | null) ?? null,
      scoring_kind: parsed.scoring_kind as ScoringKind,
      recorded_at: row.recorded_at,
    };
  },
};

/**
 * Replay-safe snapshot of a market's config at a specific version.
 * Mirrors the columns of MarketRow that affect resolution, plus
 * recorded_at for audit visibility.
 */
export interface MarketConfigSnapshot {
  market_id: string;
  market_config_version: number;
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
  recorded_at: string;
}

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
