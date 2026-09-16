import type Database from "better-sqlite3";

import { SCHEMA_VERSION, SCORING_VERSION } from "./schema.js";

export const LATEST_DB_MIGRATION_VERSION = 81 as const;

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
    // no rebuild. DDL + schema_meta bump share one
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
    // Relax NOT NULL on the plaintext market-signal columns; committed-mode
    // rows leave them empty. The destructive plaintext scrub is NOT here — it
    // lives in phase-e-cleanup.ts behind MURMUR_PHASE_E_CLEANUP so operators
    // can flip the env on any boot, not only the one that crosses schema 15.
    // Temp name differs from 010's so a half-applied 010 retry can't collide.
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
    // Additive v2 commitment + outcome columns. DDL, backfill and the version
    // bump share one transaction. The JSON bags are validated at write time in
    // the adapter; adapter_id / market_family stay open (no CHECK) so a new
    // market family never needs a migration.
    db.transaction(() => {
      db.exec(MIGRATION_016);
      set.run("schema_version", "16");
    })();
    v = 16;
  }

  if (v < 17) {
    // accounts (one per Privy user), account_agents, api_keys.
    //
    // account_agents is a bridge table even though one-account-per-agent is
    // the policy today — relaxing that later then costs no migration.
    // agents.api_key_hash is deliberately left intact so benchmark agents keep
    // authenticating until the dispatcher cuts over.
    //
    // Keys store sha256(secret); plaintext is returned once by mintApiKey and
    // never persisted. Rotation is soft — rotated_at set means invalid — so
    // the audit trail survives.
    db.transaction(() => {
      db.exec(MIGRATION_017);
      set.run("schema_version", "17");
    })();
    v = 17;
  }

  if (v < 18) {
    // Allow receipts.kind = 'resolution_v2' so the resolver can dual-write the
    // payout-vector receipt beside the legacy one. A rebuild, not an ALTER —
    // SQLite cannot change a CHECK in place.
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
    // UNIQUE(agent_id) on account_agents so one-owner-per-agent is enforced by
    // the DB, not just by linkAgentToAccount — which could otherwise race.
    // The copy takes MIN(created_at) per agent_id, so if duplicates ever exist
    // the first owner wins instead of the rebuild aborting on the constraint.
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
    // Drop receipts (the call + reveal + resolution rows are canonical) and
    // rekey disputes onto target_call_id. The dispute copy resolves each old
    // receipt_hash → call_id by joining receipts, which is why the DROP comes
    // last; orphaned rows that no longer resolve are dropped with a warning.
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
    // preflights held Santiment risk metadata. That integration is gone and the
    // table has had no writers or readers since; nothing FKs into it.
    db.exec("DROP TABLE IF EXISTS preflights;");
    v = 21;
    set.run("schema_version", String(v));
  }

  if (v < 22) {
    // RESERVED NO-OP. Claimed so the ladder stays dense: a DB that already
    // booted past 22 would skip any migration later assigned to this slot.
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
    // external_market_sync_state — the Polymarket ticker's scratch pad: poll
    // cadence, observed status, the consecutive-404 counter behind the
    // MARKET_DISAPPEARED alert, and one-shot alert stamps. Resolution state
    // still lives on t1_resolutions like every other adapter.
    db.exec(MIGRATION_028);
    v = 28;
    set.run("schema_version", String(v));
  }

  if (v < 29) {
    // Widen the oracles.kind CHECK to admit 'external_adapter', then seed the
    // synthetic Polymarket asset + oracle. A rebuild because SQLite cannot
    // replace a CHECK in place. Later adapters (Kalshi, Drift) reuse
    // 'external_adapter' with their own oracle_id and need no migration.
    //
    // The seed rows are the anchors that external `markets` inserts FK to, so
    // they must land in the SAME transaction as the version bump: a crash
    // between the two would leave v=29 with no seed and the guard would skip
    // it forever. Hence the concatenation below rather than a second exec.
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
    // The operator-blind reshape: drop six emptied tables, drop the four
    // plaintext market-signal columns (the last DB-level leakage paths — an
    // FHE-only submit keeps everything load-bearing inside the Commitment
    // ciphertext), collapse agents.kind to four values, and reserve
    // program_version on both tables.
    //
    // Four sub-steps, each idempotent on its own so a crashed run converges.
    // The CASE-WHEN enum remap is a no-op on already-remapped data — none of
    // the WHEN branches match a modern value.
    //
    // Two rebuilds, not one, because the helper takes a single (original,
    // temp) tuple and the temp names must differ. The agents rebuild bumps
    // nothing; the schema_version=31 bump rides inside the submissions
    // transaction, so the boundary is all-or-nothing.
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
    // agent_security_events — append-only audit log for admin actions that
    // move an agent's ownership or a sensitive registry slot.
    //
    // Deliberately NOT FK'd to agents.agent_id: the log has to survive an
    // admin-driven CASCADE delete of the agent itself. Readers LEFT JOIN
    // agents when they need the live row.
    db.exec(MIGRATION_032);
    v = 32;
    set.run("schema_version", String(v));
  }

  if (v < 33) {
    // markets.config_json — the MarketRow type declared it but no migration
    // ever added it, so the Polymarket upsert and every resolver tick that
    // touched a Polymarket row failed with `no such column`. NOT NULL DEFAULT
    // '{}' lands native-price rows in the shape parseMarketConfigJson expects.
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
    // nanopay_receipts — one row per paid inference call on /v2/nanopay/infer.
    //
    // The settling_intent row is written BEFORE Circle /v1/x402/settle, so a
    // crash mid-settle leaves something to reconcile rather than free-serving.
    //
    // Idempotency is composite because EIP-3009 nonces are unique per payer,
    // not globally: payer + source domain + both content hashes. The
    // pre-settle lookup turns "same payer+nonce, different payload" into a
    // 409 before Circle is ever called.
    //
    // binding_json / reveal_artifact_json carry the single-stream invariant:
    // the served signal is the sealed-Fhenix-anchored signal.
    db.exec(MIGRATION_051_NANOPAY_RECEIPTS);
    v = 51;
    set.run("schema_version", String(v));
  }

  if (v < 52) {
    // Rename eip3009_nonce → payment_handle: the SDK middleware verifies and
    // consumes the nonce before the handler runs, so the column actually holds
    // Circle's transaction UUID. The index is dropped and recreated because
    // RENAME COLUMN rewrites the definition but not the index name.
    //
    // Transactional: a crash after the rename but before the version bump
    // would leave the next boot renaming a column that no longer exists, with
    // no recovery path.
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
    // Admit two operator-audit event kinds: admin_fhenix_gateway_retry and
    // admin_fhenix_feed_packet_backfill. A rebuild — SQLite CHECKs are closed.
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
    // Drop UNIQUE(wallet_address, chain_id): the real model is one wallet per
    // Privy account across N agents, so cross-account collisions are gated in
    // controller-wallets.ts instead. agent_id stays PRIMARY KEY, so an agent
    // still has at most one binding. A rebuild — SQLite has no DROP CONSTRAINT.
    applyTableRebuildMigration(
      db,
      MIGRATION_054,
      () => {
        // Persist 54, not LATEST: a crash before 055 must leave an honest
        // version that re-runs 055 on the next boot.
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
        // Persist 55, not LATEST — see the 054 block.
        set.run("schema_version", "55");
      },
      ["t1_resolutions", "t1_resolutions_v055"],
    );
    v = 55;
  }

  if (v < 56) {
    // polymarket_discovery_state — the durable per-conditionId ledger of the
    // discovery ticker's registration attempts. It survives a crash so a
    // broadcast whose receipt was lost is reconciled against chain state
    // instead of re-spending gas, and the rate caps are counted from it.
    // polymarket_discovery_health is the single-row tick heartbeat the alert
    // scanner reads.
    db.transaction(() => {
      db.exec(MIGRATION_056_POLYMARKET_DISCOVERY);
      set.run("schema_version", "56");
    })();
    v = 56;
  }

  if (v < 57) {
    // fhenix_reveal_jobs — one row per sealed call the fallback reveal worker
    // owns after the agent grace window. It persists tx hashes, partial
    // threshold-decrypt results and phase so a restart never re-opens or
    // re-publishes a call whose receipt was lost.
    //
    // reveal_sender / reveal_source on fhenix_sealed_calls are the attribution
    // evidence behind honest daemon_fallback_reveals and reveal_reliability.
    // NULL on rows revealed before this migration — backfilling would need an
    // RPC sweep of every receipt.from.
    db.transaction(() => {
      db.exec(MIGRATION_057_FHENIX_REVEAL_JOBS);
      set.run("schema_version", "57");
    })();
    v = 57;
  }

  if (v < 58) {
    // tx_broadcast_at is the reveal worker's broadcast watermark. Without it a
    // dropped or nonce-gapped tx — which never produces a receipt — is
    // indistinguishable from one still mining, and the worker waits forever.
    // Past the staleness threshold it re-broadcasts and unsticks the EOA nonce.
    //
    // The `missed` reset recovers rows the old time-only terminalization path
    // auto-marked. Calls have no reveal expiry, so those rows are still
    // revealable and go back to `pending`. `missed` now means a manually
    // established irrecoverable condition, nothing else.
    db.transaction(() => {
      db.exec(MIGRATION_058_REVEAL_WORKER_SELFHEAL);
      set.run("schema_version", "58");
    })();
    v = 58;
  }

  if (v < 59) {
    // entitlements — the state machine for a subscriber paying for early
    // private decrypt access to a sealed call. The UNIQUE reservation is
    // inserted BEFORE settlement, so two concurrent payment nonces cannot
    // double-buy the same (call, subscriber) and charge twice.
    //
    // A settled payment is NEVER relabeled a plain failure: a grant that can't
    // be broadcast or confirmed becomes grant_failed_refund_due, so a refund
    // stays owed. Pairs with grantDecryptAccess on the contract.
    db.transaction(() => {
      db.exec(MIGRATION_059_ENTITLEMENTS);
      set.run("schema_version", "59");
    })();
    v = 59;
  }

  if (v < 60) {
    // Agent-auth hardening, four independent pieces on one version:
    //
    //   1. agent_runtime_key_nonces — consumed (runtime_key_id, nonce) pairs
    //      for proof-of-possession replay prevention. No FK: keys are
    //      soft-revoked, so the cascade could never fire and would only tax
    //      every authenticated request. Pruned lazily on verify.
    //   2. request_fingerprint + auth_proof on both gateway attempt tables.
    //      The fingerprint is compared on every client_order_id duplicate
    //      exit, so an idempotent 200 can never be returned for DIFFERENT
    //      content. auth_proof records how the reserving request actually
    //      authenticated.
    //   3. accounts.agent_credentials_disabled_at — the account kill switch.
    //      A bulk revoke alone is not durable, because API-key mint is
    //      Privy-gated only.
    //   4. agent_security_events rebuild for the two kill-switch kinds. It
    //      mirrors AgentSecurityEventKindSchema in schema.ts; both surfaces
    //      move together, by design.
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
      set.run("schema_version", "60");
    })();
    v = 60;
  }

  if (v < 61) {
    // Retire the native-price registry surface. Murmur is a pure referee over
    // external venues: it never authors a market and never resolves an
    // outcome, so the self-resolving machinery is gone from the runtime.
    //
    // Data-only. Markets native by ANY of their four markers (market_kind,
    // scoring_kind, adapter_id, market_family) flip to status='retired', the
    // terminal status both acceptsSubmissions() and resolverShouldTick()
    // refuse. The predicate is deliberately wider than the live data so a
    // hand-seeded row cannot survive as a live market.
    //
    // Price-feed oracles retire too, but NOT the synthetic
    // 'polymarket-gamma-oracle' row: markets.primary_oracle_id is NOT NULL
    // with an FK into oracles, and every Polymarket upsert writes it.
    //
    // No rebuild and no deletes here. t0_anchors, the assets rows, and
    // t1_resolutions' price-anchor columns are legacy persisted evidence and
    // must stay readable.
    db.transaction(() => {
      db.exec(MIGRATION_061_RETIRE_NATIVE_PRICE_REGISTRY);
      set.run("schema_version", "61");
    })();
    v = 61;
  }

  if (v < 62) {
    // Delete what 061 retired. Guarded, never blind: a native market row goes
    // only when no submission references it, so a deployment that did take
    // native calls keeps its history and simply leaves those rows retired.
    // Oracle and asset rows go only once no market points at them.
    //
    // Preserved: the synthetic polymarket oracle/asset rows (NOT NULL FKs
    // rewritten on every upsert), t0_anchors, and t1_resolutions' price-anchor
    // columns.
    db.transaction(() => {
      db.exec(MIGRATION_062_DROP_UNREFERENCED_NATIVE_ROWS);
      set.run("schema_version", "62");
    })();
    v = 62;
  }

  if (v < 63) {
    // Feed-packet reveal lifecycle. The contract always had the reveal calls
    // and events, but the daemon had no columns, jobs table or watcher for
    // them — so a producer could take payment for a feed and never disclose a
    // packet, the same withholding hole the call path already closed.
    //
    // agent_wallet_address is captured at SUBMISSION time, so attribution
    // survives a controller-wallet rotation.
    //
    // Reveal jobs get their own table rather than a discriminator on
    // fhenix_reveal_jobs, whose primary key is a real FK to
    // fhenix_sealed_calls; sharing would mean a polymorphic key and a rebuild
    // of a populated table. One worker drives both.
    //
    // No time-based 'missed' status: a sealed packet has no on-chain reveal
    // expiry. Liveness gaps surface as operator alerts.
    db.transaction(() => {
      applyAlterTableAddColumn(db, "feed_packets", "reveal_status", MIGRATION_063_FEED_REVEAL_COLUMNS);
      db.exec(MIGRATION_063_FEED_REVEAL_JOBS);
      set.run("schema_version", "63");
    })();
    v = 63;
  }

  if (v < 64) {
    // market_series + market_clocks. A market used to be only an instance, so
    // nothing could own what a recurring series owns: the schedule constants
    // every instance derives from, and the identity prepaid credits scope to.
    // At 288 instances a day, credits keyed to an instance strand on rollover.
    //
    // The series constants are NOT nullable and NOT per-instance — an instance
    // wanting a different schedule is a different series.
    //
    // market_clocks is the per-instance snapshot, written once at registration
    // and immutable after. Gamma can shift `endDate` under us; re-deriving on
    // read would silently retime a market consumers already armed against.
    // Drift is detected against the snapshot and the market is delisted rather
    // than rebound — a schedule someone paid against must never move.
    //
    // resolution_at_ms is separate from public_reveal_at_ms on purpose: the
    // venue determines the outcome, murmur unseals later. One column would
    // assert the market resolves at murmur's reveal deadline.
    db.transaction(() => {
      db.exec(MIGRATION_064_MARKET_SERIES);
      // submission_class travels with the submit event, alongside the
      // reveal_open_at this row already decodes from it. NULL on rows written
      // before this migration, and 0 (None) when the log has not been decoded.
      applyAlterTableAddColumn(
        db,
        "fhenix_gateway_tx_attempts",
        "submission_class",
        "ALTER TABLE fhenix_gateway_tx_attempts ADD COLUMN submission_class INTEGER;",
      );
      set.run("schema_version", "64");
    })();
    v = 64;
  }

  if (v < 65) {
    // submission_class on the canonical accepted-call record. Its own version,
    // not a widened 064: a DB already at 64 would skip the widened block
    // forever. Shipped migrations are immutable.
    //
    // 064's gateway row is an audit trail; reputation reads THIS row, and
    // direct/operator intake never creates a gateway attempt at all. NULL means
    // unknown — never treat it as EarlyAccess.
    db.transaction(() => {
      applyAlterTableAddColumn(
        db,
        "fhenix_sealed_calls",
        "submission_class",
        "ALTER TABLE fhenix_sealed_calls ADD COLUMN submission_class INTEGER;",
      );
      set.run("schema_version", "65");
    })();
    v = 65;
  }

  if (v < 66) {
    // Stuck-registration age was measured off `updated_at`, which every
    // recorded error rewrites — a row stuck for hours kept reporting seconds
    // and never crossed a threshold. This watermark is not touched by error
    // recording, so the age is real cumulative stuck time.
    db.transaction(() => {
      applyAlterTableAddColumn(
        db,
        "polymarket_discovery_state",
        "broadcast_started_at",
        "ALTER TABLE polymarket_discovery_state ADD COLUMN broadcast_started_at TEXT;",
      );
      // Backfill rows already mid-broadcast, or they keep NULL and the alert
      // falls back to the same rewritten `updated_at`.
      db.prepare(
        `UPDATE polymarket_discovery_state
            SET broadcast_started_at = updated_at
          WHERE status = 'broadcasting' AND broadcast_started_at IS NULL`,
      ).run();
      set.run("schema_version", "66");
    })();
    v = 66;
  }

  if (v < 67) {
    // An admin freeze could be silently undone: discovery holds a broadcast
    // across an await and relists on receipt, and its recovery path promotes a
    // frozen mid-registration market on purpose — so it could not tell its own
    // repair freeze from an operator's halt.
    //
    // The marker lives on `markets`, not on the discovery ledger: a market can
    // be halted before discovery ever sees it, and an UPDATE against a missing
    // ledger row would silently mark nothing.
    db.transaction(() => {
      applyAlterTableAddColumn(
        db,
        "markets",
        "operator_halted_at",
        "ALTER TABLE markets ADD COLUMN operator_halted_at TEXT;",
      );
      // Mark EVERY frozen/retired market, mid-registration ones included.
      // Pre-upgrade data cannot tell an operator halt from discovery's own
      // repair freeze, and of the two errors, relisting a market an operator
      // genuinely pulled is the worse one: the other costs a single explicit
      // re-registration. Only markets frozen by discovery AFTER this upgrade
      // are distinguishable, and they never get the marker.
      db.prepare(
        `UPDATE markets
            SET operator_halted_at = created_at
          WHERE status IN ('frozen','retired') AND operator_halted_at IS NULL`,
      ).run();
      set.run("schema_version", "67");
    })();
    v = 67;
  }

  if (v < 68) {
    // Bind a settled payment to the resource it bought. The reservation alone
    // is not the guard people assumed: it is unique per (call, subscriber), so
    // the SAME signed payment header replayed against a DIFFERENT call at the
    // same price passed every local check, leaving only the facilitator's nonce
    // handling in the way. A payload hash now belongs to exactly one resource
    // fingerprint, and a mismatch is refused before settlement.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entitlement_payment_bindings (
          payload_hash      TEXT PRIMARY KEY,
          resource_fingerprint TEXT NOT NULL,
          requirements_hash TEXT NOT NULL,
          created_at        TEXT NOT NULL
        );
      `);
      set.run("schema_version", "68");
    })();
    v = 68;
  }

  if (v < 69) {
    // Per-provider commercial terms. Price and cohort size were global env
    // values, which made murmur the one setting the terms of somebody else's
    // product.
    //
    // agent_provider_terms is what the owner has SET — mutable, repriceable.
    // fhenix_sealed_calls.provider_* is what a call was SOLD under, snapshotted
    // at acceptance and never updated; otherwise a reprice would retroactively
    // change terms subscribers already bought into.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_provider_terms (
          agent_id              TEXT PRIMARY KEY REFERENCES agents(agent_id),
          -- Access price in the settlement asset's atomic units. Positive.
          price_atoms           TEXT NOT NULL CHECK (
                                  price_atoms GLOB '[0-9]*' AND CAST(price_atoms AS INTEGER) > 0
                                ),
          currency              TEXT NOT NULL,
          -- Identifies the commercial terms a subscriber agreed to. Bump it
          -- when the price changes so receipts stay attributable.
          pricing_version       TEXT NOT NULL,
          -- Owner's chosen ceiling, or NULL for "as many as murmur can serve".
          -- Deliberately nullable: the owner sets a BUSINESS limit, and murmur
          -- separately clamps to what it can actually deliver in the window.
          max_subscribers_per_call INTEGER CHECK (
                                  max_subscribers_per_call IS NULL
                                  OR max_subscribers_per_call > 0
                                ),
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL
        );
      `);
      for (const [col, ddl] of [
        ["provider_price_atoms", "ALTER TABLE fhenix_sealed_calls ADD COLUMN provider_price_atoms TEXT;"],
        ["provider_currency", "ALTER TABLE fhenix_sealed_calls ADD COLUMN provider_currency TEXT;"],
        ["provider_pricing_version", "ALTER TABLE fhenix_sealed_calls ADD COLUMN provider_pricing_version TEXT;"],
        ["provider_max_subscribers", "ALTER TABLE fhenix_sealed_calls ADD COLUMN provider_max_subscribers INTEGER;"],
      ] as const) {
        applyAlterTableAddColumn(db, "fhenix_sealed_calls", col, ddl);
      }
      // Left NULL on existing rows on purpose. A call sealed before this
      // migration was sold under the deployment-wide terms, and the access
      // path falls back to those for exactly such rows — backfilling today's
      // env values would assert terms those calls were never offered under.
      set.run("schema_version", "69");
    })();
    v = 69;
  }

  if (v < 70) {
    // Tell "sealed before providers could price" apart from "not selling".
    // 069 left provider_* NULL for both, and the access path reads NULL as
    // legacy — so clearing terms silently kept selling at the OPERATOR's price.
    // Existing rows default to 0 and keep the fallback; everything accepted
    // from now on writes 1, so a NULL price beside it means not for sale.
    db.transaction(() => {
      applyAlterTableAddColumn(
        db,
        "fhenix_sealed_calls",
        "provider_terms_snapshotted",
        "ALTER TABLE fhenix_sealed_calls ADD COLUMN provider_terms_snapshotted INTEGER NOT NULL DEFAULT 0;",
      );
      // LITERAL "70", never String(LATEST_DB_MIGRATION_VERSION). This block
      // used to stamp the constant back when it was last; once 071 landed, a
      // crash between the two would stamp a DB 71 with none of 071's columns
      // and skip it forever. Every intermediate step writes its own number.
      set.run("schema_version", "70");
    })();
    v = 70;
  }

  if (v < 71) {
    // The provider revenue split becomes a ledger. Circle still pays one
    // recipient; what changes is that murmur writes down whose money it is.
    //
    // provider_fee_bps is the fee as of the SEAL, frozen beside the price so an
    // operator cannot re-cut a call already on offer. fee_bps_at_sale is the
    // fee as of the SALE, stamped at reservation, so a fee change mid-purchase
    // does not alter that purchase. provider_earnings is one row per paid,
    // granted entitlement — append-only financial history, never deleted, no
    // cascade from any parent.
    //
    // Accrual only: there is no payout worker yet, which is why the read
    // surface says "lifetime_accrued", not "owed".
    db.transaction(() => {
      applyAlterTableAddColumn(
        db,
        "fhenix_sealed_calls",
        "provider_fee_bps",
        `ALTER TABLE fhenix_sealed_calls ADD COLUMN provider_fee_bps INTEGER
           CHECK (provider_fee_bps IS NULL OR (provider_fee_bps BETWEEN 0 AND 10000));`,
      );
      applyAlterTableAddColumn(
        db,
        "entitlements",
        "fee_bps_at_sale",
        `ALTER TABLE entitlements ADD COLUMN fee_bps_at_sale INTEGER
           CHECK (fee_bps_at_sale IS NULL OR (fee_bps_at_sale BETWEEN 0 AND 10000));`,
      );
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_earnings (
          -- The entitlement IS the identity. One paid, granted entitlement
          -- accrues exactly once; no surrogate key, so a double-fire cannot
          -- produce a second row for the same sale.
          entitlement_id    INTEGER PRIMARY KEY REFERENCES entitlements(id),
          -- NOT NULL on purpose. An earnings row nobody can be paid for is
          -- worse than no row: it looks settled in every total while naming no
          -- recipient. Unresolvable attribution is logged and left for the
          -- audit sweep instead, so it stays visible.
          producer_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
          chain_id          INTEGER NOT NULL,
          contract_address  TEXT NOT NULL,
          onchain_call_id   TEXT NOT NULL,
          -- Atomic units as TEXT: these exceed the safe integer range in
          -- low-decimal assets, and every total is summed in BigInt in JS.
          -- Never SUM()/CAST() these in SQLite — that silently goes through a
          -- 64-bit float.
          gross_atoms       TEXT NOT NULL CHECK (gross_atoms GLOB '[0-9]*'),
          fee_bps           INTEGER NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
          fee_atoms         TEXT NOT NULL CHECK (fee_atoms GLOB '[0-9]*'),
          net_atoms         TEXT NOT NULL CHECK (net_atoms GLOB '[0-9]*'),
          currency          TEXT NOT NULL,
          -- 'sale_snapshot'  the split this sale actually froze
          -- 'legacy_fallback' a row predating 071 accrued at the CURRENT fee,
          --                   because no sale-time split was ever recorded
          accrual_source    TEXT NOT NULL CHECK (
                              accrual_source IN ('sale_snapshot','legacy_fallback')
                            ),
          accrued_at        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_provider_earnings_owner
          ON provider_earnings(producer_agent_id, accrued_at);
        CREATE INDEX IF NOT EXISTS idx_provider_earnings_call
          ON provider_earnings(chain_id, contract_address, onchain_call_id);
      `);
      // LITERAL "71" — see the note in 070.
      set.run("schema_version", "71");
    })();
    v = 71;
  }

  if (v < 72) {
    // Make the archive keyset page a plain index seek. The archive filters on
    // status and orders by (end_date_epoch_s DESC, condition_id DESC); the
    // existing index covers the timestamp alone, so SQLite re-sorted for the
    // tie-break and re-checked status per row. This composite covers all three.
    //
    // DESC is written in on purpose: SQLite walks an ASC index backwards only
    // when the whole ORDER BY reverses uniformly, and stating it keeps the plan
    // stable if a later query adds a mixed-direction column.
    //
    // Index-only, no data change: safe to re-run, nothing to backfill, and a
    // database that stops mid-migration simply retries the CREATE INDEX.
    db.transaction(() => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_polymarket_archive_page
          ON polymarket_discovery_state(status, end_date_epoch_s DESC, condition_id DESC);
      `);
      // LITERAL "72" — see the note in 070.
      set.run("schema_version", "72");
    })();
    v = 72;
  }

  if (v < 73) {
    // The payout journal 071 said it was not. With it, a balance is computable:
    // accrued minus paid.
    //
    // provider_payouts is append-only in SQL, not by convention — the triggers
    // RAISE on UPDATE and DELETE, same as market_config_history. Correcting a
    // payout means writing a 'reversal' row; a journal you can edit is a
    // journal nobody can audit.
    //
    // amount_atoms is always positive and the sign lives in entry_type,
    // otherwise "payout of -5" and "reversal of 5" both exist and sum
    // differently depending on the query. Its GLOB pair is stricter than 071's
    // because GLOB anchors only at the start, so '1abc' passes and BigInt()
    // throws at read time, long after the bad row landed. 071 stays as it
    // shipped — an applied migration is immutable.
    //
    // destination_ref snapshots where the money went; the agent's destination
    // address is mutable, so resolving it live would rewrite history on the
    // next repoint. earnings_cutoff_at is audit context only — balances come
    // from the full accrual and payout sets, since a cutoff-scoped balance
    // would drop a sale that accrued late into an earlier period.
    //
    // UNIQUE(producer_agent_id, currency, tx_ref) makes the writer retry-safe:
    // a re-POSTed transfer replays the existing row instead of paying twice.
    // ON DELETE RESTRICT, not CASCADE — deleting an agent must fail while it
    // has payout history.
    //
    // accounts.deactivated_at is terminal and independent of
    // agent_credentials_disabled_at: the kill switch has a release route, and
    // releasing it must never reopen a closed account.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_payouts (
          id                INTEGER PRIMARY KEY,
          producer_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
          -- 'payout'   money moved to the provider
          -- 'reversal' a previous payout came back (clawback, failed transfer)
          entry_type        TEXT NOT NULL CHECK (entry_type IN ('payout','reversal')),
          currency          TEXT NOT NULL,
          -- Positive atomic units as TEXT, summed in BigInt in JS. Never
          -- SUM()/CAST() this in SQLite — it goes through a 64-bit float.
          amount_atoms      TEXT NOT NULL CHECK (
                              amount_atoms GLOB '[1-9]*'
                              AND amount_atoms NOT GLOB '*[^0-9]*'
                            ),
          -- The operator's handle on the movement: a transfer hash, a bank
          -- reference, an internal batch id. Also the idempotency key.
          tx_ref            TEXT NOT NULL,
          payout_method     TEXT NOT NULL,
          -- Snapshot of WHERE it went, taken at the time it went there.
          destination_ref   TEXT NOT NULL,
          note              TEXT,
          -- Audit context: what period this settled. Never arithmetic.
          earnings_cutoff_at TEXT NOT NULL CHECK (earnings_cutoff_at <= created_at),
          created_at        TEXT NOT NULL,
          UNIQUE (producer_agent_id, currency, tx_ref)
        );
        CREATE INDEX IF NOT EXISTS idx_provider_payouts_owner
          ON provider_payouts(producer_agent_id, created_at);

        -- Append-only in SQL. Same precedent as market_config_history (012).
        CREATE TRIGGER IF NOT EXISTS provider_payouts_no_update
          BEFORE UPDATE ON provider_payouts
          BEGIN
            SELECT RAISE(FAIL, 'provider_payouts is append-only: write a reversal row');
          END;
        CREATE TRIGGER IF NOT EXISTS provider_payouts_no_delete
          BEFORE DELETE ON provider_payouts
          BEGIN
            SELECT RAISE(FAIL, 'provider_payouts is append-only: write a reversal row');
          END;
      `);
      applyAlterTableAddColumn(
        db,
        "agents",
        "retired_at",
        "ALTER TABLE agents ADD COLUMN retired_at TEXT;",
      );
      applyAlterTableAddColumn(
        db,
        "accounts",
        "deactivated_at",
        "ALTER TABLE accounts ADD COLUMN deactivated_at TEXT;",
      );
      // EVERY migration stamps its own literal version. LATEST is the loop
      // bound, never a stamp — bumping it for N+1 makes a crash between N and
      // N+1 record N+1 as applied.
      set.run("schema_version", "73");
    })();
    v = 73;
  }

  if (v < 74) {
    // Scrub ambiguous pre-HMAC rows; feed attempts are provably client-sealed.
    db.transaction(() => {
      db.exec(`
        UPDATE fhenix_gateway_tx_attempts
           SET request_fingerprint = NULL
         WHERE request_fingerprint IS NOT NULL
           AND request_fingerprint NOT LIKE 'v1:%';
      `);
      set.run("schema_version", "74");
    })();
    v = 74;
  }

  if (v < 75) {
    // Promote the venue's DURABLE identity to first-class tables. A market
    // instance is ephemeral — a new one every 5 minutes, ~14k rows, ~20 live at
    // once — so nothing durable (a registration, a price) can key to market_id.
    // What persists is the recurring SERIES, carried until now only inside
    // markets.config_json as series_slug / series_title / venue_category. This
    // migration lifts it out of the JSON into tables later rows can FK.
    //
    // NOT the market_series table (064): that is the unrelated CLOCK series —
    // schedule constants for the 300s binary clock. Same word, different
    // concept. These are venue_market_series.
    //
    // SAFETY: agent_provider_terms is rekeyed from (agent_id) to
    // (agent_id, venue_series_id). A per-agent price cannot be mapped onto one
    // of the venue series it must now belong to without guessing, so the
    // rebuild is only sound on an empty table. It is empty in every known
    // deployment; the guard below refuses to proceed — and stamps NOTHING, so
    // the DB stays honestly at 74 — if that ever stops being true.
    //
    // The emptiness check runs INSIDE the BEGIN IMMEDIATE below, not before it.
    // Outside the transaction it was a TOCTOU: an insert landing between the
    // count and the rekey's DROP would be silently discarded by the rebuild.
    // The immediate write lock is held from the count through the drop, so no
    // such insert can interleave; a throw rolls the whole thing back.
    const nowIso = new Date().toISOString();

    const migrate075 = db.transaction(() => {
      const legacyTerms = db
        .prepare("SELECT count(*) AS c FROM agent_provider_terms")
        .get() as { c: number };
      if (legacyTerms.c > 0) {
        throw new Error(
          `migration 075: agent_provider_terms holds ${legacyTerms.c} legacy ` +
            `row(s), keyed by agent alone. There is no non-guessing way to map a ` +
            `deployment-wide price onto one of the venue series it must now belong ` +
            `to. Migrate or clear these rows by hand, then re-run.`,
        );
      }

      db.exec(MIGRATION_075_VENUE_MARKET_SERIES);

      // Nullable on purpose, and idempotent: a DB that already carries the
      // column (e.g. replayed from an earlier stamp) skips the ALTER rather than
      // failing on a duplicate. The REFERENCES needs venue_market_series to
      // exist first — it does, from the exec above.
      applyAlterTableAddColumn(
        db,
        "markets",
        "venue_series_id",
        "ALTER TABLE markets ADD COLUMN venue_series_id TEXT " +
          "REFERENCES venue_market_series(venue_series_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_markets_venue_series " +
          "ON markets(venue_series_id);",
      );

      // (a) One venue_market_series row per distinct valid series in the
      //     markets.config_json history. "Valid" = a non-empty series_slug AND
      //     a non-empty series_title (series_title is NOT NULL). venue_category
      //     is genuinely absent for the 5m crypto series, so it stays NULL.
      db.prepare(
        `INSERT OR IGNORE INTO venue_market_series
           (venue_series_id, venue, series_slug, series_title,
            venue_category, source_adapter_id, created_at, updated_at)
         SELECT
           'polymarket:' || slug, 'polymarket', slug, title, cat,
           'polymarket-gamma', @now, @now
         FROM (
           SELECT
             json_extract(config_json, '$.series_slug')          AS slug,
             MIN(json_extract(config_json, '$.series_title'))     AS title,
             MIN(json_extract(config_json, '$.venue_category'))   AS cat
           FROM markets
           WHERE json_valid(config_json)
             AND json_extract(config_json, '$.series_slug') IS NOT NULL
             AND length(json_extract(config_json, '$.series_slug')) > 0
             AND json_extract(config_json, '$.series_title') IS NOT NULL
             AND length(json_extract(config_json, '$.series_title')) > 0
           GROUP BY json_extract(config_json, '$.series_slug')
         )`,
      ).run({ now: nowIso });

      // (b) Link each market whose config names a series that actually became a
      //     row. Markets with no valid slug — or a slug that never yielded a
      //     series — stay NULL, never fabricated. The EXISTS keeps the FK sound;
      //     the assertion just below proves no link was invented.
      db.prepare(
        `UPDATE markets
            SET venue_series_id =
                  'polymarket:' || json_extract(config_json, '$.series_slug')
          WHERE json_valid(config_json)
            AND json_extract(config_json, '$.series_slug') IS NOT NULL
            AND length(json_extract(config_json, '$.series_slug')) > 0
            AND EXISTS (
              SELECT 1 FROM venue_market_series vms
               WHERE vms.venue_series_id =
                     'polymarket:' || json_extract(markets.config_json, '$.series_slug')
            )`,
      ).run();

      const fabricated = db
        .prepare(
          `SELECT count(*) AS c FROM markets
            WHERE venue_series_id IS NOT NULL
              AND (NOT json_valid(config_json)
                   OR json_extract(config_json, '$.series_slug') IS NULL
                   OR length(json_extract(config_json, '$.series_slug')) = 0)`,
        )
        .get() as { c: number };
      if (fabricated.c > 0) {
        throw new Error(
          `migration 075: ${fabricated.c} market(s) were linked to a series ` +
            `with no valid config_json series_slug — refusing to fabricate ` +
            `durable identity.`,
        );
      }

      // (c) An agent that has EVER submitted into a market of a series is
      //     historically registered for that series. Row presence == registered.
      //     Reachable only via submissions.market_id → markets.venue_series_id,
      //     now populated by step (b).
      db.prepare(
        `INSERT OR IGNORE INTO agent_market_registrations
           (agent_id, venue_series_id, created_at)
         SELECT DISTINCT s.agent_id, m.venue_series_id, @now
           FROM submissions s
           JOIN markets m ON m.market_id = s.market_id
          WHERE m.venue_series_id IS NOT NULL`,
      ).run({ now: nowIso });

      // (d) Rekey agent_provider_terms to (agent_id, venue_series_id). Asserted
      //     empty above, so this is a drop + create, not a row-preserving
      //     rebuild — nothing to copy, and nothing FKs into this table.
      db.exec(MIGRATION_075_AGENT_PROVIDER_TERMS_REKEY);

      set.run("schema_version", "75");
    });
    migrate075.immediate();
    v = 75;
  }

  if (v < 76) {
    // Indexes only. The consumer surfaces landing on top of 075 read the
    // catalog two ways neither existing index serves:
    //
    //   · the marketplace catalog scans agent_provider_terms filtered by
    //     venue_series_id — the PK is (agent_id, venue_series_id), whose
    //     leading column is the wrong one for "who sells this series".
    //   · the per-call storefront keysets on market_clocks
    //     (submission_close_at_ms, market_id), which had no index at all: the
    //     open-window predicate plus the ORDER BY was a scan + sort per page.
    //
    // No table is rewritten and no row is touched, so replay is a no-op.
    db.transaction(() => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_provider_terms_venue_series
          ON agent_provider_terms(venue_series_id, agent_id);
        CREATE INDEX IF NOT EXISTS idx_market_clocks_submission_close
          ON market_clocks(submission_close_at_ms, market_id);
      `);
      // LITERAL "76" — see the note in 070.
      set.run("schema_version", "76");
    }).immediate();
    v = 76;
  }

  if (v < 77) {
    // Presence is deliberately one nullable timestamp per Runtime Key. It is
    // operational state, not a submission or a chain record.
    db.transaction(() => {
      applyAlterTableAddColumn(
        db,
        "agent_runtime_keys",
        "last_heartbeat_at",
        "ALTER TABLE agent_runtime_keys ADD COLUMN last_heartbeat_at TEXT;",
      );
      set.run("schema_version", "77");
    }).immediate();
    v = 77;
  }

  if (v < 78) {
    db.transaction(() => {
      applyAlterTableAddColumn(db, "agents", "deleted_at",
        "ALTER TABLE agents ADD COLUMN deleted_at TEXT;");
      set.run("schema_version", "78");
    }).immediate();
    v = 78;
  }
  if (v < 79) {
    db.transaction(() => {
      applyAlterTableAddColumn(db, "agent_runtime_keys", "last_contact_at",
        "ALTER TABLE agent_runtime_keys ADD COLUMN last_contact_at TEXT;");
      applyAlterTableAddColumn(db, "agent_runtime_keys", "runtime_mode",
        "ALTER TABLE agent_runtime_keys ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'interactive' CHECK (runtime_mode IN ('interactive', 'continuous'));");
      db.exec("UPDATE agent_runtime_keys SET last_contact_at = last_heartbeat_at WHERE last_contact_at IS NULL;");
      set.run("schema_version", "79");
    }).immediate();
    v = 79;
  }

  if (v < 80) {
    db.transaction(() => {
      db.exec(MIGRATION_080_DELIVERY_AND_WITHDRAWALS);
      set.run("schema_version", "80");
    }).immediate();
    v = 80;
  }

  if (v < 81) {
    // The referral feature is retired: ref_clicks goes, and the security-event
    // CHECK closes over the surviving kinds. A rebuild, because SQLite CHECKs
    // cannot be altered; rows of the retired kind go with it. Mirrors
    // AgentSecurityEventKindSchema in schema.ts; both move together.
    //
    // A database that never had agent_security_events (a partial fixture, or an
    // install stamped forward) has nothing to rebuild, so it only drops the
    // table. The temp name counts as present: a crashed rebuild is recoverable
    // and must still go through the helper.
    const securityEventsPresent = !!db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
           AND name IN ('agent_security_events','agent_security_events_v081')`,
      )
      .get();
    if (securityEventsPresent) {
      applyTableRebuildMigration(
        db,
        MIGRATION_081_RETIRE_REFERRALS,
        () => {
          set.run("schema_version", "81");
        },
        ["agent_security_events", "agent_security_events_v081"],
      );
    } else {
      db.transaction(() => {
        db.exec("DROP TABLE IF EXISTS ref_clicks;");
        set.run("schema_version", "81");
      }).immediate();
    }
    v = 81;
  }
}

/**
 * Atomic table-rebuild helper.
 *
 * `.exec()` runs each semicolon-delimited statement independently, with no
 * implicit transaction, so a raw rebuild string can crash with the original
 * dropped and the rename never done — permanent data loss. Here the rebuild
 * and the version bump share one BEGIN/COMMIT, the FK pragma is toggled
 * outside it (SQLite no-ops the pragma inside a transaction) and restored in
 * `finally`, and every migration body starts with `DROP TABLE IF EXISTS
 * <temp>` so a retry does not trip on an orphan.
 *
 * Before the transaction, the four (original, temp) states a crash can leave:
 *
 *   1. original, no temp — clean. Run.
 *   2. both — interrupted before the temp was renamed or dropped. The body's
 *      leading DROP handles it. Run.
 *   3. temp only — RECOVERABLE: the crash landed between DROP original and
 *      RENAME temp, so the temp holds the only copy. Rename it back first.
 *   4. neither — CATASTROPHIC. Refuse, rather than silently rebuilding an
 *      empty table; restore from backup.
 *
 * State 3's rename stays outside the pragma block and the transaction: ALTER
 * TABLE … RENAME is atomic on its own, and recovery should be observable in
 * the sqlite_master state re-checked afterwards.
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
    // Interpolation is safe: the names are compile-time literals at the call
    // sites, never user input.
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
// Every share-page click carrying ?ref=<sender>, counted per (ref, slug)
// bucket. No IP, no fingerprint — the bucket counter is the whole record.

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
// call.accepted / call.resolved subscriptions, per agent or across all.
// Each delivery is signed HMAC-SHA256(secret, body); failure count and
// last-delivery stamps are surfaced so subscribers can self-debug.

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
// The commit/envelope shape, added ALONGSIDE the existing plaintext columns
// so the daemon keeps working while query sites move over.
//
// No CHECK constraints on privacy_mode / commit_scheme / encrypted_body_alg /
// commit_preimage_schema / revealed_via, on purpose: the fhEVM port
// introduces new values for all of them without needing a migration.
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
// A second envelope per committed submission: a drand/tlock ciphertext bound
// to a future round. Once that round passes anyone can decrypt it from the
// released beacon, which removes the operator from the trusted set and closes
// the selective-reveal hole.
//
// Every column is nullable — the integration is opt-in, older envelopes have
// no drand binding, and a later scheme may bind to FHE state instead.
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
// Turns a single hard-coded market into a registry: assets × oracles ×
// markets, so adding one is data rather than code. market_kind and the
// nullable prediction_* columns are reserved from the start so proximity
// markets never need a rebuild.
//
// submissions.market_id is nullable: NULL means a legacy direction call keyed
// on (asset_id, horizon_hours), and read-time helpers synthesize an id for it
// so old receipts never have to be rewritten.
//
// Status enum: draft (registered, submissions blocked) | listed | frozen
// (resumable; pending calls still resolve) | retired (terminal).
//
// void_band is per-row so operators can retune without a migration.
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
  -- Only ETH at 1h/4h/24h/7d starts 'listed'; everything else waits in
  -- 'draft'. Sub-hour horizons are Pyth-only — the Chainlink Base heartbeat
  -- is too coarse — as is BNB at every horizon.

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
// Backfills the unambiguous (base:ETH:USD, horizon_hours) → market_id
// mappings so read paths join directly instead of calling legacyIdFor().
//
// market_config_version is stamped from the market row as it stands when this
// runs, on purpose: scoring honors the per-submission stamp, so a later config
// bump cannot retroactively rescore legacy calls.
//
// Receipts and envelopes are untouched — their hashes still cover the
// (asset_id, horizon_hours) tuple in the subject.
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
// Drops the CHECK pinning horizon_hours to {1,4,24,168} — sub-hour markets
// need 0 — and adds horizon_seconds as the canonical value. horizon_hours
// survives only because v1 receipt subjects embed it; prefer horizon_seconds,
// which has no precision loss below an hour.
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
// Sub-hour markets are Pyth-only, so a per-call policy row may legitimately
// have no fallback. Relaxes the NOT NULL that migration 001 put on
// fallback_feed and fallback_max_staleness_sec; existing rows copy through
// unchanged.
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
// bumpConfig overwrites the live markets row, and the per-call policy
// snapshot only holds the fields it picked — so nothing could answer "what did
// market X look like at config_version=3?". One row per (market_id, version),
// append-only, enforced by triggers.
//
// Seeded from current markets, so every existing version already has an entry.
// bumpConfig appends the new version inside the markets UPDATE transaction.
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
// Admits 'casual' and 'attested' into the agents.kind CHECK. A rebuild —
// SQLite cannot ALTER a CHECK in place.
//
// The inbound FKs need no fixing: SQLite resolves FK targets by table NAME at
// validation time, so renaming agents_v3 → agents repoints them automatically.
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
// A payout-routing target the operator declares but never signs with.
//
// The 24h cooldown lives in JS, not SQL, so it can grow extra conditions
// without another migration; destination_address_updated_at is the state it
// reads. The address format is likewise unconstrained here — getAddress()
// normalizes at the API edge, same as wallet_address.
const MIGRATION_014 = `
  ALTER TABLE agents ADD COLUMN destination_address TEXT;
  ALTER TABLE agents ADD COLUMN destination_address_updated_at TEXT;
  CREATE INDEX idx_agents_destination ON agents(destination_address) WHERE destination_address IS NOT NULL;
`;

// ─── Migration 015 — Phase E cleanup (env-gated, V2 §7.5) ──────────────────
//
// A committed-mode submission keeps its plaintext only in call_reveals after
// the reveal, so the raw submissions row should not retain it past the
// acceptance window. This rebuild relaxes what the scrub needs: side,
// asset_id, horizon_hours and confidence become nullable and lose their
// CHECKs. horizon_seconds stays NOT NULL — the resolver computes T1 from it.
//
// Rows still in 'accepted' or 'pending_t0' are deliberately left alone: T0
// anchor recovery may still need those fields.
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

  -- Structural rebuild only. The destructive plaintext scrub lives in
  -- phase-e-cleanup.ts, behind MURMUR_PHASE_E_CLEANUP.
`;

// ─── Migration 016 — v2 commitment + outcome storage columns ────────────────
//
// The universal Commitment / Outcome shape, added on top of the v1 columns.
// Legacy v1 calls keep their old surface and leave every new column NULL.
//
// markets.adapter_id is the source of truth; submissions.adapter_id and
// market_family denormalize from it so leaderboard family filters and resolver
// dispatch are index seeks rather than table scans.
//
// outcome_labels_json is RENDER-ONLY and never load-bearing for scoring.
// payout_vector_json duplicates the numerators so the leaderboard can skip a
// JSON parse on the hot path.
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

// ─── Migration 017 — casual-tier auth scaffold ──────────────────────────────
//
// See the v<17 block in applyMigrations for the shape and the reasoning.
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

// ─── Migration 018 — receipts.kind allows 'resolution_v2' ───────────────────
//
// Nothing FKs into receipts, so the rebuild copies every row through and
// recreates the one index. Both receipt kinds are kept so the legacy verify
// path stays untouched.
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

// ─── Migration 019 — UNIQUE(agent_id) on account_agents ─────────────────────
//
// The pair PRIMARY KEY is kept alongside the new UNIQUE(agent_id) so the
// dispatcher's pair-lookup keeps working unchanged. See the v<19 block for
// why the copy takes MIN(created_at).
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

// ─── Migration 020 — drop receipts + rekey disputes on call_id ──────────────
//
// Drops receipts and rekeys disputes onto target_call_id; the resolve path
// now updates t1_resolutions in place instead of chaining a second receipt.
//
// ORDER MATTERS: the disputes copy joins receipts to resolve
// receipt_hash → call_id, so it must run before the DROP. Dispute rows whose
// hash no longer resolves are dropped.
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

// ─── Migration 028 — Polymarket sync state ──────────────────────────────────
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
// See the v<29 block in applyMigrations for the reasoning.
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

// Concatenated into the rebuild above so both share one BEGIN..COMMIT with
// the version bump. Changing these synthetic rows later needs an explicit
// UPDATE migration — INSERT OR IGNORE silently skips rows that already exist.
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

// ─── Migration 031 — operator-blind reshape ─────────────────────────────────
//
// See the v<31 block in applyMigrations. idx_submissions_asset_horizon is
// deliberately not recreated — the columns it covered are gone, and the
// resolver pages on horizon_seconds + market_id now.
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
// See the v<32 block for why there is no FK to agents. The CHECK on `kind`
// keeps the taxonomy closed at the SQL layer, so a new event class has to be
// added here AND to AgentSecurityEventKindSchema in schema.ts.
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
  -- Partial expression index for "who upserted conditionId X?", which was a
  -- full scan with payload_json LIKE. Only matching rows are indexed.
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
// Adds admin_fhenix_gateway_retry and admin_fhenix_feed_packet_backfill.
// The append-only triggers are dropped and recreated around the rebuild so the
// invariant survives the rename.
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
// See the v<54 block in applyMigrations for the reasoning.
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
    -- The producing agent (fhenix_sealed_calls.agent_id). Resolved at
    -- reservation and used as the attribution for the revenue split: murmur
    -- keeps MURMUR_PROTOCOL_FEE_BPS of each sale and the rest accrues to this
    -- agent's owner in provider_earnings (migration 071). Nullable here
    -- because rows predate that resolution; accrual re-derives it from the
    -- sealed call when it is missing, and refuses to invent one.
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

  -- Load-bearing race protection. EIP-3009 nonces are unique per (payer,
  -- verifying contract), and source_domain captures the contract, so exactly
  -- one row per prefix is correct. A concurrent insert with the same prefix but
  -- different hashes — a second settle attempt on one authorization — fails
  -- with SQLITE_CONSTRAINT_UNIQUE; the handler re-reads and compares hashes to
  -- decide cached-replay vs 409.
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

// ─── Migration 061 — retire the native-price registry surface ───────────────
//
// See the v<61 block in applyMigrations. The four-way OR is deliberate: the
// marker columns arrived across migrations 008/016/029, so an old hand-seeded
// row may carry only some of them.
const MIGRATION_063_FEED_REVEAL_COLUMNS = `
  ALTER TABLE feed_packets ADD COLUMN reveal_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (reveal_status IN ('pending','revealed','invalid'));
  ALTER TABLE feed_packets ADD COLUMN revealed_action INTEGER
    CHECK (revealed_action IS NULL OR (revealed_action >= 0 AND revealed_action <= 255));
  ALTER TABLE feed_packets ADD COLUMN revealed_signal_bps INTEGER
    CHECK (revealed_signal_bps IS NULL OR (revealed_signal_bps >= 0 AND revealed_signal_bps <= 65535));
  ALTER TABLE feed_packets ADD COLUMN revealed_at TEXT;
  ALTER TABLE feed_packets ADD COLUMN terminal_at TEXT;
  ALTER TABLE feed_packets ADD COLUMN reveal_tx_hash TEXT;
  ALTER TABLE feed_packets ADD COLUMN reveal_log_index INTEGER;
  ALTER TABLE feed_packets ADD COLUMN reveal_block_number INTEGER;
  ALTER TABLE feed_packets ADD COLUMN reveal_sender TEXT;
  ALTER TABLE feed_packets ADD COLUMN reveal_source TEXT
    CHECK (reveal_source IS NULL OR reveal_source IN (
      'agent','daemon_fallback','unattributed_external'
    ));
  ALTER TABLE feed_packets ADD COLUMN invalid_reason TEXT
    CHECK (invalid_reason IS NULL OR invalid_reason = 'signal_bps');
  ALTER TABLE feed_packets ADD COLUMN agent_wallet_address TEXT;
  ALTER TABLE feed_packets ADD COLUMN submit_block_number INTEGER;

  -- Exact event identity: one terminal reveal event attaches at most once.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_packets_reveal_event
    ON feed_packets(chain_id, reveal_tx_hash, reveal_log_index)
    WHERE reveal_tx_hash IS NOT NULL;
  -- Candidate scan: pending packets past their reveal window, per deployment.
  CREATE INDEX IF NOT EXISTS idx_feed_packets_reveal_candidates
    ON feed_packets(chain_id, contract_address, reveal_status, reveal_after);
`;

const MIGRATION_063_FEED_REVEAL_JOBS = `
  CREATE TABLE IF NOT EXISTS fhenix_feed_packet_reveal_jobs (
    packet_id                TEXT PRIMARY KEY
                             REFERENCES feed_packets(packet_id) ON DELETE CASCADE,
    chain_id                 INTEGER NOT NULL,
    contract_address         TEXT NOT NULL,
    onchain_packet_id        TEXT NOT NULL,
    reveal_after             TEXT NOT NULL,
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
    action_value             INTEGER,
    action_signature         TEXT,
    signal_bps_value         INTEGER,
    signal_bps_signature     TEXT,
    attempt_count            INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at          TEXT NOT NULL,
    tx_broadcast_at          TEXT,
    last_error               TEXT,
    alert_level              TEXT CHECK (alert_level IS NULL OR alert_level IN ('warn','escalate')),
    first_eligible_at        TEXT NOT NULL,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feed_reveal_jobs_due
    ON fhenix_feed_packet_reveal_jobs(chain_id, contract_address, phase, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_feed_reveal_jobs_open_tx
    ON fhenix_feed_packet_reveal_jobs(chain_id, open_tx_hash)
    WHERE open_tx_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_feed_reveal_jobs_publish_tx
    ON fhenix_feed_packet_reveal_jobs(chain_id, publish_tx_hash)
    WHERE publish_tx_hash IS NOT NULL;
`;

const MIGRATION_062_DROP_UNREFERENCED_NATIVE_ROWS = `
  -- Markets: drop retired native rows that no submission references.
  DELETE FROM markets
   WHERE status = 'retired'
     AND (adapter_id = 'native-price' OR market_family = 'financial-direction')
     AND market_id NOT IN (SELECT DISTINCT market_id FROM submissions);

  -- Oracles: drop retired price-feed rows no surviving market points at.
  DELETE FROM oracles
   WHERE status = 'retired'
     AND kind IN ('chainlink_evm','pyth_pull','pyth_solana')
     AND oracle_id NOT IN (SELECT primary_oracle_id FROM markets)
     AND oracle_id NOT IN (
       SELECT fallback_oracle_id FROM markets WHERE fallback_oracle_id IS NOT NULL
     );

  -- Assets: drop native price assets nothing points at any more. Both
  -- referrers must be checked — markets.asset_id AND oracles.asset_id — or
  -- this deletes the synthetic 'polymarket:event' asset on a fresh database
  -- (where no external market exists yet) while the surviving
  -- 'polymarket-gamma-oracle' row still references it.
  DELETE FROM assets
   WHERE asset_id NOT IN (SELECT DISTINCT asset_id FROM markets)
     AND asset_id NOT IN (SELECT DISTINCT asset_id FROM oracles);
`;

const MIGRATION_061_RETIRE_NATIVE_PRICE_REGISTRY = `
  UPDATE markets
     SET status = 'retired'
   WHERE status <> 'retired'
     AND (
       market_kind   IN ('direction_binary','price_point','price_bracket','depeg_threshold')
       OR scoring_kind IN ('brier_direction','rank_proximity_l1','bracket_hit','threshold_hit')
       OR adapter_id     = 'native-price'
       OR market_family  = 'financial-direction'
     );

  UPDATE oracles
     SET status = 'retired'
   WHERE status <> 'retired'
     AND kind IN ('chainlink_evm','pyth_pull','pyth_solana');
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
// Hoists wallet_address + chain_id onto agents so a profile read needs no
// verified_identities join, widens the kind CHECK for wallet-owned agents
// (hence the rebuild), and indexes claim_challenges for GC and lookup.
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

const MIGRATION_064_MARKET_SERIES = `
  CREATE TABLE IF NOT EXISTS market_series (
    series_id               TEXT PRIMARY KEY,
    venue                   TEXT NOT NULL,
    display_name            TEXT NOT NULL,
    -- Prediction window length. For Polymarket up/down series this is parsed
    -- from the question text ("7:15PM-7:20PM ET"), because Gamma's startDate
    -- is market CREATION time, not the window start.
    window_seconds          INTEGER NOT NULL CHECK (window_seconds > 0),
    -- Series clock constants. Invariants enforced by assertSeriesClockConfig:
    -- all > 0, and submission_open_lead_sec > delivery_budget_sec strictly,
    -- or the sellable submission window is zero-length or inverted.
    submission_open_lead_sec INTEGER NOT NULL CHECK (submission_open_lead_sec > 0),
    commit_margin_sec        INTEGER NOT NULL CHECK (commit_margin_sec > 0),
    delivery_budget_sec      INTEGER NOT NULL CHECK (delivery_budget_sec > 0),
    embargo_sec              INTEGER NOT NULL CHECK (embargo_sec > 0),
    -- Cohort ceiling: an operational sales limit, NOT a gas bound. Each grant
    -- is its own transaction, so size it from grantor funding and from how
    -- many grants can confirm inside the delivery budget.
    max_armed_per_call       INTEGER NOT NULL CHECK (max_armed_per_call > 0),
    status                   TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','paused','delisted')),
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    CHECK (submission_open_lead_sec > delivery_budget_sec)
  );

  -- Per-instance clock SNAPSHOT. Written once at registration, immutable
  -- thereafter. Never re-derive on read: the venue can move its own end time,
  -- and retiming a market that consumers have armed and providers have
  -- submitted against would change the deal underneath them. Drift is
  -- detected against this snapshot and handled by delist+refund, never by
  -- silent rebinding.
  CREATE TABLE IF NOT EXISTS market_clocks (
    market_id            TEXT PRIMARY KEY REFERENCES markets(market_id) ON DELETE CASCADE,
    series_id            TEXT NOT NULL REFERENCES market_series(series_id),
    arm_close_at_ms         INTEGER NOT NULL,
    submission_open_at_ms   INTEGER NOT NULL,
    early_access_cutoff_at_ms INTEGER NOT NULL,
    submission_close_at_ms  INTEGER NOT NULL,
    -- The venue's own end time: when the OUTCOME is determined.
    resolution_at_ms        INTEGER NOT NULL,
    -- When murmur unseals. Strictly later than resolution_at_ms by the
    -- series embargo. Kept separate so the resolution horizon is never
    -- confused with the reveal deadline.
    public_reveal_at_ms     INTEGER NOT NULL,
    -- Drift bookkeeping: the endDate this snapshot was derived from, so a
    -- later venue change is detectable without re-deriving the schedule.
    derived_from_end_date_ms INTEGER NOT NULL,
    drift_detected_at       TEXT,
    created_at              TEXT NOT NULL,
    CHECK (arm_close_at_ms < submission_open_at_ms),
    CHECK (submission_open_at_ms < early_access_cutoff_at_ms),
    CHECK (early_access_cutoff_at_ms < submission_close_at_ms),
    CHECK (submission_close_at_ms < resolution_at_ms),
    CHECK (resolution_at_ms < public_reveal_at_ms)
  );

  CREATE INDEX IF NOT EXISTS idx_market_clocks_series
    ON market_clocks(series_id, submission_close_at_ms);
  -- Due-work scans: which instances are open for arming / submission now.
  CREATE INDEX IF NOT EXISTS idx_market_clocks_arm_close
    ON market_clocks(arm_close_at_ms);
`;

// The venue's DURABLE identity, promoted out of markets.config_json. A market
// instance is ephemeral (a new one every 5 minutes); the recurring series it
// belongs to is what a registration or a price can safely key to.
//
// Identity is (venue, series_slug). adapter_id / asset_id / market_family are
// single-valued across this whole surface and carry no identity, so they are
// deliberately NOT part of the key. venue_series_id is the Polymarket-form
// 'polymarket:<series_slug>' and the value every later FK stores.
//
// DISTINCT from market_series (064), which is the CLOCK series (schedule
// constants). Same word, unrelated concept.
const MIGRATION_075_VENUE_MARKET_SERIES = `
  CREATE TABLE IF NOT EXISTS venue_market_series (
    venue_series_id   TEXT PRIMARY KEY,
    venue             TEXT NOT NULL,
    series_slug       TEXT NOT NULL,
    series_title      TEXT NOT NULL,
    -- Venue-declared category. NULL is expected, not missing data: the 5m
    -- crypto series carries no event tag, so there is nothing honest to store.
    venue_category    TEXT,
    source_adapter_id TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (venue, series_slug)
  );

  -- Row presence == this agent is registered to serve this series. Backfilled
  -- from submission history; written going forward by the registration repo.
  -- WITHOUT ROWID: the composite key IS the row, with no other payload worth a
  -- rowid indirection.
  --
  -- CASCADE from agents (deleting an agent removes its registrations). RESTRICT
  -- from the series (a series with live registrations cannot be deleted out
  -- from under them).
  CREATE TABLE IF NOT EXISTS agent_market_registrations (
    agent_id        TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    venue_series_id TEXT NOT NULL
                      REFERENCES venue_market_series(venue_series_id) ON DELETE RESTRICT,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (agent_id, venue_series_id)
  ) WITHOUT ROWID;
`;

// Rekey agent_provider_terms from (agent_id) to (agent_id, venue_series_id).
// Only ever run against an asserted-empty table, so this is a drop + create,
// not a row-preserving rebuild. The composite FK makes a registration a
// precondition for terms and cascades the terms away when a registration is
// dropped. No agent-wide default survives — a price now belongs to one series.
// The price/version/cohort CHECK idioms are carried verbatim from 069.
const MIGRATION_075_AGENT_PROVIDER_TERMS_REKEY = `
  DROP TABLE agent_provider_terms;
  CREATE TABLE agent_provider_terms (
    agent_id              TEXT NOT NULL,
    venue_series_id       TEXT NOT NULL,
    -- Access price in the settlement asset's atomic units. Positive.
    price_atoms           TEXT NOT NULL CHECK (
                            price_atoms GLOB '[0-9]*' AND CAST(price_atoms AS INTEGER) > 0
                          ),
    currency              TEXT NOT NULL,
    -- Identifies the commercial terms a subscriber agreed to. Never empty.
    pricing_version       TEXT NOT NULL CHECK (length(pricing_version) > 0),
    -- Owner's chosen ceiling, or NULL for "as many as murmur can serve".
    max_subscribers_per_call INTEGER CHECK (
                            max_subscribers_per_call IS NULL
                            OR max_subscribers_per_call > 0
                          ),
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    PRIMARY KEY (agent_id, venue_series_id),
    FOREIGN KEY (agent_id, venue_series_id)
      REFERENCES agent_market_registrations(agent_id, venue_series_id)
      ON DELETE CASCADE
  ) WITHOUT ROWID;
`;


// ─── 080 — delivery acceptance, and the withdrawal outbox ───────────────────
//
// Two tables, one per half of "a provider can be paid".
//
// `entitlement_delivery` answers WHETHER a sale may be released. A buyer pays
// for early private access; the money is only releasable to the provider once
// the buyer has what they paid for. That is a fact about DELIVERY, never about
// whether the prediction was right — a losing call is delivered exactly as
// completely as a winning one, and nothing in this table can express the
// difference. The dispute grounds are a closed list for the same reason.
//
// `provider_withdrawals` is the outbox that moves the money. It exists because
// an ERC-20 transfer has no idempotency of its own: the only thing standing
// between a crash and a double-send is a row written BEFORE the broadcast that
// names the exact nonce and the exact signed bytes. Every state here is a
// claim about what may have already reached the chain.
const MIGRATION_080_DELIVERY_AND_WITHDRAWALS = `
  -- One row per sale that carries a delivery policy. The entitlement IS the
  -- identity, exactly as in provider_earnings: a sale cannot be accepted twice.
  CREATE TABLE IF NOT EXISTS entitlement_delivery (
    -- CASCADE, not RESTRICT: a reservation that never settled is deleted by
    -- releaseReservation, and a delivery record for a sale that never happened
    -- is meaningless. The money record (provider_earnings) is what must not be
    -- deletable, and it holds its own reference — an entitlement that ever
    -- accrued cannot be released in the first place.
    entitlement_id      INTEGER PRIMARY KEY REFERENCES entitlements(id) ON DELETE CASCADE,
    -- pending         paid and granted; nobody has spoken yet
    -- buyer_accepted  the buyer signed an acceptance
    -- auto_accepted   a finalized VALID reveal made the call independently
    --                 checkable and the buyer never objected
    -- disputed        the buyer raised one of the closed grounds in time
    -- rejected        adjudicated against the sale; gross refund is owed
    state               TEXT NOT NULL CHECK (state IN (
                          'pending',
                          'buyer_accepted',
                          'auto_accepted',
                          'disputed',
                          'rejected'
                        )),
    -- Frozen at purchase from the call's publicRevealAt. A deadline that could
    -- move is not a deadline: re-reading the market later would let a
    -- rescheduled horizon extend or collapse a window the buyer already paid
    -- against.
    accept_deadline_at  TEXT NOT NULL,
    -- accept_deadline_at + the disclosed grace. Adjudication ends here.
    dispute_longstop_at TEXT NOT NULL CHECK (dispute_longstop_at >= accept_deadline_at),
    -- The buyer's signed attestation. Records that they said it, not proof
    -- that decryption succeeded — plaintext never leaves their browser.
    accepted_at         TEXT,
    acceptance_signature TEXT,
    -- The exact digest that was signed, so a stored signature stays checkable.
    acceptance_digest   TEXT,
    -- Objective grounds only. "The prediction lost" is deliberately absent and
    -- must stay absent: it is not a delivery defect.
    dispute_ground      TEXT CHECK (dispute_ground IS NULL OR dispute_ground IN (
                          'decrypt_unavailable',
                          'malformed_prediction',
                          'market_mismatch',
                          'late_delivery'
                        )),
    dispute_evidence    TEXT,
    disputed_at         TEXT,
    -- Who ended it: the buyer, the deadline rule, or an operator adjudicating
    -- a dispute. Never inferred from the state alone.
    decided_by          TEXT CHECK (decided_by IS NULL OR decided_by IN ('buyer','auto','operator')),
    decided_at          TEXT,
    decision_note       TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    -- A settled delivery names its decider, and an unsettled one cannot.
    CHECK (
      (state IN ('pending','disputed') AND decided_by IS NULL AND decided_at IS NULL)
      OR (state IN ('buyer_accepted','auto_accepted','rejected')
          AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    ),
    -- A dispute names its ground.
    CHECK (state <> 'disputed' OR dispute_ground IS NOT NULL)
  );

  -- The deadline sweep reads pending rows by deadline; the release calculation
  -- reads settled rows by state.
  CREATE INDEX IF NOT EXISTS idx_entitlement_delivery_due
    ON entitlement_delivery(state, accept_deadline_at);

  -- The withdrawal outbox. One row is one intent to move money, and it is
  -- written before anything is signed.
  CREATE TABLE IF NOT EXISTS provider_withdrawals (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    producer_agent_id   TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
    -- The caller's own key for this request. Two requests carrying the same one
    -- are the SAME withdrawal, however many times a flaky client retries.
    client_request_id   TEXT NOT NULL CHECK (length(client_request_id) > 0),
    chain_id            INTEGER NOT NULL,
    token_address       TEXT NOT NULL,
    currency            TEXT NOT NULL,
    amount_atoms        TEXT NOT NULL CHECK (
                          amount_atoms GLOB '[1-9]*'
                          AND amount_atoms NOT GLOB '*[^0-9]*'
                        ),
    -- Snapshots, not lookups. Where it went is decided when the reservation is
    -- taken, so a destination edited mid-flight cannot redirect a signed
    -- transfer, and the journal can say where the money actually went.
    destination_address TEXT NOT NULL,
    sender_address      TEXT NOT NULL,
    -- reserved     funds held, nothing signed — the only state that is
    --              certainly not on chain
    -- signed       bytes exist, so it MAY have been broadcast already
    -- submitted    broadcast returned a hash
    -- paid         a finalized receipt AND a matching transfer event
    -- failed       finalized revert; the reservation is released
    -- needs_review the chain could not be read conclusively; the reservation
    --              is HELD, because releasing it would let the same earnings
    --              fund a second transfer
    state               TEXT NOT NULL CHECK (state IN (
                          'reserved','signed','submitted','paid','failed','needs_review'
                        )),
    -- Allocated once, owned for the life of the row. A replacement fee must
    -- reuse it, or the original can still confirm alongside its replacement.
    nonce               INTEGER CHECK (nonce IS NULL OR nonce >= 0),
    -- The exact bytes. Rebroadcast sends these again; it never re-signs.
    signed_raw_tx       TEXT,
    tx_hash             TEXT,
    attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error          TEXT,
    next_attempt_at     TEXT,
    -- The journal row this became, written in the same transaction as 'paid'.
    payout_id           INTEGER REFERENCES provider_payouts(id),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE (producer_agent_id, chain_id, token_address, client_request_id),
    -- Anything that CLAIMS to have reached the chain carries the bytes that
    -- went and the nonce they went under. 'failed' and 'needs_review' are
    -- deliberately exempt: both are reachable before signing (a bad
    -- destination, an operator hold), and forcing bytes onto them would mean
    -- inventing a transaction to record that none was ever made.
    CHECK (
      state NOT IN ('signed','submitted','paid')
      OR (signed_raw_tx IS NOT NULL AND nonce IS NOT NULL)
    ),
    -- Paid means journalled. The two cannot come apart.
    CHECK (state <> 'paid' OR (payout_id IS NOT NULL AND tx_hash IS NOT NULL))
  );

  -- The worker's due-work scan, and the reservation sum. Both are by agent.
  CREATE INDEX IF NOT EXISTS idx_provider_withdrawals_open
    ON provider_withdrawals(producer_agent_id, state);
  CREATE INDEX IF NOT EXISTS idx_provider_withdrawals_due
    ON provider_withdrawals(state, next_attempt_at);
  -- One nonce, one transfer. A second row claiming a live nonce on the same
  -- sender is the double-send this whole table exists to prevent.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_withdrawals_nonce
    ON provider_withdrawals(chain_id, sender_address, nonce)
    WHERE nonce IS NOT NULL;
`;

// ─── Migration 081 — retire the referral feature ────────────────────────────
//
// Rebuild copied from MIGRATION_060_SECURITY_EVENT_KINDS (same indexes and
// triggers) with 'admin_ref_delete' removed from the closed CHECK, so its rows
// are left behind by the copy. ref_clicks is dropped in the same transaction:
// nothing reads it once /v1/refs and the recruiters board are gone.
const MIGRATION_081_RETIRE_REFERRALS = `
  DROP TRIGGER IF EXISTS trg_agent_security_events_no_update;
  DROP TRIGGER IF EXISTS trg_agent_security_events_no_delete;

  DROP TABLE IF EXISTS agent_security_events_v081;
  CREATE TABLE agent_security_events_v081 (
    event_id     TEXT PRIMARY KEY,
    agent_id     TEXT,
    account_id   TEXT,
    kind         TEXT NOT NULL CHECK (kind IN (
      'admin_claim',
      'admin_polymarket_upsert',
      'admin_market_status_change',
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

  INSERT INTO agent_security_events_v081 (
    event_id, agent_id, account_id, kind, actor, payload_json, created_at
  )
  SELECT
    event_id, agent_id, account_id, kind, actor, payload_json, created_at
  FROM agent_security_events
  WHERE kind <> 'admin_ref_delete';

  DROP TABLE agent_security_events;
  ALTER TABLE agent_security_events_v081 RENAME TO agent_security_events;

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

  DROP TABLE IF EXISTS ref_clicks;
`;

// ─── Re-export ground type for migration knowledge ───────────────────────────

export const VERDICT_DB_SCHEMA_VERSION = 1 as const;
