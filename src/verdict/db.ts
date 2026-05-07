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
}

export const submissionsRepo = {
  /** Inserts submission + preflight + oracle policy + acceptance receipt atomically. */
  acceptCall(db: Database.Database, input: AcceptanceWriteInput): void {
    const tx = db.transaction((i: AcceptanceWriteInput) => {
      prep(
        db,
        `INSERT INTO submissions
         (call_id, agent_id, client_order_id, asset_id, side, horizon_hours,
          confidence, submitted_at, accepted_at, status, rationale, strategy_tag,
          schema_version, scoring_version, dedup_key)
         VALUES (@call_id, @agent_id, @client_order_id, @asset_id, @side, @horizon_hours,
          @confidence, @submitted_at, @accepted_at, @status, @rationale, @strategy_tag,
          @schema_version, @scoring_version, @dedup_key)`,
      ).run({
        call_id: i.accepted.call_id,
        agent_id: i.accepted.agent_id,
        client_order_id: i.accepted.client_order_id,
        asset_id: i.accepted.asset_id,
        side: i.accepted.side,
        horizon_hours: i.accepted.horizon_hours,
        confidence: i.accepted.confidence,
        submitted_at: i.accepted.submitted_at,
        accepted_at: i.accepted.accepted_at,
        status: "accepted" satisfies CallStatus,
        rationale: i.accepted.rationale ?? null,
        strategy_tag: i.accepted.strategy_tag ?? null,
        schema_version: i.accepted.schema_version,
        scoring_version: i.accepted.scoring_version,
        dedup_key: i.dedup_key,
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
      ).run({ call_id: i.accepted.call_id, ...i.accepted.oracle_policy });
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

  countCallsForAgentAssetWindow(
    db: Database.Database,
    agent_id: string,
    asset_id: string,
    sinceIso: string,
  ): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM submissions
       WHERE agent_id = ? AND asset_id = ? AND submitted_at >= ?`,
    ).get(agent_id, asset_id, sinceIso) as { n: number } | undefined;
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
    confidence: number;
    accepted_at: string;
    status: CallStatus;
    acceptance_receipt_hash: string;
    primary_feed: string;
    fallback_feed: string;
    primary_max_staleness_sec: number;
    fallback_max_staleness_sec: number;
    t0_grace_seconds: number;
    t0_extended_grace_seconds: number;
  } | null {
    return (
      (prep(
        db,
        `SELECT s.call_id, s.agent_id, s.asset_id, s.side, s.horizon_hours,
                s.confidence, s.accepted_at, s.status,
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
            confidence: number;
            accepted_at: string;
            status: CallStatus;
            acceptance_receipt_hash: string;
            primary_feed: string;
            fallback_feed: string;
            primary_max_staleness_sec: number;
            fallback_max_staleness_sec: number;
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
}

export const callPrivateEnvelopesRepo = {
  insert(db: Database.Database, row: CallPrivateEnvelopeRow): void {
    prep(
      db,
      `INSERT INTO call_private_envelopes
       (call_id, encrypted_body, encrypted_body_alg, encrypted_body_hash,
        daemon_key_id, commit_preimage_schema, fallback_after, received_at)
       VALUES (@call_id, @encrypted_body, @encrypted_body_alg, @encrypted_body_hash,
               @daemon_key_id, @commit_preimage_schema, @fallback_after, @received_at)`,
    ).run(row);
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
  revealed_via: "agent" | "daemon_fallback" | "legacy_plaintext" | "fhevm_compute";
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
   * Reveal-reliability counts per agent: (agent_reveals, daemon_reveals).
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
              SUM(CASE WHEN cr.revealed_via = 'daemon_fallback' THEN 1 ELSE 0 END) AS daemon_reveals
       FROM submissions s
       JOIN call_reveals cr ON cr.call_id = s.call_id
       WHERE s.privacy_mode = 'committed'
         AND cr.revealed_via IN ('agent', 'daemon_fallback')
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
